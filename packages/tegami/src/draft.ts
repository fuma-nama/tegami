import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path, { dirname, join } from "node:path";
import type { TegamiContext } from "./context";
import { simpleGenerator } from "./generators/simple";
import { BumpType, bumpVersion, maxBump } from "./utils/semver";
import type { WorkspacePackage } from "./workspace";
import type { ChangelogEntry } from "./markdown";
import { PlanStore, planStoreSchema } from "./schemas";
import type { Awaitable, PublishPlanStatus } from "./types";

/** Per-package options applied when creating publish plans. */
export interface PackageOptions {
  /** npm dist-tag used when publishing. */
  distTag?: string;
  /** Set to false to keep this package out of npm publishing. */
  publish?: boolean;
}

export interface PackagePlan {
  type: BumpType;
  changelogIds: Set<string>;
  distTag?: string;
  publish: boolean;
}

export class DraftPlan {
  #created = false;

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

  /** Write the publish plan, update package versions, and consume changelog files. */
  async createPublishPlan(): Promise<void> {
    this.assertEditable();
    await this.assertPublishPlanFinished();

    this.#created = true;

    await this.applyVersionChanges();

    const plan: PlanStore = {
      id: `tegami-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      changelogs: Object.fromEntries(
        Array.from(this.changelogs, ([id, entry]) => [
          id,
          {
            filename: entry.filename,
            subject: entry.subject,
            packages: Array.from(entry.packages),
            type: entry.type,
            title: entry.title,
            content: entry.content,
          },
        ]),
      ),
      packages: Object.fromEntries(this.packages),
    };

    await mkdir(dirname(this.context.planPath), { recursive: true });
    await writeFile(this.context.planPath, planStoreSchema.encode(plan));
    await this.removeConsumedChangelogs();
  }

  private async assertPublishPlanFinished(): Promise<void> {
    const content = await readFile(this.context.planPath, "utf8").catch(() => undefined);
    if (!content) return;

    const parsed = planStoreSchema.safeDecode(content);
    if (!parsed.success) return;

    const status = await publishPlanStatus(this.context, parsed.data);
    if (status.state === "success") return;

    const message = `Publish plan already exists at ${this.context.planPath} and is ${status.state}. Publish it before creating a new plan.`;
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
        version: bumpVersion(pkg.version, plan.type),
      });
    }

    for (const pkg of graph.getPackages()) {
      const updated = updatedPackages.get(pkg.id);

      for (const [id, updatedDep] of updatedPackages) {
        const target = graph.get(id);
        if (target) await pkg.updateDependency?.(target, updatedDep.version, this.context);
      }

      if (updated) {
        pkg.setVersion?.(updated.version);
        writes.push(this.appendChangelog(pkg, updated.plan));
      }

      const write = pkg.write?.();
      if (write) writes.push(write);
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
    if (this.#created) {
      throw new Error("This draft has already created a publish plan.");
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
      packageName: pkg.name,
      version: pkg.version,
      changelogs,
    });

    const path = join(pkg.path, "CHANGELOG.md");
    const existing = await readFile(path, "utf8").catch(() => "");
    await writeFile(path, `${generated.trim()}\n\n${existing}`.trimEnd() + "\n");
  }

  /** {@link createPublishPlan} but for `await using` syntax */
  async [Symbol.asyncDispose]() {
    return this.createPublishPlan();
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
    const plan = createPackagePlan(pkg, entries, context);
    if (plan) packages.set(pkg.id, plan);
  }

  return new DraftPlan(changelogMap, packages, context);
}

function createPackagePlan(
  pkg: WorkspacePackage,
  entries: ChangelogEntry[],
  context: TegamiContext,
): PackagePlan | null {
  if (entries.length === 0) return null;

  const packageOptions =
    context.options.packages?.[pkg.id] ?? context.options.packages?.[pkg.name] ?? {};
  let type: BumpType = entries[0]!.type;
  const changelogIds = new Set<string>();

  for (const entry of entries) {
    changelogIds.add(entry.id);
    type = maxBump(type, entry.type);
  }

  return {
    type,
    changelogIds,
    distTag: packageOptions.distTag ?? pkg.distTag,
    publish: packageOptions.publish ?? pkg.publish,
  };
}
