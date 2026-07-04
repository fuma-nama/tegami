import { x } from "tinyexec";
import { readFile, writeFile } from "node:fs/promises";
import typia from "typia";
import type { TegamiContext } from "../context";
import type { ChangelogEntry } from "../changelog/parse";
import type { Draft } from "../plans/draft";
import { parsePublishLock, type PublishLock } from "../plans/lock";
import type { PublishPlan } from "../plans/publish";
import type { Awaitable } from "../types";
import type { WorkspacePackage } from "../graph";
import { execFailure } from "./error";
import { isCI } from "./common";
import { formatNpmDistTag } from "./semver";

/** a version request (pull/merge request) to upsert on the git provider */
interface VersionRequest {
  title: string;
  body: string;
  head: string;
  base: string;
}

interface VersionRequestOptions {
  /** Create the request even outside of CI. */
  forceCreate?: boolean;
  /** Request head branch. */
  branch?: string;
  /** Request base branch. */
  base?: string;
  /** Publish groups to split into separate version requests. */
  groups?: (string | string[])[];
  /** Override details of a version request at version-time. */
  create?: (
    this: TegamiContext,
    opts: { draft: Draft; publishGroup?: string[] },
  ) => Awaitable<{ title?: string; body?: string }>;
}

/** adapter over the version request API of a git provider */
interface GitProvider<Handle> {
  /** provider name, used as the namespace prefix in publish lock (e.g. `github`) */
  name: string;
  /** summary line of default request bodies */
  summary: string;
  options: VersionRequestOptions | false | undefined;
  /** whether the provider API is available (e.g. repo & token configured) */
  enabled: (context: TegamiContext) => boolean;
  /** find an open version request, return a handle passed to `update` */
  find: (
    context: TegamiContext,
    opts: { head: string; base: string },
  ) => Awaitable<Handle | undefined>;
  create: (context: TegamiContext, request: VersionRequest) => Awaitable<void>;
  update: (context: TegamiContext, handle: Handle, request: VersionRequest) => Awaitable<void>;
}

/** a publish group: a subset of packages versioned & published through a dedicated version request */
interface PublishGroup {
  /** request title, resolved at version-time */
  title: string;
  /** request head branch */
  branch: string;
  /** member package names/ids, resolved against the package graph */
  packages: string[];
}

/** publish group state stored in the lock under `<provider>:publish-group` */
interface PublishGroupStore {
  /** groups whose version request was merged, they stay listed until the lock is removed */
  active: PublishGroup[];
  /** groups still waiting for their version request to be merged */
  pending: PublishGroup[];
  /** package id -> version before the bump, to render request bodies at publish-time */
  versions: Record<string, string>;
}

const validatePublishGroupStore: (input: unknown) => typia.IValidation<PublishGroupStore> =
  typia.createValidate<PublishGroupStore>();

export function onVersionRequest<Handle>(provider: GitProvider<Handle>) {
  const namespace = `${provider.name}:publish-group`;
  /** package id -> version before applying the CLI draft */
  const snapshots = new Map<string, string | undefined>();
  /** publish group state restored from the lock, publish-time only */
  let store: PublishGroupStore | undefined;

  function resolveConfig() {
    if (provider.options === false) return;
    const {
      forceCreate = false,
      branch = "tegami/version-packages",
      base = "main",
      groups,
      create,
    } = provider.options ?? {};

    return { forceCreate, branch, base, groups, create };
  }

  async function createDraftRequest(
    context: TegamiContext,
    config: NonNullable<ReturnType<typeof resolveConfig>>,
    draft: Draft,
    versions: Record<string, string>,
    group?: PublishGroup,
  ): Promise<{ title: string; body: string }> {
    const custom = await config.create?.call(context, { draft, publishGroup: group?.packages });

    return {
      title: custom?.title ?? group?.title ?? "Version Packages",
      body:
        custom?.body ??
        renderRequestBody(draftRequestItems(context, draft, versions, group), provider.summary),
    };
  }

  async function upsertRequest(context: TegamiContext, request: VersionRequest): Promise<void> {
    const handle = await provider.find(context, { head: request.head, base: request.base });

    if (handle !== undefined) await provider.update(context, handle, request);
    else await provider.create(context, request);
  }

  return {
    /** snapshot package versions, hook into `initCliDraft` */
    initCliDraft(this: TegamiContext): void {
      for (const pkg of this.graph.getPackages()) {
        snapshots.set(pkg.id, pkg.version);
      }
    },

    /** commit & push version branches, then upsert their requests, hook into `applyCliDraft` */
    async applyCliDraft(this: TegamiContext, draft: Draft): Promise<void> {
      const config = resolveConfig();
      if (!config || !provider.enabled(this)) return;
      if (!(config.forceCreate || isCI()) || !(await hasGitChanges(this.cwd))) return;

      /** package id -> version before the bump */
      const versions: Record<string, string> = {};
      for (const id of draft.getPackageDrafts().keys()) {
        const pkg = this.graph.get(id);
        const original = snapshots.get(id);
        if (!pkg?.version || !original || original === pkg.version) continue;

        versions[id] = original;
      }

      const groups = resolvePublishGroups(this, config.branch, config.groups, versions);

      if (groups.length === 0) {
        const request = await createDraftRequest(this, config, draft, versions);

        await createVersionCommit(this.cwd, request.title);
        await pushBranch(this.cwd, config.branch);
        await upsertRequest(this, { ...request, head: config.branch, base: config.base });
        return;
      }

      const requests: { title: string; body: string }[] = [];
      for (const group of groups) {
        const request = await createDraftRequest(this, config, draft, versions, group);
        // store the resolved title so re-synced requests keep it
        group.title = request.title;
        requests.push(request);
      }

      await createVersionCommit(this.cwd, "Version Packages");
      const versionCommit = await run(
        this.cwd,
        ["rev-parse", "HEAD"],
        "Failed to resolve the version commit.",
      );
      if (!versionCommit) throw new Error("Failed to resolve the version commit.");
      /** lock content of the version commit, without publish groups */
      const lockContent = await readFile(this.lockPath, "utf8");

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i]!;
        const request = requests[i]!;
        if (i > 0) {
          await run(
            this.cwd,
            ["checkout", "--detach", versionCommit],
            "Failed to check out the version commit.",
          );
        }

        const lock = parsePublishLock(lockContent);
        lock.write(namespace, {
          active: [group],
          pending: groups.filter((other) => other !== group),
          versions,
        } satisfies PublishGroupStore);
        await writeFile(this.lockPath, lock.serialize());
        await commitChanges(this.cwd, request.title);
        await pushBranch(this.cwd, group.branch);
        await upsertRequest(this, { ...request, head: group.branch, base: config.base });
      }
    },

    /** restore publish groups from the lock into the plan, hook into `initPublishPlan` */
    initPublishPlan(
      this: TegamiContext,
      { lock, plan }: { lock: PublishLock; plan: PublishPlan },
    ): void {
      store = undefined;

      let data: unknown;
      const entries: PublishGroupStore[] = [];
      while ((data = lock.read(namespace)) !== undefined) {
        const validated = validatePublishGroupStore(data);
        if (validated.success) entries.push(validated.data);
      }
      if (entries.length === 0) return;

      // tolerate multiple stored entries (e.g. a surprising lock merge), active groups win so
      // the failure mode is publishing groups early rather than dropping them
      const merged: PublishGroupStore = { active: [], pending: [], versions: {} };
      const seen = new Set<string>();
      for (const entry of entries) {
        Object.assign(merged.versions, entry.versions);
        for (const group of entry.active) {
          if (seen.has(group.branch)) continue;
          seen.add(group.branch);
          merged.active.push(group);
        }
      }
      for (const entry of entries) {
        for (const group of entry.pending) {
          if (seen.has(group.branch)) continue;
          seen.add(group.branch);
          merged.pending.push(group);
        }
      }
      store = merged;

      const packages = new Set(plan.options.packages);
      for (const group of merged.active) {
        for (const name of group.packages) packages.add(name);
      }
      if (packages.size > 0) {
        plan.options = {
          ...plan.options,
          packages: Array.from(packages),
        };
      }
    },

    /** report `pending` while publish groups are waiting for their request, hook into `resolvePlanStatus` */
    resolvePlanStatus(): "pending" | undefined {
      if (store && store.pending.length > 0) return "pending";
    },

    /** re-sync the version requests of pending publish groups, hook into `beforePublishAll` */
    async beforePublishAll(this: TegamiContext, { plan }: { plan: PublishPlan }): Promise<void> {
      if (!store || store.pending.length === 0 || plan.options.dryRun) return;
      const config = resolveConfig();
      if (!config || !provider.enabled(this)) return;

      const head = await run(
        this.cwd,
        ["rev-parse", "HEAD"],
        "Failed to resolve the current commit.",
      );
      const ref = await run(
        this.cwd,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        "Failed to resolve the current branch.",
      );
      const lockContent = await readFile(this.lockPath, "utf8");

      try {
        for (const group of store.pending) {
          const lock = parsePublishLock(lockContent);
          // replace the stored state with one where this group is activated by the merge
          while (lock.read(namespace) !== undefined);
          lock.write(namespace, {
            active: [...store.active, group],
            pending: store.pending.filter((other) => other !== group),
            versions: store.versions,
          } satisfies PublishGroupStore);

          await run(
            this.cwd,
            ["checkout", "--detach", head],
            "Failed to check out the current commit.",
          );
          await writeFile(this.lockPath, lock.serialize());
          await commitChanges(this.cwd, group.title);
          await pushBranch(this.cwd, group.branch);

          await upsertRequest(this, {
            title: group.title,
            body: renderRequestBody(
              planRequestItems(this, plan, store.versions, group),
              provider.summary,
            ),
            head: group.branch,
            base: config.base,
          });
        }
      } finally {
        // restore the original checkout for the rest of the publish flow
        await run(
          this.cwd,
          ["checkout", ref === "HEAD" ? head : ref],
          "Failed to restore the original checkout.",
        );
      }
    },
  };
}

function resolvePublishGroups(
  context: TegamiContext,
  branch: string,
  groups: (string | string[])[] | undefined,
  versions: Record<string, string>,
): PublishGroup[] {
  if (!groups?.length) return [];

  const out: PublishGroup[] = [];
  const matched = new Set<string>();

  for (const entry of groups) {
    const members = Array.isArray(entry) ? entry : [entry];
    let hasMatched = false;

    for (const name of members) {
      for (const pkg of context.graph.getByName(name)) {
        if (pkg.id in versions && !matched.has(pkg.id)) {
          hasMatched = true;
          matched.add(pkg.id);
        }
      }
    }

    if (!hasMatched) continue;
    const slug = members.map(branchSlug).filter(Boolean).join("-") || "group";
    out.push({
      title: `Release ${members.join(", ")}`,
      // group branches always live under `<branch>/`, they must never share a name with
      // the head branch of another group: git refs cannot nest under an existing ref
      branch: `${branch}/${slug}`,
      packages: members,
    });
  }

  const unlisted = Object.keys(versions).filter((id) => !matched.has(id));
  if (unlisted.length > 0) {
    out.push({
      title: "Release unlisted packages",
      branch: `${branch}/unlisted`,
      packages: unlisted,
    });
  }

  return out;
}

function branchSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

interface VersionRequestItem {
  pkg: WorkspacePackage;
  /** version before the bump, omitted when unchanged */
  from?: string;
  changelogs: ChangelogEntry[];
  distTag?: string;
}

function resolveMembers(context: TegamiContext, group: PublishGroup): Set<string> {
  const ids = new Set<string>();
  for (const name of group.packages) {
    for (const pkg of context.graph.getByName(name)) ids.add(pkg.id);
  }

  return ids;
}

function draftRequestItems(
  context: TegamiContext,
  draft: Draft,
  versions: Record<string, string>,
  group?: PublishGroup,
): VersionRequestItem[] {
  const members = group ? resolveMembers(context, group) : undefined;
  const items: VersionRequestItem[] = [];

  for (const [id, packageDraft] of draft.getPackageDrafts()) {
    if (members && !members.has(id)) continue;
    const pkg = context.graph.get(id);
    if (!pkg) continue;

    items.push({
      pkg,
      from: versions[id],
      changelogs: packageDraft.changelogs ?? [],
      distTag: packageDraft.npm?.distTag,
    });
  }

  return items;
}

function planRequestItems(
  context: TegamiContext,
  plan: PublishPlan,
  versions: Record<string, string>,
  group: PublishGroup,
): VersionRequestItem[] {
  const items: VersionRequestItem[] = [];

  for (const id of resolveMembers(context, group)) {
    const pkg = context.graph.get(id);
    const packagePlan = plan.packages.get(id);
    if (!pkg || !packagePlan) continue;

    items.push({
      pkg,
      from: versions[id],
      changelogs: packagePlan.changelogs,
      distTag: packagePlan.npm?.distTag,
    });
  }

  return items;
}

function renderRequestBody(items: VersionRequestItem[], summary: string): string {
  const packageLines: string[] = [];
  const changesets = new Map<ChangelogEntry, WorkspacePackage[]>();

  for (const { pkg, from, changelogs, distTag } of items) {
    for (const entry of changelogs) {
      const list = changesets.get(entry);
      if (list) list.push(pkg);
      else changesets.set(entry, [pkg]);
    }

    if (!from || from === pkg.version) continue;
    packageLines.push(
      `| \`${pkg.name}\` | \`${from}\` | \`${pkg.version}\`${formatNpmDistTag(distTag)} |`,
    );
  }

  const changelogLines: string[] = [];
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

  const sections = ["## Summary", "", summary, ""];

  if (packageLines.length > 0) {
    sections.push("| Package | From | To |", "| --- | --- | --- |", ...packageLines);
  }

  if (changelogLines.length > 0) {
    sections.push("", "## Changelogs", ...changelogLines);
  }

  sections.push("");

  return sections.join("\n");
}

async function run(cwd: string, args: string[], message: string): Promise<string> {
  const result = await x("git", args, { nodeOptions: { cwd } });
  if (result.exitCode !== 0) {
    throw execFailure(message, result);
  }

  return result.stdout.trim();
}

async function hasGitChanges(cwd: string): Promise<boolean> {
  const out = await run(cwd, ["status", "--porcelain"], "Failed to check git status.");
  return out.length > 0;
}

async function commitChanges(cwd: string, title: string): Promise<void> {
  await run(cwd, ["add", "-A"], "Failed to stage version changes.");
  await run(cwd, ["commit", "-m", title], "Failed to commit version changes.");
}

/** commit the working tree changes onto a detached HEAD */
async function createVersionCommit(cwd: string, title: string): Promise<void> {
  await run(cwd, ["checkout", "--detach"], "Failed to detach HEAD for version branches.");
  await commitChanges(cwd, title);
}

async function pushBranch(cwd: string, branch: string): Promise<void> {
  await run(cwd, ["checkout", "-B", branch], "Failed to create the version branch.");
  await run(
    cwd,
    ["push", "--force", "-u", "origin", branch],
    "Failed to push the version branch to origin. Ensure `origin` is configured and you have push access.",
  );
}
