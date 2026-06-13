import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { filterChangelogsByIds, type TegamiContext } from "./context";
import { simpleGenerator } from "./generators/simple";
import { BumpType, bumpVersion, maxBump, updateRange } from "./utils/semver";
import { PackageGraph, type WorkspacePackage, writeManifest } from "./workspace";
import {
  publishPlanSchema,
  type ChangelogEntry,
  type PackagePlan,
  type PublishPlan,
} from "./schemas";

/** Per-package options applied when creating publish plans. */
export interface PackageOptions {
  /** npm dist-tag used when publishing. */
  distTag?: string;
  /** Set to false to keep this package out of npm publishing. */
  publish?: boolean;
  /** Custom git tag, or false to skip git tag creation for this package. */
  gitTag?: string | false;
}

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export class DraftPlan {
  readonly changelogs: ChangelogEntry[];
  readonly packages: PackagePlan[];

  #created = false;
  #context: TegamiContext;

  constructor(changelogs: ChangelogEntry[], packages: PackagePlan[], context: TegamiContext) {
    this.changelogs = changelogs;
    this.packages = packages;
    this.#context = context;
  }

  /** Write the publish plan, update package versions, and consume changelog files. */
  async createPublishPlan(): Promise<PublishPlan> {
    this.assertEditable();
    await this.assertPublishPlanFinished();

    this.#created = true;

    await this.applyVersionChanges();

    const plan: PublishPlan = {
      id: `tegami-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      changelogs: this.changelogs,
      packages: this.packages,
    };

    await mkdir(dirname(this.#context.planPath), { recursive: true });
    await writeFile(this.#context.planPath, publishPlanSchema.encode(plan));
    await this.removeConsumedChangelogs();
    return plan;
  }

  private async assertPublishPlanFinished(): Promise<void> {
    const content = await readFile(this.#context.planPath, "utf8").catch(() => undefined);
    if (!content) return;

    const parsed = publishPlanSchema.safeDecode(content);
    if (!parsed.success) return;

    const status = await this.#context.registryClient.publishPlanStatus(parsed.data);
    if (status.state === "success") return;

    const message = `Publish plan already exists at ${this.#context.planPath} and is ${status.state}. Publish it before creating a new plan.`;
    throw new Error(status.error ? `${message}\n${status.error}` : message);
  }

  private async applyVersionChanges(): Promise<void> {
    const releasesByName = new Map(this.packages.map((release) => [release.name, release]));

    // TODO: Add dependent package bumps when an internal dependency changes outside a
    // dependent's accepted semver range.
    for (const release of this.packages) {
      const pkg = this.#context.graph.get(release.name);
      if (!pkg) continue;

      const manifest = structuredClone(pkg.manifest);
      manifest.version = release.version;

      for (const field of dependencyFields) {
        const dependencies = manifest[field];
        if (!dependencies) continue;

        for (const [name, range] of Object.entries(dependencies)) {
          const dependencyRelease = releasesByName.get(name);
          if (!dependencyRelease) continue;

          dependencies[name] = updateRange(range, dependencyRelease.version);
        }
      }

      await writeManifest(pkg, manifest);
      await this.appendChangelog(pkg, release);
    }
  }

  private async removeConsumedChangelogs() {
    const files = new Set(this.changelogs.map((entry) => entry.file));

    for (const file of files) {
      await rm(file, { force: true });
    }
  }

  private assertEditable(): void {
    if (this.#created) {
      throw new Error("This draft has already created a publish plan.");
    }
  }

  private async appendChangelog(pkg: WorkspacePackage, release: PackagePlan): Promise<void> {
    if (release.changelogIds.size === 0) return;
    const { generator = simpleGenerator() } = this.#context.options;

    const generated = await generator.generate.call(this.#context, {
      packageName: release.name,
      version: release.version,
      changelogs: filterChangelogsByIds(this.changelogs, release.changelogIds),
    });

    const path = join(pkg.path, "CHANGELOG.md");
    const existing = await readFile(path, "utf8").catch(() => "");
    await writeFile(path, `${generated.trim()}\n\n${existing}`.trimEnd() + "\n");
  }
}

export function createDraftPlan(changelogs: ChangelogEntry[], context: TegamiContext): DraftPlan {
  const byPackage = new Map<WorkspacePackage, ChangelogEntry[]>();

  for (const entry of changelogs) {
    for (const requestedPackage of entry.packages) {
      const pkg = context.graph.get(requestedPackage);
      if (!pkg) continue;

      const entries = byPackage.get(pkg) ?? [];
      entries.push(entry);
      byPackage.set(pkg, entries);
    }
  }

  const packages: PackagePlan[] = [];
  for (const [pkg, entries] of byPackage.entries()) {
    const plan = createPackagePlan(pkg, entries, context);
    if (!plan) continue;
    packages.push(plan);
  }

  return new DraftPlan(changelogs, packages, context);
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

  const version = bumpVersion(pkg.version, type);
  const distTag = packageOptions.distTag ?? "latest";
  const gitTag =
    packageOptions.gitTag === false ? false : (packageOptions.gitTag ?? `${pkg.name}@${version}`);

  return {
    name: pkg.name,
    version,
    changelogIds,
    distTag,
    gitTag,
    publish: packageOptions.publish ?? !pkg.private,
  };
}
