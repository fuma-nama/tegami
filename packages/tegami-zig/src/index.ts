import { readFile } from "node:fs/promises";
import path from "node:path";
import * as semver from "semver";
import { glob } from "tinyglobby";
import type {
  BumpType,
  DraftPolicy,
  PackageGraph,
  PackagePublishResult,
  PublishPlan,
  TegamiContext,
  TegamiPlugin,
} from "tegami";
import { WorkspacePackage } from "tegami";
import {
  getField,
  parseZonObject,
  printZigString,
  replaceNode,
  writeZonFile,
  type ZonFile,
  type ZonObject,
} from "./zon";

interface ZigDependencyRef {
  dependent: ZigPackage;
  name: string;
  spec: ZonObject;
  linked: ZigPackage;
  version?: string;
  setVersion?: (version: string) => void;
}

type Awaitable<T> = T | Promise<T>;

interface ZigPublishContext {
  pkg: ZigPackage;
  plan: PublishPlan;
  tag?: string;
}

type ZigPublishStatus = "success" | "pending" | undefined | void;
type ZigPublishWaitMode = "required" | "optional" | false;
type ZigShouldPublish =
  | boolean
  | ((this: TegamiContext, opts: ZigPublishContext) => Awaitable<boolean>);

interface ZigSharedPublishOptions {
  /**
   * Whether this package should participate in publishing.
   *
   * Packages without a `.version` are never published.
   *
   * @default true
   */
  shouldPublish?: ZigShouldPublish;

  /**
   * How local `.path` dependencies affect publish ordering.
   *
   * `optional` preserves dependency-first ordering without failing on cycles.
   *
   * @default "optional"
   */
  waitForDependencies?: ZigPublishWaitMode;

  /**
   * Resolve whether the package has already been published.
   *
   * Custom strategies default to `pending` so `tegami publish` runs the strategy.
   * Provide this hook to make cleanup/status checks idempotent.
   */
  resolveStatus?: (this: TegamiContext, opts: ZigPublishContext) => Awaitable<ZigPublishStatus>;
}

export type ZigPublishOptions =
  | false
  | "git-tag"
  | (ZigSharedPublishOptions & {
      /**
       * Mark the package as published so Tegami's Git/GitHub/GitLab plugins can
       * create tags or releases. Requires one of those plugins to provide a tag.
       */
      type: "git-tag";
    })
  | (ZigSharedPublishOptions & {
      /** Run custom publish logic. */
      type: "custom";
      publish(
        this: TegamiContext,
        opts: ZigPublishContext,
      ): Awaitable<PackagePublishResult | undefined | void>;
    });

export interface ZigPluginOptions {
  /**
   * Additional package directories or glob patterns to discover.
   *
   * Local `.path` dependencies are always followed recursively from the root
   * `build.zig.zon`; use this for packages that are not reachable from the root.
   */
  workspace?: string[];

  /**
   * Decide how to bump packages that depend on a bumped local Zig package.
   *
   * @default "patch" for every local path dependency
   */
  bumpDep?: (opts: ZigDependencyRef) => BumpType | false;

  /**
   * Publish strategy for Zig packages.
   *
   * @default false
   */
  publish?: ZigPublishOptions;
}

export class ZigPackage extends WorkspacePackage {
  readonly manager = "zig";

  constructor(
    readonly path: string,
    readonly file: ZonFile,
  ) {
    super();
  }

  get name(): string {
    const name = getField(this.file.root, "name")?.value;
    if (name?.kind === "string" || name?.kind === "enum") return name.value;
    throw new Error(`Invalid build.zig.zon in "${this.path}": missing package name.`);
  }

  get version(): string | undefined {
    const version = getField(this.file.root, "version")?.value;
    return version?.kind === "string" ? version.value : undefined;
  }

  setVersion(version: string): void {
    const entry = getField(this.file.root, "version")?.value;
    if (entry?.kind !== "string") {
      throw new Error(`Invalid build.zig.zon in "${this.path}": missing package version.`);
    }

    entry.value = version;
    replaceNode(this.file, entry, printZigString(version));
  }

  async write(): Promise<void> {
    await writeZonFile(this.file);
  }
}

export function zig({
  workspace = [],
  bumpDep: getBumpDepType,
  publish: publishOptions = false,
}: ZigPluginOptions = {}): TegamiPlugin {
  let active = false;
  const publishStrategy = normalizePublishOptions(publishOptions);

  return {
    name: "zig",
    async resolve() {
      const packages = await discoverZigPackages(this.cwd, workspace);
      for (const pkg of packages) this.graph.add(pkg);
      active = packages.length > 0;
    },
    initDraft(draft) {
      if (!active) return;
      draft.addPolicy(depsPolicy(this, getBumpDepType));
    },
    async publishPreflight({ pkg, plan }) {
      if (!(pkg instanceof ZigPackage)) return;

      const shouldPublish = await resolveShouldPublish.call(this, publishStrategy, { pkg, plan });
      const dependencyIds = dependencyRefs(this.graph, pkg).map((ref) => ref.linked.id);

      return {
        shouldPublish,
        ...dependencyWaits(publishStrategy?.waitForDependencies ?? "optional", dependencyIds),
      };
    },
    resolvePlanStatus({ plan }) {
      if (!publishStrategy) return;

      return Array.from(plan.packages, async ([id, packagePlan]) => {
        if (!packagePlan.preflight?.shouldPublish) return;

        const pkg = this.graph.get(id);
        if (!(pkg instanceof ZigPackage)) return;

        const ctx = publishContext(pkg, plan);
        if (publishStrategy.resolveStatus) {
          const status = await publishStrategy.resolveStatus.call(this, ctx);
          return status === "success" || status === "pending" ? status : undefined;
        }

        if (publishStrategy.type === "git-tag" && packagePlan.git?.tag) {
          return;
        }

        return "pending";
      });
    },
    async publish({ pkg, plan }) {
      if (!(pkg instanceof ZigPackage) || !publishStrategy) return;

      const ctx = publishContext(pkg, plan);
      switch (publishStrategy.type) {
        case "git-tag":
          if (!ctx.tag) {
            return {
              type: "failed",
              error:
                "Zig git-tag publishing requires the git, github, or gitlab plugin to provide a release tag.",
            };
          }

          return { type: "published" };
        case "custom":
          return (await publishStrategy.publish.call(this, ctx)) ?? { type: "published" };
      }
    },
    async applyDraft(draft) {
      if (!active) return;

      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof ZigPackage)) continue;

        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped) pkg.setVersion(bumped);
      }

      const writes: Promise<void>[] = [];
      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof ZigPackage)) continue;

        for (const ref of dependencyRefs(this.graph, pkg)) {
          if (!ref.linked.version || !ref.version || !ref.setVersion) continue;
          if (satisfiesRange(ref.linked.version, ref.version)) continue;

          ref.setVersion(updateConstraintRange(ref.version, ref.linked.version));
        }

        writes.push(pkg.write());
      }

      await Promise.all(writes);
    },
  };
}

type NormalizedZigPublishOptions =
  | Exclude<ZigPublishOptions, false | "git-tag">
  | {
      type: "git-tag";
      shouldPublish?: ZigShouldPublish;
      waitForDependencies?: ZigPublishWaitMode;
      resolveStatus?: (this: TegamiContext, opts: ZigPublishContext) => Awaitable<ZigPublishStatus>;
    };

function normalizePublishOptions(
  options: ZigPublishOptions,
): NormalizedZigPublishOptions | undefined {
  if (options === false) return;
  if (options === "git-tag") return { type: "git-tag" };
  return options;
}

async function resolveShouldPublish(
  this: TegamiContext,
  strategy: NormalizedZigPublishOptions | undefined,
  opts: ZigPublishContext,
): Promise<boolean> {
  if (!strategy || !opts.pkg.version) return false;

  const { shouldPublish = true } = strategy;
  if (typeof shouldPublish === "boolean") return shouldPublish;
  return shouldPublish.call(this, opts);
}

function dependencyWaits(
  mode: ZigPublishWaitMode,
  ids: string[],
): { wait?: string[]; optionalWait?: string[] } {
  if (mode === false || ids.length === 0) return {};
  if (mode === "required") return { wait: ids };
  return { optionalWait: ids };
}

function publishContext(pkg: ZigPackage, plan: PublishPlan): ZigPublishContext {
  return {
    pkg,
    plan,
    tag: plan.packages.get(pkg.id)?.git?.tag,
  };
}

function depsPolicy(
  { graph }: TegamiContext,
  getBumpDepType: ZigPluginOptions["bumpDep"] = () => "patch",
): DraftPolicy {
  const dependentMap = new Map<string, ZigDependencyRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof ZigPackage)) continue;

    for (const ref of dependencyRefs(graph, pkg)) {
      const refs = dependentMap.get(ref.linked.id);
      if (refs) refs.push(ref);
      else dependentMap.set(ref.linked.id, [ref]);
    }
  }

  return {
    id: "zig:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof ZigPackage)) return;
      const deps = dependentMap.get(pkg.id);
      if (!deps) return;

      const bumped = plan.bumpVersion(pkg);
      if (!bumped) return;

      for (const dep of deps) {
        if (pkg.group?.options.syncBump && dep.dependent.group === pkg.group) {
          continue;
        }

        if (dep.version && satisfiesRange(bumped, dep.version)) continue;

        const bumpType = getBumpDepType(dep);
        if (bumpType === false) continue;

        this.bumpPackage(dep.dependent, {
          type: bumpType,
          reason: `update dependency "${pkg.name}"`,
        });
      }
    },
  };
}

function dependencyRefs(graph: PackageGraph, pkg: ZigPackage): ZigDependencyRef[] {
  const dependencies = getField(pkg.file.root, "dependencies")?.value;
  if (dependencies?.kind !== "object") return [];

  const out: ZigDependencyRef[] = [];
  for (const field of dependencies.fields) {
    if (field.value.kind !== "object") continue;

    const pathValue = getField(field.value, "path")?.value;
    if (pathValue?.kind !== "string") continue;

    const linked = resolveLinkedPackage(graph, pkg, pathValue.value);
    if (!linked || linked === pkg) continue;

    const versionNode = getField(field.value, "version")?.value;
    const ref: ZigDependencyRef = {
      dependent: pkg,
      name: field.name,
      spec: field.value,
      linked,
    };

    if (versionNode?.kind === "string") {
      ref.version = versionNode.value;
      ref.setVersion = (version) => {
        versionNode.value = version;
        replaceNode(pkg.file, versionNode, printZigString(version));
      };
    }

    out.push(ref);
  }

  return out;
}

function resolveLinkedPackage(
  graph: PackageGraph,
  pkg: ZigPackage,
  depPath: string,
): ZigPackage | undefined {
  const absolute = normalizeDirPath(path.resolve(pkg.path, depPath));

  return graph
    .getPackages()
    .find(
      (candidate): candidate is ZigPackage =>
        candidate instanceof ZigPackage && normalizeDirPath(candidate.path) === absolute,
    );
}

async function discoverZigPackages(cwd: string, workspace: string[]): Promise<ZigPackage[]> {
  const files = new Map<string, ZonFile>();
  await collectZigPackage(cwd, files);

  if (workspace.length > 0) {
    const dirs = await glob(workspace, {
      absolute: true,
      cwd,
      ignore: ["**/.zig-cache/**", "**/zig-out/**"],
      onlyDirectories: true,
      onlyFiles: false,
    });

    await Promise.all(dirs.map((dir) => collectZigPackage(dir, files)));
  }

  const packages: ZigPackage[] = [];
  for (const file of files.values()) {
    const name = getField(file.root, "name")?.value;
    if (name?.kind !== "string" && name?.kind !== "enum") continue;
    packages.push(new ZigPackage(file.dir, file));
  }

  return packages;
}

async function collectZigPackage(dir: string, files: Map<string, ZonFile>): Promise<void> {
  const file = await readZonFile(dir);
  if (!file || files.has(file.path)) return;

  files.set(file.path, file);

  const dependencies = getField(file.root, "dependencies")?.value;
  if (dependencies?.kind !== "object") return;

  await Promise.all(
    dependencies.fields.map(async (field) => {
      if (field.value.kind !== "object") return;

      const depPath = getField(field.value, "path")?.value;
      if (depPath?.kind !== "string") return;

      await collectZigPackage(path.resolve(file.dir, depPath.value), files);
    }),
  );
}

async function readZonFile(dir: string): Promise<ZonFile | undefined> {
  const normalized = normalizeDirPath(dir);
  const filePath = path.join(normalized, "build.zig.zon");

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }

  return {
    path: filePath,
    dir: normalized,
    content,
    root: parseZonObject(content),
    patches: [],
  };
}

function isMissingFileError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;

  return code === "ENOENT" || code === "ENOTDIR";
}

function updateConstraintRange(range: string, version: string): string {
  const trimmed = range.trim();

  if (trimmed.startsWith("^")) return `^${version}`;
  if (trimmed.startsWith("~")) return `~${version}`;
  return version;
}

function satisfiesRange(version: string, range: string): boolean {
  return semver.validRange(range, { loose: true }) !== null
    ? semver.satisfies(version, range, { includePrerelease: true, loose: true })
    : version === range;
}

function normalizeDirPath(dir: string): string {
  const resolved = path.resolve(dir);
  return resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
}
