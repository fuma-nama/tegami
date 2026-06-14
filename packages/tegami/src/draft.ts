import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path, { dirname, join } from "node:path";
import type { TegamiContext } from "./context";
import { simpleGenerator } from "./generators/simple";
import { BumpType, bumpVersion, maxBump, updateRange } from "./utils/semver";
import type { WorkspacePackage } from "./workspace";
import type { ChangelogEntry } from "./markdown";
import { PlanStore, planStoreSchema } from "./schemas";

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

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export class DraftPlan {
  #created = false;

  constructor(
    // id -> changelog
    private readonly changelogs: Map<string, ChangelogEntry>,
    // package name -> plan
    private readonly packages: Map<string, PackagePlan>,
    private readonly context: TegamiContext,
  ) {}

  getPackages() {
    return Array.from(this.packages.keys());
  }

  getPackage(name: string) {
    return this.packages.get(name);
  }

  setPackage(name: string, plan: Partial<PackagePlan> = {}) {
    this.packages.set(name, {
      ...plan,
      changelogIds: plan.changelogIds ?? new Set(),
      publish: plan.publish ?? true,
      type: plan.type ?? "patch",
    });
  }

  deletePackage(name: string) {
    return this.packages.delete(name);
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

    const status = await this.context.registryClient.publishPlanStatus(parsed.data);
    if (status.state === "success") return;

    const message = `Publish plan already exists at ${this.context.planPath} and is ${status.state}. Publish it before creating a new plan.`;
    throw new Error(status.error ? `${message}\n${status.error}` : message);
  }

  private async applyVersionChanges(): Promise<void> {
    const { graph } = this.context;
    const writes: Promise<void>[] = [];
    // TODO: Add dependent package bumps when an internal dependency changes outside a
    // dependent's accepted semver range.
    for (const [name, plan] of this.packages) {
      const pkg = graph.get(name);
      if (!pkg) continue;

      const manifest = pkg.manifest;
      manifest.version = bumpVersion(manifest.version ?? "0.0.0", plan.type);
    }

    for (const [name, plan] of this.packages) {
      const pkg = graph.get(name);
      if (!pkg) continue;

      for (const field of dependencyFields) {
        const dependencies = pkg.manifest[field];
        if (!dependencies) continue;

        for (const [name, range] of Object.entries(dependencies)) {
          const dep = graph.get(name);
          if (!dep?.manifest.version) continue;

          dependencies[name] = updateRange(range, dep.manifest.version);
        }
      }

      const packageJsonPath = join(pkg.path, "package.json");
      writes.push(
        writeFile(packageJsonPath, `${JSON.stringify(pkg.manifest, null, 2)}\n`),
        this.appendChangelog(pkg, plan),
      );
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
      version: pkg.manifest.version!,
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

export function createDraftPlan(changelogs: ChangelogEntry[], context: TegamiContext): DraftPlan {
  const changelogMap = new Map<string, ChangelogEntry>();
  const byPackage = new Map<WorkspacePackage, ChangelogEntry[]>();

  for (const entry of changelogs) {
    changelogMap.set(entry.id, entry);

    for (const requestedPackage of entry.packages) {
      const pkg = context.graph.get(requestedPackage);
      if (!pkg) continue;

      let entries = byPackage.get(pkg);
      if (!entries) {
        entries = [];
        byPackage.set(pkg, entries);
      }

      entries.push(entry);
    }
  }

  const packages = new Map<string, PackagePlan>();
  for (const [pkg, entries] of byPackage.entries()) {
    const plan = createPackagePlan(pkg, entries, context);
    if (plan) packages.set(pkg.name, plan);
  }

  return new DraftPlan(changelogMap, packages, context);
}

function createPackagePlan(
  pkg: WorkspacePackage,
  entries: ChangelogEntry[],
  context: TegamiContext,
): PackagePlan | null {
  if (entries.length === 0) return null;

  const packageOptions = context.options.packages?.[pkg.name] ?? {};
  let type: BumpType = entries[0]!.type;
  const changelogIds = new Set<string>();

  for (const entry of entries) {
    changelogIds.add(entry.id);
    type = maxBump(type, entry.type);
  }

  return {
    type,
    changelogIds,
    distTag: packageOptions.distTag ?? pkg.manifest.publishConfig?.tag,
    publish: packageOptions.publish ?? !pkg.manifest.private,
  };
}
