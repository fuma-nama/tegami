import path from "node:path";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { BumpType, DraftPolicy, PackageGraph, TegamiContext, TegamiPlugin } from "tegami";
import { WorkspacePackage } from "tegami";
import { execFailure, fetchFailure, joinPath } from "tegami/utils";
import { readMix, writeMix, type Edit, type MixFile } from "./mix";
import { satisfiesRequirement, updateRequirement } from "./requirement";
import { assertHexRegistryPackage } from "./schema";

const DEFAULT_API_URL = "https://hex.pm/api";

export class HexPackage extends WorkspacePackage {
  readonly manager = "hex";
  /** pending byte-span edits to apply on write */
  readonly edits: Edit[] = [];

  constructor(
    readonly path: string,
    readonly file: MixFile,
  ) {
    super();
  }

  get name(): string {
    if (!this.file.app) {
      throw new Error(`Invalid mix.exs in "${this.path}": missing \`app: :name\`.`);
    }
    return this.file.app;
  }

  get version(): string | undefined {
    return this.file.version;
  }

  setVersion(version: string): void {
    if (!this.file.versionSpan) return;
    this.file.version = version;
    this.edits.push({ ...this.file.versionSpan, replacement: version });
  }

  async write(): Promise<void> {
    await writeMix(this.file, this.edits);
  }
}

export interface HexDependencyRef {
  dependent: HexPackage;
  /** dependency app name */
  name: string;
  linked: HexPackage;
  /** dev/test dependency (`only:` present) */
  dev: boolean;
  requirement?: string;
  /** rewrite the requirement literal in the dependent's mix.exs */
  setRequirement?: (requirement: string) => void;
}

export interface HexPluginOptions {
  /**
   * Additional package directories or glob patterns to discover, for non-umbrella
   * monorepos where each directory contains its own `mix.exs`.
   */
  packages?: string[];

  /**
   * Base URL of the Hex API, for self-hosted registries.
   *
   * @default "https://hex.pm/api"
   */
  apiUrl?: string;

  /**
   * Decide how to bump packages that depend on a bumped local Hex package.
   *
   * @default "patch" for runtime deps, `false` for dev/test deps (`only:`).
   */
  bumpDep?: (opts: HexDependencyRef) => BumpType | false;

  /**
   * Override whether a package should be published. By default a package is
   * publishable when its `mix.exs` declares a `package:` key or `package/0`.
   */
  publish?: (pkg: HexPackage) => boolean;
}

export function hex({
  packages: packageGlobs = [],
  apiUrl = DEFAULT_API_URL,
  bumpDep: getBumpDepType,
  publish: isPublishable,
}: HexPluginOptions = {}): TegamiPlugin {
  let active = false;

  return {
    name: "hex",
    async resolve() {
      const packages = await discoverHexPackages(this.cwd, packageGlobs);
      for (const pkg of packages) this.graph.add(pkg);
      active = packages.length > 0;
    },
    initDraft(draft) {
      if (!active) return;
      draft.addPolicy(depsPolicy(this, getBumpDepType));
    },
    publishPreflight({ pkg }) {
      if (!(pkg instanceof HexPackage)) return;

      const wait = dependencyRefs(this.graph, pkg)
        .filter((ref) => !ref.dev)
        .map((ref) => ref.linked.id);

      return {
        shouldPublish: pkg.version !== undefined && resolvePublishable(pkg, isPublishable),
        wait,
      };
    },
    resolvePlanStatus({ plan }) {
      return Array.from(plan.packages, async ([id, { preflight }]) => {
        if (!preflight?.shouldPublish) return;
        const pkg = this.graph.get(id);
        if (!(pkg instanceof HexPackage) || !pkg.version) return;
        if (!(await isPackagePublished(pkg.name, pkg.version, apiUrl))) return "pending";
      });
    },
    async publish({ pkg }) {
      if (!(pkg instanceof HexPackage)) return;

      const result = await x("mix", ["hex.publish", "--yes"], {
        nodeOptions: { cwd: pkg.path },
      });
      const combined = `${result.stdout}\n${result.stderr}`;

      // mix reports these when the exact version already exists on the registry
      if (/already been published|choose a new package version/i.test(combined)) {
        return { type: "skipped" };
      }

      if (result.exitCode !== 0) {
        return {
          type: "failed",
          error: execFailure(`Failed to publish ${pkg.name}@${pkg.version}.`, result).message,
        };
      }

      return { type: "published" };
    },
    async applyDraft(draft) {
      if (!active) return;

      // 1. version bumps (updates each package's resolved version + records edits)
      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof HexPackage)) continue;
        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped && bumped !== pkg.version) pkg.setVersion(bumped);
      }

      // 2. requirement rewrites (using the bumped linked versions)
      const writes: Promise<void>[] = [];
      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof HexPackage)) continue;

        for (const ref of dependencyRefs(this.graph, pkg)) {
          if (!ref.linked.version || !ref.requirement || !ref.setRequirement) continue;
          if (satisfiesRequirement(ref.linked.version, ref.requirement)) continue;
          ref.setRequirement(updateRequirement(ref.requirement, ref.linked.version));
        }

        writes.push(pkg.write());
      }

      await Promise.all(writes);
    },
  };
}

function resolvePublishable(pkg: HexPackage, override: HexPluginOptions["publish"]): boolean {
  if (override) return override(pkg);
  const content = pkg.file.content;
  return /\bpackage:\s*/.test(content) || /\bdef(?:p)?\s+package\b/.test(content);
}

function depsPolicy(
  { graph }: TegamiContext,
  getBumpDepType: HexPluginOptions["bumpDep"] = ({ dev }) => (dev ? false : "patch"),
): DraftPolicy {
  const dependentMap = new Map<string, HexDependencyRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof HexPackage)) continue;

    for (const ref of dependencyRefs(graph, pkg)) {
      const refs = dependentMap.get(ref.linked.id);
      if (refs) refs.push(ref);
      else dependentMap.set(ref.linked.id, [ref]);
    }
  }

  return {
    id: "hex:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof HexPackage)) return;
      const deps = dependentMap.get(pkg.id);
      if (!deps) return;

      const bumped = plan.bumpVersion(pkg);
      if (!bumped) return;

      for (const dep of deps) {
        if (pkg.group?.options.syncBump && dep.dependent.group === pkg.group) {
          continue;
        }

        // when a requirement still accepts the new version, nothing changes for
        // the dependent, so no release is needed (umbrella / path deps without a
        // requirement always bump).
        if (dep.requirement && satisfiesRequirement(bumped, dep.requirement)) continue;

        const bumpType = getBumpDepType(dep);
        if (bumpType === false) continue;

        this.bumpPackage(dep.dependent, {
          type: bumpType,
          reason: `update dependency "${dep.name}"`,
        });
      }
    },
  };
}

function dependencyRefs(graph: PackageGraph, pkg: HexPackage): HexDependencyRef[] {
  const refs: HexDependencyRef[] = [];

  for (const dep of pkg.file.deps) {
    const linked = resolveLinkedPackage(graph, pkg, dep.name, dep.relativePath);
    if (!linked || linked === pkg) continue;

    const ref: HexDependencyRef = {
      dependent: pkg,
      name: dep.name,
      linked,
      dev: dep.dev,
      requirement: dep.requirement,
    };

    if (dep.requirementSpan) {
      const span = dep.requirementSpan;
      ref.setRequirement = (requirement) => {
        pkg.edits.push({ ...span, replacement: requirement });
      };
    }

    refs.push(ref);
  }

  return refs;
}

function resolveLinkedPackage(
  graph: PackageGraph,
  pkg: HexPackage,
  name: string,
  relativePath: string | undefined,
): HexPackage | undefined {
  const packages = graph.getPackages();

  const byName = packages.find(
    (candidate): candidate is HexPackage =>
      candidate instanceof HexPackage && candidate.name === name,
  );
  if (byName && byName !== pkg) return byName;

  if (relativePath) {
    const absolute = normalizeDirPath(path.resolve(pkg.path, relativePath));
    const byPath = packages.find(
      (candidate): candidate is HexPackage =>
        candidate instanceof HexPackage && normalizeDirPath(candidate.path) === absolute,
    );
    if (byPath && byPath !== pkg) return byPath;
  }

  return undefined;
}

async function discoverHexPackages(cwd: string, packageGlobs: string[]): Promise<HexPackage[]> {
  const files = new Map<string, MixFile>();
  const root = await readMix(cwd);

  // umbrella children (`apps_path: "apps"` → discover `apps/*`)
  if (root?.appsPath) {
    const dirs = await glob([`${root.appsPath}/*`], {
      absolute: true,
      cwd,
      onlyDirectories: true,
      onlyFiles: false,
      ignore: ["**/_build/**", "**/deps/**"],
    });
    await Promise.all(
      dirs.map(async (dir) => {
        const file = await readMix(dir);
        if (file) files.set(file.path, file);
      }),
    );
  }

  // explicit package globs for non-umbrella monorepos
  if (packageGlobs.length > 0) {
    const dirs = await glob(packageGlobs, {
      absolute: true,
      cwd,
      onlyDirectories: true,
      onlyFiles: false,
      ignore: ["**/_build/**", "**/deps/**"],
    });
    await Promise.all(
      dirs.map(async (dir) => {
        const file = await readMix(dir);
        if (file) files.set(file.path, file);
      }),
    );
  }

  // include the root when it is an app itself (not just an umbrella shell)
  if (root && root.app && root.version !== undefined) {
    files.set(root.path, root);
  }

  const out: HexPackage[] = [];
  for (const file of files.values()) {
    if (!file.app) continue;
    out.push(new HexPackage(file.dir, file));
  }
  return out;
}

export async function isPackagePublished(
  name: string,
  version: string,
  apiUrl: string,
): Promise<boolean> {
  const url = joinPath(apiUrl, "packages", encodeURIComponent(name));
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "tegami-hex",
    },
  });

  if (response.status === 404) return false;
  if (!response.ok) {
    throw await fetchFailure(`Unable to validate ${name}@${version} on ${apiUrl}`, response);
  }

  const body = assertHexRegistryPackage(await response.json());
  return body.releases?.some((entry) => entry.version === version) ?? false;
}

function normalizeDirPath(dir: string): string {
  const resolved = path.resolve(dir);
  return resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
}
