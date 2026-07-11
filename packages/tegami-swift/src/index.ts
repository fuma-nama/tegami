import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import * as semver from "semver";
import { x } from "tinyexec";
import { glob } from "tinyglobby";
import typia from "typia";
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

const DEFAULT_GLOBS = ["**/Package.swift"];
const IGNORED_GLOBS = ["**/.build/**", "**/node_modules/**", "**/Pods/**"];
const REQUIRED_PLUGINS = ["git", "github", "gitlab"];

interface SwiftManifest {
  /** The package name declared in the `Package(...)` initializer. */
  name: string;
  /** Relative paths of local `.package(path: ...)` dependencies. */
  dependencyPaths: string[];
}

export class SwiftPackage extends WorkspacePackage {
  readonly manager = "swift";
  private versionValue: string;

  constructor(
    readonly path: string,
    readonly manifest: SwiftManifest,
    version: string,
  ) {
    super();
    this.versionValue = version;
  }

  get name(): string {
    return this.manifest.name;
  }

  get version(): string {
    return this.versionValue;
  }

  setVersion(version: string): void {
    this.versionValue = version;
  }
}

export interface DependentRef {
  /** The package that depends on {@link linked}. */
  dependent: SwiftPackage;
  /** The name of the depended-on workspace package. */
  name: string;
  /** The resolved workspace package. */
  linked: SwiftPackage;
}

export interface SwiftPluginOptions {
  /**
   * Glob patterns used to discover `Package.swift` manifests.
   *
   * @default ["**\/Package.swift"]
   */
  packages?: string[];

  /**
   * Prefix prepended to the semver portion of created git tags.
   *
   * SwiftPM accepts both `1.2.3` and `v1.2.3`; the default is a bare version.
   *
   * @default ""
   */
  tagPrefix?: string;

  /**
   * Decide how to bump packages that depend on a bumped local Swift package.
   *
   * @default "patch" for every local `.package(path: ...)` dependency
   */
  bumpDep?: (opts: DependentRef) => BumpType | false;

  /**
   * Whether a package should be published (i.e. have a git tag created).
   *
   * Provide a boolean, or a function to decide per package. Since Tegami's core
   * `PackageOptions` cannot be extended by external plugins, this replaces Go's
   * `packages.go.publish` option.
   *
   * @default true
   */
  publish?: boolean | ((pkg: SwiftPackage) => boolean);
}

interface SwiftPackageLock {
  id: string;
  version: string;
}

const validateSwiftPackageLock: (input: unknown) => typia.IValidation<SwiftPackageLock> =
  typia.createValidate<SwiftPackageLock>();

/**
 * Plugin for Swift Package Manager.
 *
 * SwiftPM has no version field in its manifest — package versions are git tags,
 * exactly like Go modules. This plugin therefore mirrors the Go plugin:
 *
 * - The current version is resolved from git tags (or the publish lock at publish time).
 * - `tegami version` stores the next version in the publish lock, not in `Package.swift`.
 * - Publishing creates git tags, delegated to the git/github/gitlab plugin.
 */
export function swift({
  packages: packageGlobs = DEFAULT_GLOBS,
  tagPrefix = "",
  bumpDep: getBumpDepType,
  publish: publishOption = true,
}: SwiftPluginOptions = {}): TegamiPlugin {
  let active = false;

  const shouldPublish = (pkg: SwiftPackage): boolean =>
    typeof publishOption === "function" ? publishOption(pkg) : publishOption;

  return {
    name: "swift",
    async resolve() {
      const packages = await discoverSwiftPackages(this.cwd, packageGlobs, tagPrefix);
      for (const pkg of packages) this.graph.add(pkg);
      active = this.graph.getPackages().some((pkg) => pkg instanceof SwiftPackage);

      if (active && !this.plugins.some((plugin) => REQUIRED_PLUGINS.includes(plugin.name))) {
        throw new Error(
          'The swift plugin requires the git plugin. Add git() from "tegami/plugins/git" to your plugins array.',
        );
      }
    },
    initDraft(draft) {
      if (!active) return;
      draft.addPolicy(depsPolicy(this, getBumpDepType));
    },
    async applyDraft(draft) {
      if (!active) return;

      // SwiftPM stores no version in the manifest, and local path dependencies
      // carry no version constraint, so there is nothing to write to disk —
      // the bumped version is only kept in memory and persisted to the lock.
      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof SwiftPackage)) continue;

        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped) pkg.setVersion(bumped);
      }
    },
    initPublishLock({ lock, draft }) {
      if (!active) return;

      for (const id of draft.getPackageDrafts().keys()) {
        const pkg = this.graph.get(id);
        if (!(pkg instanceof SwiftPackage)) continue;

        lock.write("swift:packages", {
          id,
          version: pkg.version,
        } satisfies SwiftPackageLock);
      }
    },
    initPublishPlan({ lock, plan }) {
      if (!active) return;

      const lockVersions = new Map<string, string>();
      let data: unknown;
      while ((data = lock.read("swift:packages"))) {
        const { success, data: parsed } = validateSwiftPackageLock(data);
        if (!success) continue;

        lockVersions.set(parsed.id, parsed.version);
      }

      for (const [id, packagePlan] of plan.packages) {
        const pkg = this.graph.get(id);
        if (!(pkg instanceof SwiftPackage)) continue;

        const version = packagePlan.updated && lockVersions.get(id);
        if (version) pkg.setVersion(version);

        packagePlan.git ??= {};
        packagePlan.git.tag = formatSwiftTag(this.cwd, pkg.path, tagPrefix, pkg.version);
      }
    },
    publishPreflight({ pkg }) {
      if (!(pkg instanceof SwiftPackage)) return;

      const wait = dependencyRefs(this.graph, pkg).map((ref) => ref.linked.id);

      return {
        shouldPublish: shouldPublish(pkg),
        wait,
      };
    },
    resolvePlanStatus({ plan }) {
      if (!active) return;

      return Array.from(plan.packages, async ([id, packagePlan]) => {
        if (!packagePlan.preflight?.shouldPublish) return;

        const pkg = this.graph.get(id);
        if (!(pkg instanceof SwiftPackage)) return;

        const tag = packagePlan.git?.tag;
        if (tag && !(await isTagCreated(this.cwd, tag))) return "pending";
      });
    },
    async publish({ pkg, plan }): Promise<PackagePublishResult | undefined> {
      if (!(pkg instanceof SwiftPackage)) return;

      const tag = plan.packages.get(pkg.id)?.git?.tag;
      if (tag && (await isTagCreated(this.cwd, tag))) {
        return { type: "skipped" };
      }

      // The git/github/gitlab plugin creates the tag from `packagePlan.git.tag`.
      return { type: "published" };
    },
  };
}

function depsPolicy(
  { graph }: TegamiContext,
  getBumpDepType: SwiftPluginOptions["bumpDep"] = () => "patch",
): DraftPolicy {
  const dependentMap = new Map<string, DependentRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof SwiftPackage)) continue;

    for (const ref of dependencyRefs(graph, pkg)) {
      const refs = dependentMap.get(ref.linked.id);
      if (refs) refs.push(ref);
      else dependentMap.set(ref.linked.id, [ref]);
    }
  }

  return {
    id: "swift:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof SwiftPackage)) return;
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

function dependencyRefs(graph: PackageGraph, pkg: SwiftPackage): DependentRef[] {
  const refs: DependentRef[] = [];

  for (const depPath of pkg.manifest.dependencyPaths) {
    const linked = resolveLinkedPackage(graph, pkg, depPath);
    if (!linked || linked === pkg) continue;

    refs.push({ dependent: pkg, name: linked.name, linked });
  }

  return refs;
}

/** Lazily built per-graph path index, so dependency resolution is O(1) instead of a scan per entry. */
const pathIndexes = new WeakMap<PackageGraph, Map<string, SwiftPackage>>();

function resolveLinkedPackage(
  graph: PackageGraph,
  pkg: SwiftPackage,
  depPath: string,
): SwiftPackage | undefined {
  let index = pathIndexes.get(graph);
  if (!index) {
    index = new Map();
    for (const candidate of graph.getPackages()) {
      if (candidate instanceof SwiftPackage) index.set(candidate.path, candidate);
    }
    pathIndexes.set(graph, index);
  }

  return index.get(resolve(pkg.path, depPath));
}

async function discoverSwiftPackages(
  cwd: string,
  packageGlobs: string[],
  tagPrefix: string,
): Promise<SwiftPackage[]> {
  const files = await glob(packageGlobs, {
    absolute: true,
    cwd,
    ignore: IGNORED_GLOBS,
    onlyFiles: true,
  });

  const tags = await listTags(cwd);
  const packages = await Promise.all(
    files.map(async (file) => {
      const manifest = await readManifest(file);
      if (!manifest) return;

      const path = resolve(dirname(file));
      const version = latestVersion(tags, cwd, path, tagPrefix);
      return new SwiftPackage(path, manifest, version);
    }),
  );

  return packages.filter((pkg): pkg is SwiftPackage => pkg !== undefined);
}

async function readManifest(file: string): Promise<SwiftManifest | undefined> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }

  return parseManifest(content);
}

/**
 * Parse the package name and local dependency paths from a `Package.swift` file.
 *
 * The name is the first `name:` argument at the `Package(...)` initializer level.
 * This is a pragmatic, targeted parse rather than a full Swift parser: we locate
 * the `Package(` initializer and take the first `name: "..."` after it (the
 * package name is always the initializer's first argument), which avoids matching
 * target or product names.
 */
export function parseManifest(content: string): SwiftManifest | undefined {
  const packageMatch = /\bPackage\s*\(/.exec(content);
  if (!packageMatch) return;

  const afterPackage = content.slice(packageMatch.index + packageMatch[0].length);
  const nameMatch = /name\s*:\s*"([^"]+)"/.exec(afterPackage);
  if (!nameMatch?.[1]) return;

  const dependencyPaths: string[] = [];
  const depPattern = /\.package\s*\(\s*(?:name\s*:\s*"[^"]*"\s*,\s*)?path\s*:\s*"([^"]+)"/g;
  let dep: RegExpExecArray | null;
  while ((dep = depPattern.exec(content))) {
    if (dep[1]) dependencyPaths.push(dep[1]);
  }

  return { name: nameMatch[1], dependencyPaths };
}

/** List every tag in the repository once, newest version first. */
async function listTags(cwd: string): Promise<string[]> {
  const result = await x("git", ["tag", "--list", "--sort=-v:refname"], {
    nodeOptions: { cwd },
  });
  if (result.exitCode !== 0) return [];

  return result.stdout
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function latestVersion(tags: string[], cwd: string, path: string, tagPrefix: string): string {
  for (const tag of tags) {
    const version = parseTagVersion(tag, cwd, path, tagPrefix);
    if (version) return version;
  }

  return "0.0.0";
}

function relativeDir(cwd: string, path: string): string {
  return relative(cwd, path).replaceAll("\\", "/");
}

function formatSwiftTag(cwd: string, path: string, tagPrefix: string, version: string): string {
  const dir = relativeDir(cwd, path);
  return dir === "" ? `${tagPrefix}${version}` : `${dir}/${tagPrefix}${version}`;
}

function parseTagVersion(
  tag: string,
  cwd: string,
  path: string,
  tagPrefix: string,
): string | undefined {
  const dir = relativeDir(cwd, path);
  const expectedPrefix = dir === "" ? tagPrefix : `${dir}/${tagPrefix}`;
  if (!tag.startsWith(expectedPrefix)) return;

  const rest = tag.slice(expectedPrefix.length);
  // For a root package with a bare prefix, the `*` glob also matches
  // subdirectory tags (e.g. `pkg/foo/1.0.0`); reject anything with a path segment.
  if (rest.includes("/")) return;
  if (semver.valid(rest)) return rest;
}

export async function isTagCreated(cwd: string, tag: string): Promise<boolean> {
  const local = await x("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    nodeOptions: { cwd },
  });
  if (local.exitCode === 0) return true;

  // the tag may exist only on the remote (e.g. a shallow checkout without
  // tags fetched) — mirror the git plugin's ls-remote fallback.
  const origin = await x(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
    { nodeOptions: { cwd } },
  );
  return origin.exitCode === 0;
}

function isMissingFileError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;

  return code === "ENOENT" || code === "ENOTDIR";
}
