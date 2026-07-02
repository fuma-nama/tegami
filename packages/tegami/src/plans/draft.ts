import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path, { dirname, join } from "node:path";
import type { TegamiContext } from "../context";
import { simpleGenerator } from "../generators/simple";
import { BumpType, maxBump } from "../utils/semver";
import type { WorkspacePackage } from "../graph";
import {
  parseReplayCondition,
  type ReplayCondition,
  type ChangelogEntry,
  formatReplayCondition,
} from "../changelog/parse";
import { PublishLock } from "./lock";
import type { Awaitable } from "../types";
import { handlePluginError } from "../utils/error";
import { groupPolicy } from "./policy";
import type { ChangelogPackageConfig } from "../changelog/shared";
import * as semver from "semver";
import typia from "typia";

export interface PackageDraft {
  type?: BumpType;
  prerelease?: string;
  bumpReasons?: Set<string>;
  changelogs?: ChangelogEntry[];

  npm?: {
    /** npm dist-tag used when publishing. */
    distTag?: string;
  };

  /** get the bumped version of a package, return `undefined` if the package doesn't have a `version` field */
  bumpVersion: (pkg: WorkspacePackage) => string | undefined;
}

export interface ChangelogStore {
  v: "0.0.0";
  filename: string;
  content: string;
}

export interface PackageStore {
  id: string;
  updated: boolean;
  changelogIds?: string[];
}

export const validateChangelogStore: (input: unknown) => typia.IValidation<ChangelogStore> =
  typia.createValidate<ChangelogStore>();
export const validatePackageStore: (input: unknown) => typia.IValidation<PackageStore> =
  typia.createValidate<PackageStore>();

type SnapshotMap = Map<string, { version: string | undefined }>;

enum DraftStatus {
  Ready,
  Applied,
  Applying,
  Failed,
}

/** a draft describes all operations to perform before the actual publishing, such as version bumps. */
export class Draft {
  #status = DraftStatus.Ready;
  /** package id -> draft */
  private readonly packages = new Map<string, PackageDraft>();
  /** id -> changelog */
  private readonly changelogs = new Map<string, ChangelogEntry>();
  private readonly policies: DraftPolicy[] = [];

  constructor(private readonly context: TegamiContext) {
    this.policies.push(groupPolicy(context));
  }

  getPackageDrafts() {
    return this.packages;
  }

  getPackageDraft(id: string) {
    return this.packages.get(id);
  }

  bumpPackage(pkg: WorkspacePackage, { type, reason }: { type: BumpType; reason?: string }) {
    return this.dispatchPackage(pkg, (draft) => {
      draft.type = draft.type ? maxBump(draft.type, type) : type;

      if (reason) {
        draft.bumpReasons ??= new Set();
        draft.bumpReasons.add(reason);
      }
    });
  }

  dispatchPackage(
    pkg: WorkspacePackage,
    dispatch: (draft: PackageDraft) => void,
    onUpdate?: (draft: PackageDraft) => void,
  ): PackageDraft {
    const packageDraft = this.getOrInitPackage(pkg);
    const prevVersion = packageDraft.bumpVersion(pkg);
    dispatch(packageDraft);
    if (prevVersion !== packageDraft.bumpVersion(pkg)) {
      onUpdate?.(packageDraft);

      for (const policy of this.policies) {
        policy.onUpdate?.call(this, { packageDraft, pkg });
      }
    }
    return packageDraft;
  }

  getOrInitPackage(pkg: WorkspacePackage): PackageDraft {
    const existing = this.packages.get(pkg.id);
    if (existing) return existing;

    this.packages.set(pkg.id, pkg.initDraft());

    // assign script-level configs
    return this.dispatchPackage(
      pkg,
      (draft) => pkg.configureDraft({ draft }),
      (draft) => {
        const reasons = (draft.bumpReasons ??= new Set());
        reasons.add("align with script-level configs");
      },
    );
  }

  hasPending() {
    const { graph } = this.context;
    for (const [id, draft] of this.packages) {
      const pkg = graph.get(id);
      if (pkg && draft.bumpVersion(pkg) !== pkg.version) return true;
    }
    return false;
  }

  /** get all changelogs, note that this includes replay-only changelogs, as long as they are in the `.tegami` folder. */
  getChangelogs() {
    return Array.from(this.changelogs.values());
  }

  getChangelog(id: string) {
    return this.changelogs.get(id);
  }

  addChangelog(entry: ChangelogEntry) {
    this.changelogs.set(entry.id, entry);
    const { graph } = this.context;
    const groupPackages = new Map<WorkspacePackage, BumpType>();

    for (const [name, config] of entry.packages) {
      if (!config.type) continue;
      for (const pkg of graph.getByName(name)) groupPackages.set(pkg, config.type);
    }

    for (const [pkg, bumpType] of groupPackages) {
      const pkgDraft = this.bumpPackage(pkg, { type: bumpType });
      attachChangelog(pkgDraft, entry);
    }
  }

  deleteChangelog(id: string): boolean {
    return this.changelogs.delete(id);
  }

  /** Apply version bumps, lock file, and changelog files. */
  async apply(): Promise<void> {
    switch (this.#status) {
      case DraftStatus.Applied:
        throw new Error("This draft has already been applied.");
      case DraftStatus.Applying:
        throw new Error("There is already a previous apply() run.");
      case DraftStatus.Failed:
        throw new Error(
          "The previous apply() run failed, please clear your local git changes and try again.",
        );
    }
    const { graph } = this.context;

    try {
      const snapshots: SnapshotMap = new Map();
      for (const pkg of graph.getPackages()) {
        snapshots.set(pkg.id, { version: pkg.version });
      }

      for (const plugin of this.context.plugins) {
        await handlePluginError(plugin, "applyDraft", () =>
          plugin.applyDraft?.call(this.context, this),
        );
      }

      const updatedChangelogs = this.applyReplays(snapshots);
      const writes: Awaitable<void>[] = [];

      for (const [id, packageDraft] of this.packages) {
        const pkg = graph.get(id);
        if (!pkg) continue;
        writes.push(this.appendChangelog(pkg, packageDraft));
      }

      for (const entry of this.changelogs.values()) {
        const updated = updatedChangelogs.get(entry.id);
        const filePath = path.join(this.context.changelogDir, entry.filename);

        if (updated) {
          writes.push(
            mkdir(this.context.changelogDir, { recursive: true }).then(() =>
              writeFile(filePath, updated.getRawContent()),
            ),
          );
        } else if (!entry.virtual) {
          writes.push(rm(filePath, { force: true }));
        }
      }

      writes.push(this.writeLockFile(snapshots));
      await Promise.all(writes);
      this.#status = DraftStatus.Applied;
    } catch (e) {
      this.#status = DraftStatus.Failed;
      throw e;
    }
  }

  /** write persistent data to publish lock */
  private async writeLockFile(snapshots: SnapshotMap) {
    const lock = new PublishLock();
    const changelogs = new Set<ChangelogEntry>();
    for (const pkg of this.context.graph.getPackages()) {
      const draft = this.getPackageDraft(pkg.id);
      const snapshot = snapshots.get(pkg.id);
      if (!snapshot) continue;

      for (const entry of draft?.changelogs ?? []) {
        changelogs.add(entry);
      }

      lock.write("core:packages", {
        id: pkg.id,
        updated: draft !== undefined && snapshot.version !== pkg.version,
        changelogIds: draft?.changelogs?.map((entry) => entry.id),
      } satisfies PackageStore);
    }
    for (const entry of changelogs) {
      lock.write("core:changelogs", {
        v: "0.0.0",
        filename: entry.filename,
        content: entry.getRawContent(),
      } satisfies ChangelogStore);
    }
    for (const plugin of this.context.plugins) {
      await handlePluginError(plugin, "initPublishLock", () =>
        plugin.initPublishLock?.call(this.context, { lock, draft: this }),
      );
    }

    await mkdir(dirname(this.context.lockPath), { recursive: true });
    await writeFile(this.context.lockPath, lock.serialize());
  }

  addPolicy(policy: DraftPolicy) {
    this.policies.push(policy);
  }

  removePolicy(policy: DraftPolicy) {
    const idx = this.policies.indexOf(policy);
    if (idx !== -1) this.policies.splice(idx, 1);
  }

  canApply() {
    return this.#status === DraftStatus.Ready;
  }

  /** Attach replaying changelog entries to packages (already bumped), and return the updated changelog entries. */
  private applyReplays(snapshots: SnapshotMap): Map<string, ChangelogEntry> {
    const updated = new Map<string, ChangelogEntry>();
    const { graph } = this.context;

    const defaultReplays = (name: string) => {
      const replay: string[] = [];

      for (const pkg of graph.getByName(name)) {
        const draft = this.packages.get(pkg.id);

        if (draft?.prerelease) {
          replay.push(formatReplayCondition({ on: "exit-prerelease", name: pkg.id }));
        }
      }

      return replay;
    };

    const isMatch = (condition: ReplayCondition) => {
      switch (condition.on) {
        case "enter-prerelease":
          return graph.getByName(condition.name).some((pkg) => {
            const previous = snapshots.get(pkg.id);
            if (!pkg.version || !previous?.version) return false;

            return !semver.prerelease(previous.version) && semver.prerelease(pkg.version);
          });
        case "exit-prerelease":
          return graph.getByName(condition.name).some((pkg) => {
            const previous = snapshots.get(pkg.id);
            if (!pkg.version || !previous?.version) return false;

            return semver.inc(previous.version, "release") === pkg.version;
          });
        case "version":
          return graph.getByName(condition.name).some((pkg) => pkg.version === condition.version);
      }
    };

    for (const entry of this.changelogs.values()) {
      const updatedPackages = new Map<string, ChangelogPackageConfig>();
      const matchedNames = new Set<string>();

      for (const [name, config] of entry.packages) {
        let replay = config.replay;
        if (config.type) {
          replay ??= defaultReplays(name);
        }

        if (!replay || replay.length === 0) continue;

        replay = replay.filter((item) => {
          const condition = parseReplayCondition(item);
          if (condition && isMatch(condition)) {
            matchedNames.add(name);
            return false;
          }

          return true;
        });

        if (replay.length === 0) continue;
        const updatedConfig = { ...config, replay };
        delete updatedConfig.type;
        updatedPackages.set(name, updatedConfig);
      }

      if (updatedPackages.size > 0) {
        updated.set(entry.id, {
          ...entry,
          packages: updatedPackages,
        });
      }

      for (const name of matchedNames) {
        for (const pkg of graph.getByName(name)) attachChangelog(this.getOrInitPackage(pkg), entry);
      }
    }

    return updated;
  }

  private async appendChangelog(pkg: WorkspacePackage, draft: PackageDraft): Promise<void> {
    if (!draft.changelogs || draft.changelogs.length === 0) return;
    const { generator = simpleGenerator() } = this.context.options;

    const generated = await generator.generate.call(this.context, {
      pkg,
      packageDraft: draft,
      draft: this,
    });

    const path = join(pkg.path, "CHANGELOG.md");
    const existing = await readFile(path, "utf8").catch(() => "");
    await writeFile(path, `${generated.trim()}\n\n${existing}`.trimEnd() + "\n");
  }

  /** {@link apply} but for `await using` syntax */
  async [Symbol.asyncDispose]() {
    return this.apply();
  }
}

export interface DraftPolicy {
  id: string;
  onUpdate?: (this: Draft, opts: { packageDraft: PackageDraft; pkg: WorkspacePackage }) => void;
}

export async function createDraft(
  changelogs: ChangelogEntry[],
  context: TegamiContext,
): Promise<Draft> {
  let draft = new Draft(context);

  for (const plugin of context.plugins) {
    const result = await handlePluginError(plugin, "initDraft", () =>
      plugin.initDraft?.call(context, draft),
    );
    if (result) draft = result;
  }

  for (const pkg of context.graph.getPackages()) {
    draft.getOrInitPackage(pkg);
  }

  for (const entry of changelogs) {
    draft.addChangelog(entry);
  }

  return draft;
}

function attachChangelog(draft: PackageDraft, entry: ChangelogEntry) {
  if (draft.changelogs?.some((item) => item.id === entry.id)) return;

  draft.changelogs ??= [];
  draft.changelogs.push(entry);
}
