import { x } from "tinyexec";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import typia from "typia";
import type { TegamiContext } from "../context";
import type { ChangelogEntry } from "../changelog/parse";
import type { Draft } from "../plans/draft";
import { parsePublishLock, PublishLock } from "../plans/lock";
import { initPublishPlan, runPreflights, type PublishPlan } from "../plans/publish";
import type { Awaitable, TegamiPlugin } from "../types";
import { PackageGraph, WorkspacePackage } from "../graph";
import { execFailure } from "./error";
import { isCI } from "./common";

/** a version request (pull/merge request) to upsert on the git provider */
interface VersionRequest {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface VersionRequestOptions {
  /**
   * Create the pull/merge request even outside of CI.
   *
   * @default false
   */
  forceCreate?: boolean;
  /**
   * Pull/merge request branch. Publish group PRs are created under `<branch>/`.
   *
   * @default "tegami/version-packages"
   */
  branch?: string;
  /**
   * Pull/merge request base branch.
   *
   * @default "main"
   */
  base?: string;

  /** Publish groups to split into separate version requests. */
  groups?: (string | string[])[];
  /** Override details of a version request at version-time. */
  create?: (
    this: TegamiContext,
    opts: VersionRequestContext,
  ) => Awaitable<{ title?: string; body?: string }>;

  /** Override commit summary & message. */
  commit?: (
    this: TegamiContext,
    opts:
      | { type: "version-packages" }
      | { type: "update-lock"; store: PublishGroupStore; updatedLock: PublishLock },
  ) => Awaitable<{ title?: string; body?: string } | undefined>;
}

interface VersionRequestContext {
  draft: Draft;
  /** predicted publish plan (after preflight) */
  plan: PublishPlan | undefined;
  getPreviousVersion(packageId: string): string | undefined;
}

/** adapter over the version request API of a git provider */
interface GitProvider {
  /** provider name, used as the namespace prefix in publish lock (e.g. `github`) */
  name: string;
  options: VersionRequestOptions | false | undefined;
  /**
   * Whether version requests can be created & managed (e.g. repo & token configured).
   */
  canCreate: (context: TegamiContext) => boolean;
  /** create the version request of a branch, `update` controls whether an open one is updated */
  upsert: (context: TegamiContext, request: VersionRequest, update: boolean) => Awaitable<void>;
}

interface PublishGroupStore {
  /**
   * - active: groups whose version request was merged, they stay listed until the lock is removed
   * - pending: groups still waiting for their version request to be merged
   */
  groups: Record<string, "pending" | "active">;
}

interface CommitData {
  commit: string;
  date: string;
}

const validatePublishGroupStore: (input: unknown) => typia.IValidation<PublishGroupStore> =
  typia.createValidate<PublishGroupStore>();

export function onVersionRequest(provider: GitProvider) {
  const namespace = `${provider.name}:publish-group`;
  /** package id -> version before applying the CLI draft */
  const snapshots = new Map<string, string | undefined>();

  function resolveConfig(graph: PackageGraph) {
    if (provider.options === false) return;
    const {
      forceCreate = false,
      branch = "tegami/version-packages",
      base = "main",
      groups,
      ...rest
    } = provider.options ?? {};
    const groupMap = new Map<string, string[]>();

    if (groups?.length) {
      const unlistedPackages = new Set<string>();
      for (const pkg of graph.getPackages()) unlistedPackages.add(pkg.id);

      for (let group of groups ?? []) {
        if (!Array.isArray(group)) group = [group];
        let id = publishGroupId(group);
        if (id === "unlisted") id = "custom-unlisted";
        groupMap.set(id, group);
        for (const member of group) {
          for (const pkg of graph.getByName(member)) unlistedPackages.delete(pkg.id);
        }
      }
      if (unlistedPackages.size > 0) {
        groupMap.set("unlisted", Array.from(unlistedPackages));
      }
    }

    return { forceCreate, branch, base, groupMap, ...rest };
  }

  /**
   * Commit the group's lock state on top of `parent` and force-push its branch.
   *
   * Returns `true` and skips the push when the branch on `remote` already matches.
   */
  async function syncGroupBranch(
    context: TegamiContext,
    opts: {
      config: NonNullable<ReturnType<typeof resolveConfig>>;
      baseLock: PublishLock;
      branch: string;
      store: PublishGroupStore;
      parent: CommitData;
      /** known remote branches, always pushes when omitted */
      remote?: Map<string, string>;
    },
  ): Promise<boolean> {
    const lock = new PublishLock(opts.baseLock);
    while (lock.read(namespace)) {}
    lock.write(namespace, opts.store);

    const commit = await createLockCommit(
      context,
      opts.parent,
      lock.serialize(),
      await opts.config.commit?.call(context, {
        type: "update-lock",
        store: opts.store,
        updatedLock: lock,
      }),
    );
    if (opts.remote && opts.remote.get(opts.branch) === commit) return true;

    await run(
      context.cwd,
      ["push", "--force", "origin", `${commit}:refs/heads/${opts.branch}`],
      "Failed to push the version branch to origin. Ensure `origin` is configured and you have push access.",
    );
    return false;
  }

  return {
    /** snapshot package versions, hook into `initCliDraft` */
    initCliDraft(): void {
      for (const pkg of this.graph.getPackages()) {
        snapshots.set(pkg.id, pkg.version);
      }
    },

    /** commit & push version branches, then upsert their requests, hook into `applyCliDraft` */
    async applyCliDraft(this, draft): Promise<void> {
      const config = resolveConfig(this.graph);
      if (!config || !provider.canCreate(this)) return;
      if (!(config.forceCreate || isCI()) || !(await hasGitChanges(this.cwd))) return;

      const requests: { branch: string; packages: WorkspacePackage[]; publishGroup?: string }[] =
        [];
      const updatedPackages = new Map<string, WorkspacePackage>();

      for (const id of draft.getPackageDrafts().keys()) {
        const snapshot = snapshots.get(id);
        const pkg = this.graph.get(id);
        if (pkg?.version && snapshot && pkg.version !== snapshot) {
          updatedPackages.set(id, pkg);
        }
      }

      for (const [id, members] of config.groupMap) {
        const packages: WorkspacePackage[] = [];

        for (const member of members) {
          for (const pkg of this.graph.getByName(member)) {
            if (!updatedPackages.delete(pkg.id)) continue;
            packages.push(pkg);
          }
        }

        if (packages.length === 0) continue;
        requests.push({
          branch: `${config.branch}/${id}`,
          packages,
          publishGroup: id,
        });
      }

      // if no publish groups
      if (updatedPackages.size > 0) {
        requests.push({
          branch: config.branch,
          packages: Array.from(updatedPackages.values()),
        });
      }

      if (requests.length === 0) return;

      await createVersionCommit(
        this.cwd,
        await config.commit?.call(this, { type: "version-packages" }),
      );

      let baseLock: PublishLock | undefined;
      let parent: CommitData | undefined;
      const tasks: Awaitable<void>[] = [];

      for (const { branch, packages, publishGroup } of requests) {
        const plan = await initPublishPlan(this, {
          packages: publishGroup ? packages.map((pkg) => pkg.id) : undefined,
        });
        if (plan) await runPreflights(this, plan);

        const ctx: VersionRequestContext = {
          draft,
          plan,
          getPreviousVersion: (id) => snapshots.get(id),
        };
        const custom = await config.create?.call(this, ctx);
        const resolved: VersionRequest = {
          title:
            custom?.title ??
            (publishGroup
              ? `Release ${packages.map((pkg) => `${pkg.name} (${pkg.manager})`).join(", ")}`
              : "Version Packages"),
          body: custom?.body ?? renderRequestBody(this, ctx),
          head: branch,
          base: config.base,
        };

        if (publishGroup) {
          parent ??= await resolveHead(this.cwd);
          baseLock ??= parsePublishLock(await readFile(this.lockPath, "utf8"));
          const newGroups: Record<string, "pending" | "active"> = {};
          for (const req of requests) {
            if (!req.publishGroup) continue;
            newGroups[req.publishGroup] = req.publishGroup !== publishGroup ? "pending" : "active";
          }

          const inSync = await syncGroupBranch(this, {
            baseLock,
            config,
            branch,
            parent,
            store: {
              groups: newGroups,
            },
          });
          tasks.push(provider.upsert(this, resolved, !inSync));
          continue;
        }

        await pushBranch(this.cwd, branch);
        await provider.upsert(this, resolved, true);
      }
      await Promise.all(tasks);
    },

    /** restore publish groups from the lock into the plan, hook into `initPublishPlan` */
    initPublishPlan(this, { lock, plan }): void {
      const config = resolveConfig(this.graph);
      if (!config) return;

      let data: unknown;

      const publishGroups = new Map<string, "active" | "pending">();
      plan.$versionRequest = { publishGroups };
      while ((data = lock.read(namespace))) {
        const validated = validatePublishGroupStore(data);
        if (!validated.success) continue;
        const store = validated.data;

        for (const [id, state] of Object.entries(store.groups)) {
          if (!config.groupMap.has(id) || publishGroups.get(id) === "active") continue;
          publishGroups.set(id, state);
        }
      }

      // empty = no publish group
      if (publishGroups.size === 0) return;

      const packages: string[] = [];
      if (plan.options.packages) packages.push(...plan.options.packages);
      for (const [id, state] of publishGroups) {
        if (state === "pending") continue;
        for (const pkg of config.groupMap.get(id)!) packages.push(pkg);
      }
      plan.options = { ...plan.options, packages };
    },

    /** report `pending` while publish groups are waiting for their request */
    resolvePlanStatus({ plan }): "pending" | undefined {
      const publishGroups = plan.$versionRequest?.publishGroups;
      if (!publishGroups) return;
      for (const s of publishGroups.values()) {
        if (s === "pending") return "pending";
      }
    },

    /** re-sync the version requests of pending publish groups, hook into `beforePublishAll` */
    async beforePublishAll(this, { plan }) {
      if (plan.options.dryRun || !provider.canCreate(this)) return;
      const config = resolveConfig(this.graph);
      if (!config) return;

      const publishGroups = plan.$versionRequest?.publishGroups;
      if (!publishGroups || publishGroups.size === 0) return;

      const pending: string[] = [];
      for (const [id, state] of publishGroups) {
        if (state === "pending") pending.push(id);
      }
      if (pending.length === 0) return;

      const parent = await resolveHead(this.cwd);
      const baseLock = parsePublishLock(await readFile(this.lockPath, "utf8"));
      const remote = await resolveRemoteBranches(
        this.cwd,
        pending.map((id) => `${config.branch}/${id}`),
      );

      for (const id of pending) {
        const newGroups = Object.fromEntries(publishGroups.entries());
        newGroups[id] = "active";

        await syncGroupBranch(this, {
          branch: `${config.branch}/${id}`,
          baseLock,
          parent,
          remote,
          config,
          store: {
            groups: newGroups,
          },
        });
      }
    },
  } satisfies Partial<TegamiPlugin>;
}

function renderRequestBody(
  ctx: TegamiContext,
  { draft, getPreviousVersion, plan }: VersionRequestContext,
): string {
  const packageLines: string[] = [];
  const changelogLines: string[] = [];
  const publishLines: string[] = [];
  const changesets = new Map<ChangelogEntry, WorkspacePackage[]>();

  for (const [id, packageDraft] of draft.getPackageDrafts()) {
    const pkg = ctx.graph.get(id);
    if (!pkg) continue;

    for (const changelog of packageDraft.changelogs ?? []) {
      const list = changesets.get(changelog);
      if (list) list.push(pkg);
      else changesets.set(changelog, [pkg]);
    }

    const from = getPreviousVersion(id);
    if (!from || from === pkg.version) continue;
    packageLines.push(`| \`${pkg.name}\` | \`${from}\` | \`${pkg.version}\` |`);
  }

  for (const [entry, linkedPackages] of changesets) {
    changelogLines.push(`### ${entry.subject ?? `\`${entry.filename}\``}`, "");

    changelogLines.push(
      "<details>",
      `<summary>Show Bumped Packages (${linkedPackages.length})</summary>`,
      "",
      ...linkedPackages.map((pkg) => `- \`${pkg.id}\``),
      "",
      "</details>",
      "",
    );

    for (const section of entry.sections) {
      changelogLines.push(`#### ${section.title}`, "");
      if (section.content) changelogLines.push(section.content);
    }
  }

  if (plan)
    for (const [id, { preflight, npm }] of plan.packages) {
      if (!preflight!.shouldPublish) continue;
      const pkg = ctx.graph.get(id)!;
      let pm = "";
      if (npm?.distTag) pm += ` (dist-tag: ${npm.distTag})`;
      publishLines.push(`| \`${pkg.name}\` | \`${pkg.version}\`${pm} | \`${pkg.manager}\` |`);
    }

  const sections = ["## Summary", "", "All bumped packages.", ""];

  if (packageLines.length > 0) {
    sections.push("| Package | From | To |", "| --- | --- | --- |", ...packageLines);
  }

  if (changelogLines.length > 0) {
    sections.push("", "## Changelogs", ...changelogLines);
  }

  if (publishLines.length > 0) {
    sections.push(
      "",
      "## Publish",
      "",
      "The following packages will be published if merged:",
      "",
      "| Package | Version | Registry |",
      "| --- | --- | --- |",
      ...publishLines,
    );
  }

  sections.push("");

  return sections.join("\n");
}

/**
 * Commit a lock file change on top of `parent` via a detached index, without touching the
 * working tree. Commit dates are pinned to the parent, so unchanged content always produces
 * the exact same commit.
 */
async function createLockCommit(
  context: TegamiContext,
  parent: CommitData,
  content: string,
  commit: { title?: string; body?: string } = {},
): Promise<string> {
  const { cwd } = context;
  const dir = await mkdtemp(join(tmpdir(), "tegami-"));

  try {
    const blobFile = join(dir, "lock");
    await writeFile(blobFile, content);
    const blob = await run(
      cwd,
      ["hash-object", "-w", blobFile],
      "Failed to store the lock file update.",
    );

    const path = relative(cwd, context.lockPath).replaceAll("\\", "/");
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
    await run(cwd, ["read-tree", parent.commit], "Failed to read the current git tree.", env);
    await run(
      cwd,
      ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`],
      "Failed to update the lock file entry.",
      env,
    );
    const tree = await run(cwd, ["write-tree"], "Failed to write the updated git tree.", env);

    const args = [
      "commit-tree",
      tree,
      "-p",
      parent.commit,
      "-m",
      commit.title ?? "Update lock file",
    ];
    if (commit.body) args.push("-m", commit.body);
    return await run(cwd, args, "Failed to commit the lock file update.", {
      ...env,
      GIT_AUTHOR_DATE: parent.date,
      GIT_COMMITTER_DATE: parent.date,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** the checked out commit and its committer date */
async function resolveHead(cwd: string): Promise<CommitData> {
  const out = await run(
    cwd,
    ["show", "-s", "--format=%H%n%cI"],
    "Failed to resolve the current commit.",
  );
  const [commit = "", date = ""] = out.split("\n");

  return { commit, date };
}

/** branch -> commit on origin, `undefined` when the remote cannot be queried */
async function resolveRemoteBranches(
  cwd: string,
  branches: string[],
): Promise<Map<string, string> | undefined> {
  const result = await x(
    "git",
    ["ls-remote", "origin", ...branches.map((branch) => `refs/heads/${branch}`)],
    { nodeOptions: { cwd } },
  );
  if (result.exitCode !== 0) return;

  const out = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const [commit, name] = line.split("\t");
    const ref = name?.trim();
    if (commit && ref?.startsWith("refs/heads/"))
      out.set(ref.slice("refs/heads/".length), commit.trim());
  }

  return out;
}

async function hasGitChanges(cwd: string): Promise<boolean> {
  const out = await run(cwd, ["status", "--porcelain"], "Failed to check git status.");
  return out.length > 0;
}

/** commit the working tree changes onto a detached HEAD */
async function createVersionCommit(
  cwd: string,
  { title = "Version Packages", body }: { title?: string; body?: string } = {},
): Promise<void> {
  await run(cwd, ["checkout", "--detach"], "Failed to detach HEAD for version branches.");
  await run(cwd, ["add", "-A"], "Failed to stage version changes.");
  const args = ["commit", "-m", title];
  if (body) args.push("-m", body);
  await run(cwd, args, "Failed to commit version changes.");
}

async function pushBranch(cwd: string, branch: string): Promise<void> {
  await run(cwd, ["checkout", "-B", branch], "Failed to create the version branch.");
  await run(
    cwd,
    ["push", "--force", "-u", "origin", branch],
    "Failed to push the version branch to origin. Ensure `origin` is configured and you have push access.",
  );
}

async function run(
  cwd: string,
  args: string[],
  message: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await x("git", args, { nodeOptions: { cwd, env } });
  if (result.exitCode !== 0) {
    throw execFailure(message, result);
  }

  return result.stdout.trim();
}

function publishGroupId(members: string[]): string {
  const slugs: string[] = [];
  for (const name of members.toSorted()) {
    const v = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (v.length > 0) slugs.push(v);
  }
  if (slugs.length === 0) slugs.push("group");
  return slugs.join("-");
}
