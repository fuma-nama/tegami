import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path, { dirname, join } from "node:path";
import type { TegamiContext } from "../context";
import { simpleGenerator } from "../generators/simple";
import { BumpType, bumpVersion, maxBump } from "../utils/semver";
import type { WorkspacePackage } from "../graph";
import type { ChangelogEntry } from "../changelog/parse";
import { createPlanStore, parsePlanStore, PlanStore } from "./store";
import type { Awaitable, PublishPlanStatus } from "../types";

export interface PackagePlan {
  type: BumpType;
  changelogIds: Set<string>;
  prerelease?: string;
  publish: boolean;

  npm?: {
    /** npm dist-tag used when publishing. */
    distTag?: string;
  };
}

export class DraftPlan {
  #applied = false;

  constructor(
    // id -> changelog
    private readonly changelogs: Map<string, ChangelogEntry>,
    // package id -> plan
    private readonly packages: Map<string, PackagePlan>,
    private readonly context: TegamiContext,
  ) {}

  getPackageIds() {
    return Array.from(this.packages.keys());
  }

  getPackage(id: string) {
    return this.packages.get(id);
  }

  setPackage(id: string, plan: Partial<PackagePlan> = {}) {
    this.packages.set(id, {
      ...plan,
      changelogIds: plan.changelogIds ?? new Set(),
      publish: plan.publish ?? true,
      type: plan.type ?? "patch",
    });
  }

  deletePackage(id: string) {
    return this.packages.delete(id);
  }

  getChangelogIds() {
    return Array.from(this.changelogs.keys());
  }

  getChangelog(id: string) {
    return this.changelogs.get(id);
  }

  setChangelog(id: string, entry: ChangelogEntry) {
    this.changelogs.set(id, entry);
  }

  deleteChangelog(id: string): boolean {
    return this.changelogs.delete(id);
  }

  /** Apply the publish plan: update package versions, write the plan file, and consume changelog files. */
  async applyPlan(): Promise<void> {
    this.assertEditable();
    await this.assertPublishPlanFinished();

    this.#applied = true;

    await this.applyVersionChanges();

    await mkdir(dirname(this.context.planPath), { recursive: true });
    await writeFile(this.context.planPath, createPlanStore(this));
    await this.removeConsumedChangelogs();
  }

  editable() {
    return !this.#applied;
  }

  private async assertPublishPlanFinished(): Promise<void> {
    const content = await readFile(this.context.planPath, "utf8").catch(() => undefined);
    if (!content) return;

    let store: PlanStore;
    try {
      store = parsePlanStore(content);
    } catch {
      return;
    }

    // TODO: allow plugins to decide
    const status = await publishPlanStatus(this.context, store);
    if (status.state === "success") return;

    const message = `Publish plan already exists at ${this.context.planPath} and is ${status.state}. Publish it before applying a new plan.`;
    throw new Error(status.error ? `${message}\n${status.error}` : message);
  }

  private async applyVersionChanges(): Promise<void> {
    const { graph } = this.context;
    const updatedPackages = new Map<string, { plan: PackagePlan; version: string }>();
    const writes: Awaitable<void>[] = [];

    for (const [id, plan] of this.packages) {
      const pkg = graph.get(id);
      if (!pkg) continue;

      updatedPackages.set(id, {
        plan,
        version: bumpVersion(pkg.version, plan.type, plan.prerelease),
      });
    }

    for (const pkg of graph.getPackages()) {
      const updated = updatedPackages.get(pkg.id);

      for (const [id, updatedDep] of updatedPackages) {
        const target = graph.get(id);
        if (target) await pkg.updateDependency(target, updatedDep.version, this.context);
      }

      if (updated) {
        pkg.setVersion(updated.version);
        writes.push(this.appendChangelog(pkg, updated.plan));
      }

      writes.push(pkg.write());
    }

    await Promise.all(writes);
  }

  private async removeConsumedChangelogs() {
    const writes: Promise<void>[] = [];
    for (const entry of this.changelogs.values()) {
      const file = path.resolve(this.context.cwd, this.context.changelogDir, entry.filename);
      writes.push(rm(file, { force: true }));
    }
    await Promise.all(writes);
  }

  private assertEditable(): void {
    if (this.#applied) {
      throw new Error("This draft has already applied a publish plan.");
    }
  }

  private async appendChangelog(pkg: WorkspacePackage, plan: PackagePlan): Promise<void> {
    if (plan.changelogIds.size === 0) return;
    const { generator = simpleGenerator() } = this.context.options;
    const changelogs: ChangelogEntry[] = [];
    for (const id of plan.changelogIds) {
      const entry = this.changelogs.get(id);
      if (entry) changelogs.push(entry);
    }

    const generated = await generator.generate.call(this.context, {
      packageId: pkg.id,
      packageName: pkg.name,
      version: pkg.version,
      npm: plan.npm,
      plan,
      changelogs,
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

async function publishPlanStatus(
  context: TegamiContext,
  plan: PlanStore,
): Promise<PublishPlanStatus> {
  for (const [id, pkgPlan] of Object.entries(plan.packages)) {
    const pkg = context.graph.get(id);
    if (!pkg || !pkgPlan.publish) continue;

    const exists = await context.getRegistryClient(pkg).packageVersionExists(pkg, pkg.version);
    if (!exists) return { state: "pending" };
  }

  return { state: "success" };
}

export function createDraftPlan(changelogs: ChangelogEntry[], context: TegamiContext): DraftPlan {
  const changelogMap = new Map<string, ChangelogEntry>();
  const byPackage = new Map<WorkspacePackage, ChangelogEntry[]>();

  for (const entry of changelogs) {
    changelogMap.set(entry.id, entry);

    for (const requestedPackage of entry.packages) {
      for (const pkg of context.graph.getByName(requestedPackage)) {
        let entries = byPackage.get(pkg);
        if (!entries) {
          entries = [];
          byPackage.set(pkg, entries);
        }

        entries.push(entry);
      }
    }
  }

  const packages = new Map<string, PackagePlan>();
  for (const [pkg, entries] of byPackage.entries()) {
    if (entries.length === 0) continue;
    packages.set(pkg.id, createPackagePlan(pkg, entries, context));
  }

  // TODO: create a special type of package plan to represent sync-version updates
  for (const group of context.graph.getGroups()) {
    if (!group.options.syncVersion || group.packages.length <= 1) continue;

    let bumpType: BumpType | undefined;
    for (const member of group.packages) {
      const plan = packages.get(member.id);
      if (!plan) continue;

      if (!bumpType) {
        bumpType = plan.type;
      } else {
        bumpType = maxBump(bumpType, plan.type);
      }
    }

    if (!bumpType) continue;
    for (const member of group.packages) {
      let plan = packages.get(member.id);
      if (!plan) {
        plan = createPackagePlan(member, [], context);
        packages.set(member.id, plan);
      }

      plan.type = bumpType;
    }
  }

  // apply group configs
  for (const group of context.graph.getGroups()) {
    for (const member of group.packages) {
      const plan = packages.get(member.id);
      if (!plan) continue;
      plan.prerelease ??= group.options.prerelease;
    }
  }

  return new DraftPlan(changelogMap, packages, context);
}

function createPackagePlan(
  pkg: WorkspacePackage,
  entries: ChangelogEntry[],
  context: TegamiContext,
): PackagePlan {
  let type: BumpType = "patch";
  const changelogIds = new Set<string>();

  for (const entry of entries) {
    changelogIds.add(entry.id);
    type = maxBump(type, entry.type);
  }

  const defaults = pkg.onPlan(context);
  return {
    ...defaults,
    type,
    changelogIds,
    publish: defaults.publish ?? false,
  };
}
