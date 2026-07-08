import { x } from "tinyexec";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import typia from "typia";
import type { TegamiContext } from "../context";
import type { ChangelogEntry } from "../changelog/parse";
import type { Draft } from "../plans/draft";
import { parsePublishLock, PublishLock } from "../plans/lock";
import {
  initPublishPlan,
  PackagePublishPlan,
  runPreflights,
  type PublishPlan,
} from "../plans/publish";
import type { Awaitable, TegamiPlugin } from "../types";
import { PackageGraph, WorkspacePackage } from "../graph";
import { execFailure } from "./error";
import { isCI, somePromise } from "./common";
import { diffWeight, formatNpmDistTag, formatPackageVersion } from "./semver";
import { getPackageBumps } from "../changelog/shared";

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

export function versionRequestPlugin(provider: GitProvider): TegamiPlugin {
  const NamespacePublishGroup = `${provider.name}:publish-group`;
  /** package id -> version before applying the CLI draft */
  const snapshots = new Map<string, string | undefined>();
  type ResolvedConfig = NonNullable<ReturnType<typeof resolveConfig>>;

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

  /** commit the working tree changes onto a detached HEAD */
  async function createVersionCommit(ctx: TegamiContext, config: ResolvedConfig): Promise<void> {
    const { title = "Version Packages", body } =
      (await config.commit?.call(ctx, { type: "version-packages" })) ?? {};
    await run(ctx.cwd, ["checkout", "--detach"], "Failed to detach HEAD for version branches.");
    await run(ctx.cwd, ["add", "-A"], "Failed to stage version changes.");
    const args = ["commit", "-m", title];
    if (body) args.push("-m", body);
    await run(ctx.cwd, args, "Failed to commit version changes.");
  }

  /**
   * Commit the group's lock state on top of `parent` and force-push its branch.
   *
   * Returns `true` and skips the push when the branch on `remote` already matches.
   */
  async function syncGroupBranch(
    context: TegamiContext,
    opts: {
      config: ResolvedConfig;
      baseLock: PublishLock;
      branch: string;
      store: PublishGroupStore;
      parent: CommitData;
      /** known remote branches, always pushes when omitted */
      remote?: Map<string, string>;
    },
  ): Promise<boolean> {
    const lock = new PublishLock(opts.baseLock);
    while (lock.read(NamespacePublishGroup)) {}
    lock.write(NamespacePublishGroup, opts.store);

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
    name: `${provider.name}:version-request`,
    /** snapshot package versions */
    initCliDraft() {
      for (const pkg of this.graph.getPackages()) {
        snapshots.set(pkg.id, pkg.version);
      }
    },
    /** commit & push version branches, then upsert their requests */
    async applyCliDraft(draft) {
      if (!provider.canCreate(this)) return;
      const config = resolveConfig(this.graph);
      if (!config || !(config.forceCreate || isCI()) || !(await hasGitChanges(this.cwd))) return;

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
      await createVersionCommit(this, config);

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

        await run(this.cwd, ["checkout", "-B", branch], "Failed to create the version branch.");
        await run(
          this.cwd,
          ["push", "--force", "-u", "origin", branch],
          "Failed to push the version branch to origin. Ensure `origin` is configured and you have push access.",
        );
        await provider.upsert(this, resolved, true);
      }
      await Promise.all(tasks);
    },
    /** restore publish groups from the lock into the plan */
    initPublishPlan({ lock, plan }) {
      const config = resolveConfig(this.graph);
      if (!config) return;

      let data: unknown;

      const publishGroups = new Map<string, "active" | "pending">();
      plan.$versionRequest = { publishGroups };
      while ((data = lock.read(NamespacePublishGroup))) {
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
    resolvePlanStatus({ plan }) {
      const publishGroups = plan.$versionRequest?.publishGroups;
      if (!publishGroups) return;
      for (const s of publishGroups.values()) {
        if (s === "pending") return "pending";
      }
    },

    /** re-sync the version requests of pending publish groups */
    async beforePublishAll({ plan }) {
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
  };
}

function renderRequestBody(
  ctx: TegamiContext,
  { draft, getPreviousVersion, plan }: VersionRequestContext,
): string {
  const bumpedPackages: { name: string; from: string; to: string; diff: number }[] = [];
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
    if (!from || !pkg.version || from === pkg.version) continue;
    bumpedPackages.push({
      name: pkg.name,
      from,
      to: pkg.version,
      diff: diffWeight(from, pkg.version),
    });
  }

  const packageLines = bumpedPackages
    .sort((a, b) => b.diff - a.diff)
    .map(({ name, from, to }) => `| \`${name}\` | \`${from}\` | \`${to}\` |`);

  for (const [entry, linkedPackages] of changesets) {
    const bumps = getPackageBumps(ctx.graph, entry);

    changelogLines.push(
      `### ${entry.subject ?? `\`${entry.filename}\``}`,
      "",
      "<details>",
      `<summary>Show Bumped Packages (${linkedPackages.length})</summary>`,
      "",
      "| Package | Bump |",
      "| --- | --- |",
    );
    for (const pkg of linkedPackages) {
      changelogLines.push(`| \`${pkg.id}\` | ${bumps.get(pkg) ?? ""} |`);
    }
    changelogLines.push("", "</details>", "");

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

export function formatPreview(
  { graph, npm }: TegamiContext,
  draft: Draft,
  newChangelogNames: Set<string>,
  labels: Record<"create-a-changelog-href" | "pr", string>,
): string {
  const pendingPackages: {
    name: string;
    type: string;
    from: string;
    to: string;
    distTag?: string;
  }[] = [];
  const lines = [
    "### Tegami",
    "",
    `This repository uses [Tegami](https://tegami.fuma-nama.dev) to manage releases. When your changes affect published packages, add a changelog file under \`.tegami/\` before merging.`,
    "",
    `[**Create a changelog →**](${labels["create-a-changelog-href"]}) · [Changelog format](https://tegami.fuma-nama.dev/changelog)`,
    "",
  ];

  for (const pkg of graph.getPackages()) {
    const plan = draft.getPackageDraft(pkg.id);
    if (!plan) continue;
    const bumped = plan.bumpVersion(pkg);
    if (!bumped || !pkg.version || bumped === pkg.version) continue;

    pendingPackages.push({
      name: pkg.name,
      type: plan.type ?? "—",
      from: pkg.version,
      to: bumped,
      distTag: plan.npm?.distTag,
    });
  }

  if (pendingPackages.length > 0) {
    lines.push("#### Release preview", "", "| Package | Bump | Version |", "| --- | --- | --- |");

    for (const { name, type, from, to, distTag } of pendingPackages.sort(
      (a, b) => diffWeight(b.from, b.to) - diffWeight(a.from, a.to),
    )) {
      lines.push(`| \`${name}\` | ${type} | \`${from}\` → \`${to}\`${formatNpmDistTag(distTag)} |`);
    }

    lines.push("");
  }

  const newChangelogs = draft
    .getChangelogs()
    .filter((entry) => newChangelogNames.has(entry.filename));

  if (newChangelogs.length > 0) {
    lines.push(
      `#### Changelogs in this ${labels.pr}`,
      "",
      "| Changelog | Title |",
      "| --- | --- |",
    );

    for (const entry of newChangelogs) {
      for (const section of entry.sections) {
        lines.push(`| \`${entry.filename}\` | ${section.title} |`);
      }
    }

    lines.push("");
  } else if (pendingPackages.length === 0) {
    lines.push(
      "#### No changelogs yet",
      "",
      `This ${labels.pr} has no pending changelog files. If your changes require a release, add a changelog before merging.`,
      "",
    );
  } else if (newChangelogNames.size === 0) {
    lines.push(
      `This ${labels.pr} does not add changelog files. Pending changelogs from other branches are included in the preview above.`,
      "",
    );
  }

  lines.push(
    `Run \`${npm?.client ?? "npm"} run tegami\` locally to create a changelog interactively.`,
    "",
    `<sub>Managed by [Tegami](https://tegami.fuma-nama.dev).</sub>`,
    "",
  );

  return lines.join("\n");
}

interface BaseRelease {
  title: string;
  notes: string;
}

type ReleaseInput<V extends BaseRelease> = Omit<Partial<V>, "title" | "notes"> & {
  title: string;
  notes: string;
};

interface GitReleaseProvider<V extends BaseRelease> {
  eager: boolean;
  releaseExistsByTag(this: TegamiContext, tag: string): Promise<boolean>;
  create(opts: {
    input: ReleaseInput<V>;
    tag: string;
    packages: WorkspacePackage[];
  }): Promise<void>;
  override?(
    this: TegamiContext,
    opts: { tag: string; pkg: WorkspacePackage; plan: PublishPlan },
  ): Awaitable<Partial<V>>;
  overrideGroup?(
    this: TegamiContext,
    opts: { tag: string; packages: WorkspacePackage[]; plan: PublishPlan },
  ): Awaitable<Partial<V>>;
  formatChangelog(this: TegamiContext, entry: ChangelogEntry): Awaitable<string>;
}

export async function resolveFileCommit(
  ctx: TegamiContext,
  filename: string,
): Promise<string | undefined> {
  const relativePath = relative(ctx.cwd, join(ctx.changelogDir, filename));
  const result = await x(
    "git",
    ["log", "--diff-filter=A", "-1", "--format=%H", "--", relativePath],
    {
      nodeOptions: { cwd: ctx.cwd },
    },
  );

  if (result.exitCode !== 0) return;
  return result.stdout.trim() || undefined;
}

export function createAutoRelease<V extends BaseRelease>({
  eager,
  create,
  override,
  overrideGroup,
  releaseExistsByTag,
  formatChangelog,
}: GitReleaseProvider<V>) {
  async function defaultNotes(
    ctx: TegamiContext,
    pkg: WorkspacePackage,
    packagePlan?: PackagePublishPlan,
  ): Promise<string> {
    if (packagePlan && packagePlan.changelogs.length > 0) {
      const notes = await Promise.all(packagePlan.changelogs.map(formatChangelog.bind(ctx)));

      return notes.join("\n\n");
    }

    return `Published ${formatPackageVersion(pkg.name, pkg.version, packagePlan?.npm?.distTag)}.`;
  }

  async function defaultGroupedNotes(
    ctx: TegamiContext,
    plan: PublishPlan,
    packages: WorkspacePackage[],
  ): Promise<string> {
    const changelogs = new Map<string, ChangelogEntry>();

    for (const pkg of packages) {
      const packagePlan = plan.packages.get(pkg.id);
      if (!packagePlan) continue;

      for (const entry of packagePlan.changelogs) changelogs.set(entry.id, entry);
    }

    const sections = [
      packages
        .map((pkg) => {
          const packagePlan = plan.packages.get(pkg.id);

          return `- ${formatPackageVersion(pkg.name, pkg.version, packagePlan?.npm?.distTag)}`;
        })
        .join("\n"),
    ];

    if (changelogs.size > 0) {
      const notes = await Promise.all(Array.from(changelogs.values(), formatChangelog.bind(ctx)));
      sections.push("", notes.join("\n\n"));
    }

    return sections.join("\n");
  }

  return {
    async hasPending(this: TegamiContext, plan: PublishPlan): Promise<boolean> {
      const requiredTags = new Set<string>();
      for (const pkg of plan.packages.values()) {
        if (pkg.preflight!.shouldPublish && pkg.git?.tag) requiredTags.add(pkg.git.tag);
      }

      return somePromise(
        Array.from(requiredTags, (tag) => releaseExistsByTag.call(this, tag)),
        (exists) => !exists,
      );
    },
    async create(this: TegamiContext, plan: PublishPlan) {
      const groups = new Map<string, WorkspacePackage[]>();
      for (const [id, { preflight, publishResult, git }] of plan.packages) {
        if (!eager && publishResult!.type === "failed") return;

        const tag = git?.tag;
        if (!tag || !preflight!.shouldPublish) continue;

        const pkg = this.graph.get(id)!;
        const group = groups.get(tag);
        if (group) group.push(pkg);
        else groups.set(tag, [pkg]);
      }

      await Promise.all(
        Array.from(groups, async ([tag, packages]) => {
          for (const member of packages) {
            const result = plan.packages.get(member.id)!.publishResult!;
            if (result.type === "failed") return;
          }

          if (await releaseExistsByTag.call(this, tag)) return;

          if (packages.length > 1) {
            const {
              title = tag,
              notes = await defaultGroupedNotes(this, plan, packages),
              ...rest
            } = (await overrideGroup?.call(this, { tag, packages, plan })) ?? ({} as Partial<V>);
            await create({
              input: { title, notes, ...rest },
              tag,
              packages,
            });
            return;
          }

          const pkg = packages[0]!;
          const packagePlan = plan.packages.get(pkg.id);
          const {
            title = formatPackageVersion(pkg.name, pkg.version, packagePlan?.npm?.distTag),
            notes = await defaultNotes(this, pkg, packagePlan),
            ...rest
          } = (await override?.call(this, { tag, pkg, plan })) ?? ({} as Partial<V>);
          await create({
            input: { title, notes, ...rest },
            tag,
            packages,
          });
        }),
      );
    },
  };
}
