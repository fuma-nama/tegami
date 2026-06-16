import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path, { dirname, join } from "node:path";
import type { TegamiContext } from "../context";
import { simpleGenerator } from "../generators/simple";
import { BumpType, maxBump } from "../utils/semver";
import type { WorkspacePackage } from "../graph";
import type { ChangelogEntry } from "../changelog/parse";
import { createPlanStore, PlanStore, readPlanStore } from "./store";
import type { Awaitable, PublishPlanStatus } from "../types";
import { handlePluginError } from "../utils/error";

export interface PackagePlan {
  type?: BumpType;
  bumpReasons?: string[];

  changelogs?: ChangelogEntry[];
  prerelease?: string;
  publish?: boolean;

  npm?: {
    /** npm dist-tag used when publishing. */
    distTag?: string;
  };

  bumpVersion: (pkg: WorkspacePackage) => string;
}

export class DraftPlan {
  #applied = false;
  // package id -> plan
  private readonly packages = new Map<string, PackagePlan>();
  // id -> changelog
  private readonly changelogs = new Map<string, ChangelogEntry>();

  constructor(private readonly context: TegamiContext) {}

  getPackagePlans() {
    return this.packages;
  }

  getPackagePlan(id: string) {
    return this.packages.get(id);
  }

  bumpPackage(pkg: WorkspacePackage, { type, reason }: { type: BumpType; reason?: string }) {
    let plan = this.packages.get(pkg.id);
    if (!plan) {
      plan = this.initPackagePlan(pkg);
      this.packages.set(pkg.id, plan);
    }
    plan.type = plan.type ? maxBump(plan.type, type) : type;
    if (reason) {
      plan.bumpReasons ??= [];
      plan.bumpReasons.push(reason);
    }

    return plan;
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
    const groupPackages = new Set<WorkspacePackage>();

    for (const name of entry.packages) {
      for (const pkg of graph.getByName(name)) groupPackages.add(pkg);
    }

    for (const pkg of groupPackages) {
      const plan = this.bumpPackage(pkg, { type: entry.type });
      plan.changelogs ??= [];
      plan.changelogs.push(entry);
    }
  }

  deleteChangelog(id: string): boolean {
    return this.changelogs.delete(id);
  }

  private initPackagePlan(pkg: WorkspacePackage) {
    const context = this.context;
    const plan = pkg.onPlan(context);

    const group = context.graph.getPackageGroup(pkg.id);
    // apply group configs
    if (group) plan.prerelease ??= group.options.prerelease;

    return plan;
  }

  /** Apply the publish plan: update package versions, write the plan file, and consume changelog files. */
  async applyPlan(): Promise<void> {
    if (this.#applied) {
      throw new Error("This draft has already applied a publish plan.");
    }
    this.#applied = true;
    await this.assertPublishPlanFinished();

    for (const plugin of this.context.plugins) {
      await handlePluginError(plugin, "applyPlan", () =>
        plugin.applyPlan?.call(this.context, this),
      );
    }

    this.applyGroupPolicy();

    const { graph } = this.context;
    const writes: Awaitable<void>[] = [];
    for (const [id, packagePlan] of this.packages) {
      const pkg = graph.get(id);
      if (!pkg) continue;
      writes.push(this.appendChangelog(pkg, packagePlan));
    }
    await Promise.all(writes);

    await mkdir(dirname(this.context.planPath), { recursive: true });
    await writeFile(this.context.planPath, createPlanStore(this, this.context));
    await this.removeConsumedChangelogs();
  }

  private applyGroupPolicy() {
    const { graph } = this.context;

    for (const group of graph.getGroups()) {
      if (!group.options.syncBump || group.packages.length <= 1) continue;

      let bumpType: BumpType | undefined;
      for (const member of group.packages) {
        const pkgPlan = this.packages.get(member.id);
        if (!pkgPlan?.type) continue;

        bumpType = bumpType ? maxBump(bumpType, pkgPlan.type) : pkgPlan.type;
      }

      if (!bumpType) continue;
      for (const member of group.packages) {
        this.bumpPackage(member, {
          type: bumpType,
          reason: "sync group package versions",
        });
      }
    }
  }

  editable() {
    return !this.#applied;
  }

  private async assertPublishPlanFinished(): Promise<void> {
    const store = await readPlanStore(this.context);
    if (!store) return;
    const status = await publishPlanStatus(store, this.context);

    if (status.state === "pending") {
      throw new Error(
        "Publish plan already exists at ${this.context.planPath} and is pending. Publish it before applying a new plan.",
      );
    }
  }

  private async removeConsumedChangelogs() {
    const writes: Promise<void>[] = [];
    for (const entry of this.changelogs.values()) {
      const file = path.resolve(this.context.changelogDir, entry.filename);
      writes.push(rm(file, { force: true }));
    }
    await Promise.all(writes);
  }

  private async appendChangelog(pkg: WorkspacePackage, plan: PackagePlan): Promise<void> {
    if (!plan.changelogs || plan.changelogs.length === 0) return;
    const { generator = simpleGenerator() } = this.context.options;

    const generated = await generator.generate.call(this.context, {
      packageId: pkg.id,
      packageName: pkg.name,
      version: pkg.version,
      npm: plan.npm,
      plan,
      changelogs: plan.changelogs,
      _draft: this,
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

export async function publishPlanStatus(
  store: PlanStore,
  context: TegamiContext,
): Promise<PublishPlanStatus> {
  async function defaultStatus(): Promise<PublishPlanStatus> {
    for (const [id, pkgPlan] of Object.entries(store.packages)) {
      const pkg = context.graph.get(id);
      if (!pkg || !pkgPlan.publish) continue;

      const published = await context.getRegistryClient(pkg).isPackagePublished(pkg);
      if (!published) return { state: "pending" };
    }

    return { state: "success" };
  }

  let status = await defaultStatus();
  for (const plugin of context.plugins) {
    const resolved = await handlePluginError(plugin, "resolvePlanStatus", () =>
      plugin.resolvePlanStatus?.call(context, status, { plan: store }),
    );
    if (resolved) status = resolved;
  }
  return status;
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

  for (const entry of changelogs) {
    draft.addChangelog(entry);
  }

  for (const plugin of context.plugins) {
    const next = await handlePluginError(plugin, "initPlan", () =>
      plugin.initPlan?.call(context, draft),
    );
    draft = next ?? draft;
  }

  return draft;
}
