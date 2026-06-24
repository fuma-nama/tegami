import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path, { dirname, join } from "node:path";
import type { TegamiContext } from "../context";
import { simpleGenerator } from "../generators/simple";
import { BumpType, maxBump } from "../utils/semver";
import type { WorkspacePackage } from "../graph";
import {
  parseReplayCondition,
  type ParsedReplayCondition,
  type ChangelogEntry,
} from "../changelog/parse";
import { createPlanStore, readPlanStore } from "./store";
import type { Awaitable } from "../types";
import { handlePluginError } from "../utils/error";
import { groupPolicy } from "./policy";
import { publishPlanStatus, assertPublishPlanFinished } from "./checks";
import type { ChangelogPackageConfig } from "../changelog/shared";
import * as semver from "semver";

export interface PackagePlan {
  type?: BumpType;
  bumpReasons?: Set<string>;

  changelogs?: ChangelogEntry[];
  prerelease?: string;
  publish?: boolean;

  npm?: {
    /** npm dist-tag used when publishing. */
    distTag?: string;
  };

  /** get the bumped version of a package */
  bumpVersion: (pkg: WorkspacePackage) => string;
}

export class DraftPlan {
  #applied = false;
  // package id -> plan
  private readonly packages = new Map<string, PackagePlan>();
  // id -> changelog
  private readonly changelogs = new Map<string, ChangelogEntry>();
  private readonly policies: PlanPolicy[] = [];

  constructor(private readonly context: TegamiContext) {
    this.policies.push(groupPolicy(context));
  }

  getPackagePlans() {
    return this.packages;
  }

  getPackagePlan(id: string) {
    return this.packages.get(id);
  }

  bumpPackage(pkg: WorkspacePackage, { type, reason }: { type: BumpType; reason?: string }) {
    return this.dispatchPackage(pkg, (plan) => {
      plan.type = plan.type ? maxBump(plan.type, type) : type;

      if (reason) {
        plan.bumpReasons ??= new Set();
        plan.bumpReasons.add(reason);
      }
    });
  }

  dispatchPackage(
    pkg: WorkspacePackage,
    dispatch: (plan: PackagePlan) => void,
    onUpdate?: (plan: PackagePlan) => void,
  ): PackagePlan {
    const plan = this.getOrInitPackage(pkg);
    const prevVersion = plan.bumpVersion(pkg);
    dispatch(plan);
    if (prevVersion !== plan.bumpVersion(pkg)) {
      onUpdate?.(plan);

      for (const policy of this.policies) {
        policy.onUpdate?.call(this, { plan, pkg });
      }
    }
    return plan;
  }

  getOrInitPackage(pkg: WorkspacePackage): PackagePlan {
    const existing = this.packages.get(pkg.id);
    if (existing) return existing;

    this.packages.set(pkg.id, pkg.initPlan());

    // assign script-level configs
    return this.dispatchPackage(
      pkg,
      (plan) => pkg.configurePlan(plan, this.context.graph.getPackageGroup(pkg.id)),
      (plan) => {
        const reasons = (plan.bumpReasons ??= new Set());
        reasons.add("align with script-level configs");
      },
    );
  }

  hasPending() {
    const { graph } = this.context;
    for (const [id, plan] of this.packages) {
      const pkg = graph.get(id);
      if (pkg && plan.bumpVersion(pkg) !== pkg.version) return true;
    }
    return false;
  }

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
      const plan = this.bumpPackage(pkg, { type: bumpType });
      attachChangelog(plan, entry);
    }
  }

  deleteChangelog(id: string): boolean {
    return this.changelogs.delete(id);
  }

  /** Apply the publish plan: update package versions, write the plan file, and consume changelog files. */
  async applyPlan(): Promise<void> {
    if (this.#applied) {
      throw new Error("This draft has already applied a publish plan.");
    }
    await assertPublishPlanFinished(this.context);
    const { graph } = this.context;
    this.#applied = true;

    const snapshots = new Map<string, { version: string }>();
    for (const pkg of graph.getPackages()) {
      snapshots.set(pkg.id, { version: pkg.version });
    }

    for (const plugin of this.context.plugins) {
      await handlePluginError(plugin, "applyPlan", () =>
        plugin.applyPlan?.call(this.context, this),
      );
    }

    const updatedChangelogs = this.applyReplays(snapshots);
    const writes: Awaitable<void>[] = [];

    for (const [id, packagePlan] of this.packages) {
      const pkg = graph.get(id);
      if (!pkg) continue;
      writes.push(this.appendChangelog(pkg, packagePlan));
    }

    for (const entry of this.changelogs.values()) {
      const updated = updatedChangelogs.get(entry.id);
      const filePath = path.join(this.context.changelogDir, entry.filename);

      writes.push(
        updated ? writeFile(filePath, updated.getRawContent()) : rm(filePath, { force: true }),
      );
    }

    await Promise.all(writes);
    await mkdir(dirname(this.context.planPath), { recursive: true });
    await writeFile(this.context.planPath, createPlanStore(this, this.context));
  }

  addPolicy(policy: PlanPolicy) {
    this.policies.push(policy);
  }

  removePolicy(policy: PlanPolicy) {
    const idx = this.policies.indexOf(policy);
    if (idx !== -1) this.policies.splice(idx, 1);
  }

  canApply() {
    return !this.#applied;
  }

  /** Attach replaying changelog entries to packages (already bumped), and return the updated changelog entries. */
  private applyReplays(snapshots: Map<string, { version: string }>): Map<string, ChangelogEntry> {
    const updated = new Map<string, ChangelogEntry>();
    const { graph } = this.context;

    const isMatch = (condition: ParsedReplayCondition) => {
      if (condition.type === "on-exit-prerelease") {
        return graph.getByName(condition.name).some((pkg) => {
          const previous = snapshots.get(pkg.id);
          return previous && semver.inc(previous.version, "release") === pkg.version;
        });
      }

      return graph.getByName(condition.name).some((pkg) => pkg.version === condition.version);
    };

    for (const entry of this.changelogs.values()) {
      const updatedPackages = new Map<string, ChangelogPackageConfig>();
      const matchedNames = new Set<string>();

      for (const [name, config] of entry.packages) {
        if (!config.replay || config.replay.length === 0) continue;

        const replay = config.replay.filter((item) => {
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

  private async appendChangelog(pkg: WorkspacePackage, plan: PackagePlan): Promise<void> {
    if (!plan.changelogs || plan.changelogs.length === 0) return;
    const { generator = simpleGenerator() } = this.context.options;

    const generated = await generator.generate.call(this.context, {
      packageId: pkg.id,
      packageName: pkg.name,
      version: pkg.version,
      plan,
      changelogs: plan.changelogs,
      unstable_draft: this,
    });

    const path = join(pkg.path, "CHANGELOG.md");
    const existing = await readFile(path, "utf8").catch(() => "");
    await writeFile(path, `${generated.trim()}\n\n${existing}`.trimEnd() + "\n");
  }

  /** {@link applyPlan} but for `await using` syntax */
  async [Symbol.asyncDispose]() {
    return this.applyPlan();
  }
}

export interface PlanPolicy {
  id: string;
  onUpdate?: (this: DraftPlan, opts: { plan: PackagePlan; pkg: WorkspacePackage }) => void;
}

export type CleanupResult =
  | {
      state: "removed";
    }
  | {
      state: "skipped";
      reason: "missing" | "pending";
    };

export async function cleanupPublishPlan(context: TegamiContext): Promise<CleanupResult> {
  const store = await readPlanStore(context);
  if (!store) {
    return { state: "skipped", reason: "missing" };
  }

  const status = await publishPlanStatus(store, context);
  if (status.state !== "success") {
    return { state: "skipped", reason: "pending" };
  }

  await rm(context.planPath, { force: true });
  return { state: "removed" };
}

export async function createDraftPlan(
  changelogs: ChangelogEntry[],
  context: TegamiContext,
): Promise<DraftPlan> {
  let draft = new DraftPlan(context);

  for (const plugin of context.plugins) {
    const result = await handlePluginError(plugin, "initPlan", () =>
      plugin.initPlan?.call(context, draft),
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

function attachChangelog(plan: PackagePlan, entry: ChangelogEntry) {
  if (plan.changelogs?.some((item) => item.id === entry.id)) return;

  plan.changelogs ??= [];
  plan.changelogs.push(entry);
}
