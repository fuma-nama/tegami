import { writeFile } from "node:fs/promises";
import path from "node:path";
import MagicString from "magic-string";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { BumpType, DraftPolicy, PackageGraph, TegamiContext, TegamiPlugin } from "tegami";
import { WorkspacePackage } from "tegami";
import { execFailure, fetchFailure, joinPath } from "tegami/utils";
import {
  parseGemspec,
  type DependencyKind,
  type RawDependency,
  type TextFile,
  type VersionRef,
} from "./gemspec";
import {
  formatRequirement,
  rewriteRequirement,
  satisfiesRequirement,
  satisfiesRequirements,
} from "./requirement";
import { assertGemVersions } from "./schema";

const DEFAULT_IGNORE = ["**/vendor/**", "**/node_modules/**", "**/tmp/**"];
const DEFAULT_REGISTRY = "https://rubygems.org";

export class GemPackage extends WorkspacePackage {
  readonly manager = "gem";

  constructor(
    readonly path: string,
    readonly name: string,
    /** the gemspec file name, e.g. `foo.gemspec`. */
    readonly gemspecFilename: string,
    readonly gemspecFile: TextFile,
    readonly versionRef: VersionRef | undefined,
    readonly dependencies: RawDependency[],
  ) {
    super();
  }

  get version(): string | undefined {
    return this.versionRef?.value;
  }

  setVersion(version: string): void {
    const ref = this.versionRef;
    if (!ref) return;

    ref.file.edits.push({ start: ref.start, end: ref.end, value: version });
    ref.value = version;
  }

  async write(): Promise<void> {
    const files = new Set<TextFile>([this.gemspecFile]);
    // the version literal may live in a separate `version.rb` file
    if (this.versionRef) files.add(this.versionRef.file);

    await Promise.all(
      Array.from(files, async (file) => {
        if (file.edits.length === 0) return;

        // splice the located spans, so comments and formatting survive untouched
        const s = new MagicString(file.content);
        for (const edit of file.edits) s.update(edit.start, edit.end, edit.value);
        await writeFile(file.path, s.toString());
      }),
    );
  }
}

interface GemDependencyRef {
  dependent: GemPackage;
  kind: DependencyKind;
  name: string;
  dependency: RawDependency;
  linked: GemPackage;
}

export interface GemPluginOptions {
  /**
   * Directory globs to search for gems. Each matched directory is scanned for a `*.gemspec` file.
   *
   * When omitted, Tegami globs `**\/*.gemspec` from the workspace root.
   */
  packages?: string[];

  /**
   * RubyGems-compatible registry used for publishing and status checks.
   *
   * Passed to `gem push` as `--host`.
   *
   * @default "https://rubygems.org"
   */
  registry?: string;

  /**
   * Decide how to bump the dependents of a bumped package.
   *
   * @default `patch` for runtime dependencies, `false` for development dependencies
   */
  bumpDep?: (opts: GemDependencyRef) => BumpType | false;
}

export function gem({
  packages,
  registry,
  bumpDep: getBumpDepType,
}: GemPluginOptions = {}): TegamiPlugin {
  let active = false;

  return {
    name: "gem",
    async resolve() {
      const discovered = await discoverGemPackages(this.cwd, packages);
      for (const pkg of discovered) this.graph.add(pkg);
      active = discovered.length > 0;
    },
    initDraft(draft) {
      if (!active) return;
      draft.addPolicy(depsPolicy(this, getBumpDepType));
    },
    publishPreflight({ pkg }) {
      if (!(pkg instanceof GemPackage)) return;

      const wait = dependencyRefs(this.graph, pkg)
        .filter((ref) => ref.kind === "runtime")
        .map((ref) => ref.linked.id);

      return {
        shouldPublish: pkg.version !== undefined,
        wait,
      };
    },
    resolvePlanStatus({ plan }) {
      return Array.from(plan.packages, async ([id, { preflight }]) => {
        if (!preflight!.shouldPublish) return;
        const pkg = this.graph.get(id);
        if (!(pkg instanceof GemPackage) || !pkg.version) return;
        if (!(await isGemVersionPublished(pkg.name, pkg.version, registry))) return "pending";
      });
    },
    async publish({ pkg }) {
      if (!(pkg instanceof GemPackage)) return;
      if (!pkg.version) return;

      const build = await x("gem", ["build", pkg.gemspecFilename], {
        nodeOptions: { cwd: pkg.path },
      });
      if (build.exitCode !== 0) {
        return {
          type: "failed",
          error: execFailure(`Failed to build ${pkg.name}@${pkg.version}.`, build).message,
        };
      }

      const gemFile = `${pkg.name}-${pkg.version}.gem`;
      const push = await x("gem", ["push", gemFile, ...(registry ? ["--host", registry] : [])], {
        nodeOptions: { cwd: pkg.path },
      });
      if (push.exitCode !== 0) {
        const output = `${push.stdout}\n${push.stderr}`;
        if (/Repushing of gem versions is not allowed/i.test(output)) {
          return { type: "skipped" };
        }

        return {
          type: "failed",
          error: execFailure(`Failed to publish ${pkg.name}@${pkg.version}.`, push).message,
        };
      }

      return { type: "published" };
    },
    async applyDraft(draft) {
      if (!active) return;

      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof GemPackage)) continue;

        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped) pkg.setVersion(bumped);
      }

      const writes: Promise<void>[] = [];
      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof GemPackage)) continue;

        for (const ref of dependencyRefs(this.graph, pkg)) {
          const version = ref.linked.version;
          if (!version) continue;

          const requirements = ref.dependency.requirements;
          if (requirements.length === 0) continue;
          if (
            satisfiesRequirements(
              version,
              requirements.map((item) => item.parsed),
            )
          )
            continue;

          for (const literal of requirements) {
            if (satisfiesRequirement(version, literal.parsed)) continue;

            const rewritten = rewriteRequirement(literal.parsed, version);
            pkg.gemspecFile.edits.push({
              start: literal.start,
              end: literal.end,
              value: formatRequirement(rewritten),
            });
          }
        }

        writes.push(pkg.write());
      }

      await Promise.all(writes);
    },
  };
}

function depsPolicy(
  { graph }: TegamiContext,
  getBumpDepType: GemPluginOptions["bumpDep"] = ({ kind }) =>
    kind === "runtime" ? "patch" : false,
): DraftPolicy {
  const dependentMap = new Map<string, GemDependencyRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof GemPackage)) continue;

    for (const ref of dependencyRefs(graph, pkg)) {
      const refs = dependentMap.get(ref.linked.id);
      if (refs) refs.push(ref);
      else dependentMap.set(ref.linked.id, [ref]);
    }
  }

  return {
    id: "gem:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof GemPackage)) return;
      const deps = dependentMap.get(pkg.id);
      if (!deps) return;

      const bumped = plan.bumpVersion(pkg);
      if (!bumped) return;

      for (const dep of deps) {
        if (pkg.group?.options.syncBump && dep.dependent.group === pkg.group) {
          continue;
        }

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

function dependencyRefs(graph: PackageGraph, pkg: GemPackage): GemDependencyRef[] {
  const refs: GemDependencyRef[] = [];

  for (const dependency of pkg.dependencies) {
    const linked = resolveLinkedPackage(graph, dependency.name);
    if (!linked || linked === pkg) continue;

    refs.push({
      dependent: pkg,
      kind: dependency.kind,
      name: dependency.name,
      dependency,
      linked,
    });
  }

  return refs;
}

/** Lazily built per-graph name index, so dependency resolution is O(1) instead of a scan per entry. */
const nameIndexes = new WeakMap<PackageGraph, Map<string, GemPackage>>();

function resolveLinkedPackage(graph: PackageGraph, name: string): GemPackage | undefined {
  let index = nameIndexes.get(graph);
  if (!index) {
    index = new Map();
    for (const pkg of graph.getPackages()) {
      if (pkg instanceof GemPackage) index.set(pkg.name, pkg);
    }
    nameIndexes.set(graph, index);
  }
  return index.get(name);
}

async function discoverGemPackages(cwd: string, packages?: string[]): Promise<GemPackage[]> {
  const gemspecPaths = await findGemspecPaths(cwd, packages);

  // one gem per directory: keep the first gemspec found in each directory.
  const byDir = new Map<string, string>();
  for (const gemspecPath of gemspecPaths.sort()) {
    const dir = path.dirname(gemspecPath);
    if (!byDir.has(dir)) byDir.set(dir, gemspecPath);
  }

  const out: GemPackage[] = [];
  await Promise.all(
    Array.from(byDir.values(), async (gemspecPath) => {
      const parsed = await parseGemspec(gemspecPath);
      if (!parsed.name) return; // computed/dynamic name — cannot manage this gem.

      out.push(
        new GemPackage(
          path.dirname(gemspecPath),
          parsed.name,
          path.basename(gemspecPath),
          parsed.gemspecFile,
          parsed.version,
          parsed.dependencies,
        ),
      );
    }),
  );

  return out;
}

async function findGemspecPaths(cwd: string, packages?: string[]): Promise<string[]> {
  if (!packages) {
    return glob(["**/*.gemspec"], { cwd, absolute: true, ignore: DEFAULT_IGNORE });
  }

  const dirs = await glob(packages, {
    cwd,
    absolute: true,
    onlyDirectories: true,
    onlyFiles: false,
    ignore: DEFAULT_IGNORE,
  });

  const nested = await Promise.all(
    dirs.map((dir) => glob(["*.gemspec"], { cwd: dir, absolute: true })),
  );
  return nested.flat();
}

export async function isGemVersionPublished(
  name: string,
  version: string,
  registry = DEFAULT_REGISTRY,
): Promise<boolean> {
  const url = joinPath(registry, "api/v1/versions", `${encodeURIComponent(name)}.json`);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "tegami-gem",
    },
  });

  if (response.status === 404) return false;
  if (!response.ok) {
    throw await fetchFailure(`Unable to validate ${name}@${version} on ${registry}`, response);
  }

  const versions = assertGemVersions(await response.json());
  return versions.some((entry) => entry.number === version);
}
