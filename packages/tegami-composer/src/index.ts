import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type {
  BumpType,
  DraftPolicy,
  PackageGraph,
  TegamiContext,
  TegamiPlugin,
} from "tegami";
import { WorkspacePackage } from "tegami";
import { execFailure, fetchFailure, joinPath } from "tegami/utils";
import {
  assertComposerManifest,
  validateRegistryResponse,
  type ComposerManifest,
  type ComposerRepository,
} from "./schema";

const DEP_FIELDS = ["require", "require-dev"] as const;
const DEFAULT_REGISTRY = "https://repo.packagist.org";

export type ComposerDepField = (typeof DEP_FIELDS)[number];

interface ComposerFile {
  /** absolute path to composer.json */
  path: string;
  data: ComposerManifest;
  /** indentation string detected from the original file */
  indent: string;
  /** whether the original file ended with a trailing newline */
  trailingNewline: boolean;
}

export class ComposerPackage extends WorkspacePackage {
  readonly manager = "composer";
  private versionValue: string;

  constructor(
    readonly path: string,
    readonly file: ComposerFile,
    version: string,
  ) {
    super();
    this.versionValue = version;
  }

  get name(): string {
    return this.file.data.name!;
  }

  get version(): string {
    return this.versionValue;
  }

  /** whether composer.json carries an explicit `version` field. */
  get hasExplicitVersion(): boolean {
    return typeof this.file.data.version === "string";
  }

  setVersion(version: string): void {
    this.versionValue = version;
    // Packagist derives versions from git tags, but some packages still pin an
    // explicit `version`. Keep it in sync when present.
    if (this.hasExplicitVersion) this.file.data.version = version;
  }

  setConstraint(field: ComposerDepField, name: string, constraint: string): void {
    const table = this.file.data[field];
    if (table) table[name] = constraint;
  }

  async write(): Promise<void> {
    const serialized = JSON.stringify(this.file.data, null, this.file.indent);
    await writeFile(this.file.path, this.file.trailingNewline ? `${serialized}\n` : serialized);
  }
}

interface DependentRef {
  dependent: ComposerPackage;
  field: ComposerDepField;
  name: string;
  constraint: string;
  linked: ComposerPackage;
}

export interface ComposerPluginOptions {
  /**
   * Additional package directory globs to discover (relative to the workspace root).
   *
   * By default, members are collected from root `composer.json` `repositories`
   * entries with `"type": "path"`.
   */
  packages?: string[];

  /**
   * Prefix used when computing git tags. Packagist accepts both `v`-prefixed and
   * bare tags.
   *
   * Root package tags are `{tagPrefix}{version}` and subdirectory package tags are
   * `{relativeDir}/{tagPrefix}{version}` (matching git subtree split conventions).
   *
   * @default "v"
   */
  tagPrefix?: string;

  /**
   * Packagist-compatible registry base URL, or `false` to skip all registry
   * requests and rely purely on git tags.
   *
   * Used to detect already-published versions at publish time.
   *
   * @default "https://repo.packagist.org"
   */
  registry?: string | false;

  /**
   * Verify publication against the registry in `resolvePlanStatus`.
   *
   * Disabled by default: Packagist indexes a single package per repository, so a
   * monorepo package may never appear under `registry` and would otherwise block
   * the publish flow forever. When disabled, publish status relies on the git
   * plugin's tag-existence check.
   *
   * @default false
   */
  verifyRegistry?: boolean;

  /**
   * Run `composer update --lock` after versioning. Requires PHP and Composer to
   * be installed.
   *
   * @default false
   */
  updateLockFile?: boolean;

  /**
   * Decide how to bump packages that depend on a bumped workspace package.
   *
   * @default `require` → patch, `require-dev` → false
   */
  bumpDep?: (opts: DependentRef) => BumpType | false;
}

interface ComposerPackageLock {
  id: string;
  version: string;
}

export function composer({
  packages: packageGlobs = [],
  tagPrefix = "v",
  registry = DEFAULT_REGISTRY,
  verifyRegistry = false,
  updateLockFile = false,
  bumpDep: getBumpDepType,
}: ComposerPluginOptions = {}): TegamiPlugin {
  let active = false;

  return {
    name: "composer",
    async resolve() {
      const packages = await discoverComposerPackages(this.cwd, packageGlobs, tagPrefix);
      for (const pkg of packages) this.graph.add(pkg);
      active = packages.length > 0;

      if (active && !this.plugins.some((plugin) => plugin.name === "git")) {
        throw new Error(
          'The composer plugin requires the git plugin. Add git() from "tegami/plugins/git" to your plugins array.',
        );
      }
    },
    initDraft(draft) {
      if (!active) return;
      draft.addPolicy(depsPolicy(this, getBumpDepType));
    },
    async applyDraft(draft) {
      if (!active) return;

      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof ComposerPackage)) continue;

        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped) pkg.setVersion(bumped);
      }

      const writes: Promise<void>[] = [];
      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof ComposerPackage)) continue;

        for (const ref of dependencyRefs(this.graph, pkg)) {
          if (satisfiesConstraint(ref.linked.version, ref.constraint)) continue;

          pkg.setConstraint(ref.field, ref.name, updateConstraint(ref.constraint, ref.linked.version));
        }

        writes.push(pkg.write());
      }

      await Promise.all(writes);
    },
    initPublishLock({ lock, draft }) {
      if (!active) return;

      for (const id of draft.getPackageDrafts().keys()) {
        const pkg = this.graph.get(id);
        if (!(pkg instanceof ComposerPackage)) continue;

        lock.write("composer:packages", {
          id,
          version: pkg.version,
        } satisfies ComposerPackageLock);
      }
    },
    initPublishPlan({ lock, plan }) {
      if (!active) return;

      const lockVersions = new Map<string, string>();
      let data: unknown;
      while ((data = lock.read("composer:packages"))) {
        const entry = data as Partial<ComposerPackageLock>;
        if (typeof entry.id === "string" && typeof entry.version === "string") {
          lockVersions.set(entry.id, entry.version);
        }
      }

      for (const [id, packagePlan] of plan.packages) {
        const pkg = this.graph.get(id);
        if (!(pkg instanceof ComposerPackage)) continue;

        const version = packagePlan.updated && lockVersions.get(id);
        if (version) pkg.setVersion(version);

        packagePlan.git ??= {};
        packagePlan.git.tag = formatTag(this.cwd, pkg.path, pkg.version, tagPrefix);
      }
    },
    publishPreflight({ pkg }) {
      if (!(pkg instanceof ComposerPackage)) return;

      const wait = dependencyRefs(this.graph, pkg)
        .filter((ref) => ref.field === "require")
        .map((ref) => ref.linked.id);

      return {
        // Discovered packages always have a name; publishing means creating a git tag.
        shouldPublish: Boolean(pkg.file.data.name),
        wait,
      };
    },
    resolvePlanStatus({ plan }) {
      if (!active || registry === false || !verifyRegistry) return;

      return Array.from(plan.packages, async ([id, { preflight }]) => {
        if (!preflight!.shouldPublish) return;

        const pkg = this.graph.get(id);
        if (!(pkg instanceof ComposerPackage)) return;
        if (!(await isPackagePublished(registry, pkg.name, pkg.version))) return "pending";
      });
    },
    async publish({ pkg }) {
      if (!(pkg instanceof ComposerPackage)) return;

      if (registry !== false && (await isPackagePublished(registry, pkg.name, pkg.version))) {
        return { type: "skipped" };
      }

      // The git plugin creates the tag in `afterPublishAll`.
      return { type: "published" };
    },
    async applyCliDraft() {
      if (!active || !updateLockFile) return;

      const result = await x("composer", ["update", "--lock", "--no-install"], {
        nodeOptions: { cwd: this.cwd },
      });

      if (result.exitCode !== 0) {
        throw execFailure("Failed to run `composer update --lock`.", result);
      }
    },
  };
}

function depsPolicy(
  { graph }: TegamiContext,
  getBumpDepType: ComposerPluginOptions["bumpDep"] = ({ field }) =>
    field === "require" ? "patch" : false,
): DraftPolicy {
  const dependentMap = new Map<string, DependentRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof ComposerPackage)) continue;

    for (const ref of dependencyRefs(graph, pkg)) {
      const refs = dependentMap.get(ref.linked.id);
      if (refs) refs.push(ref);
      else dependentMap.set(ref.linked.id, [ref]);
    }
  }

  return {
    id: "composer:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof ComposerPackage)) return;
      const deps = dependentMap.get(pkg.id);
      if (!deps) return;

      const bumped = plan.bumpVersion(pkg);
      if (!bumped) return;

      for (const dep of deps) {
        if (pkg.group?.options.syncBump && dep.dependent.group === pkg.group) {
          continue;
        }

        if (satisfiesConstraint(bumped, dep.constraint)) continue;

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

function dependencyRefs(graph: PackageGraph, pkg: ComposerPackage): DependentRef[] {
  const refs: DependentRef[] = [];

  for (const field of DEP_FIELDS) {
    const table = pkg.file.data[field];
    if (!table) continue;

    for (const [name, constraint] of Object.entries(table)) {
      if (typeof constraint !== "string") continue;
      const linked = resolveLinkedPackage(graph, name);
      if (!linked || linked === pkg) continue;

      refs.push({ dependent: pkg, field, name, constraint, linked });
    }
  }

  return refs;
}

function resolveLinkedPackage(graph: PackageGraph, name: string): ComposerPackage | undefined {
  return graph
    .getPackages()
    .find(
      (candidate): candidate is ComposerPackage =>
        candidate instanceof ComposerPackage && candidate.name === name,
    );
}

/**
 * Translate a Composer version constraint into a semver range.
 *
 * Composer separates `AND` parts with commas or spaces and wildcards versions
 * with `*` (e.g. `1.2.*`). semver uses spaces and `x`.
 */
export function toSemverRange(constraint: string): string {
  return constraint
    .trim()
    .replace(/,/g, " ")
    .replace(/(\d+)\.\*/g, "$1.x");
}

export function satisfiesConstraint(version: string, constraint: string): boolean {
  const trimmed = constraint.trim();
  if (trimmed === "" || trimmed === "*") return true;

  const range = toSemverRange(trimmed);
  if (!semver.validRange(range, { loose: true })) return false;
  return semver.satisfies(version, range, { includePrerelease: true, loose: true });
}

/** Rewrite a constraint to accept `version`, preserving the operator style. */
export function updateConstraint(constraint: string, version: string): string {
  const trimmed = constraint.trim();

  if (trimmed.startsWith("^")) return `^${version}`;
  if (trimmed.startsWith("~")) return `~${version}`;

  const lowerBound = /^(>=|>)\s*([0-9A-Za-z.+-]+)/.exec(trimmed);
  if (lowerBound) return trimmed.replace(lowerBound[0], `${lowerBound[1]}${version}`);

  const wildcard = /^(\d+)(?:\.(\d+))?\.\*$/.exec(trimmed);
  if (wildcard) {
    const [major, minor] = version.split(".");
    return wildcard[2] !== undefined ? `${major}.${minor}.*` : `${major}.*`;
  }

  return version;
}

async function discoverComposerPackages(
  cwd: string,
  packageGlobs: string[],
  tagPrefix: string,
): Promise<ComposerPackage[]> {
  const root = await readComposerFile(cwd);

  const dirs = new Set<string>();
  if (root?.data.name) dirs.add(cwd);

  const patterns = [...packageGlobs, ...pathRepositoryGlobs(root?.data.repositories)];
  if (patterns.length > 0) {
    const matches = await glob(patterns, {
      absolute: true,
      cwd,
      ignore: ["**/vendor/**"],
      onlyDirectories: true,
      onlyFiles: false,
    });
    for (const dir of matches) dirs.add(normalizeDir(dir));
  }

  const files = new Map<string, ComposerFile>();
  await Promise.all(
    Array.from(dirs, async (dir) => {
      const file = dir === cwd ? root : await readComposerFile(dir);
      if (file?.data.name) files.set(file.path, file);
    }),
  );

  return Promise.all(
    Array.from(files.values(), async (file) => {
      const dir = path.dirname(file.path);
      const version = await readLatestVersion(cwd, dir, tagPrefix, file.data.version);
      return new ComposerPackage(dir, file, version);
    }),
  );
}

function pathRepositoryGlobs(
  repositories: ComposerManifest["repositories"],
): string[] {
  if (!repositories) return [];

  const entries: ComposerRepository[] = Array.isArray(repositories)
    ? repositories
    : Object.values(repositories);

  const globs: string[] = [];
  for (const entry of entries) {
    if (entry?.type === "path" && typeof entry.url === "string") globs.push(entry.url);
  }
  return globs;
}

async function readComposerFile(dir: string): Promise<ComposerFile | undefined> {
  const filePath = path.join(dir, "composer.json");

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return;
  }

  return {
    path: filePath,
    data: assertComposerManifest(JSON.parse(content)),
    indent: detectIndent(content),
    trailingNewline: content.endsWith("\n"),
  };
}

function detectIndent(content: string): string {
  const match = /^([ \t]+)\S/m.exec(content);
  return match ? match[1] : "    ";
}

async function readLatestVersion(
  cwd: string,
  pkgPath: string,
  tagPrefix: string,
  fallback: string | undefined,
): Promise<string> {
  const pattern = formatTag(cwd, pkgPath, "*", tagPrefix);
  const result = await x("git", ["tag", "--list", pattern, "--sort=-v:refname"], {
    nodeOptions: { cwd },
  });

  if (result.exitCode === 0) {
    for (const tag of result.stdout.split("\n")) {
      const version = parseTagVersion(tag.trim(), tagPrefix);
      if (version) return version;
    }
  }

  if (fallback && semver.valid(fallback)) return fallback;
  return "0.0.0";
}

function parseTagVersion(tag: string, tagPrefix: string): string | undefined {
  let version = tag.slice(tag.lastIndexOf("/") + 1);
  if (tagPrefix && version.startsWith(tagPrefix)) version = version.slice(tagPrefix.length);
  if (semver.valid(version)) return version;
}

function formatTag(cwd: string, pkgPath: string, version: string, tagPrefix: string): string {
  const relativeDir = path.relative(cwd, pkgPath).replaceAll("\\", "/");
  const tag = `${tagPrefix}${version}`;
  return relativeDir === "" ? tag : `${relativeDir}/${tag}`;
}

function normalizeDir(dir: string): string {
  return dir.endsWith(path.sep) ? dir.slice(0, -1) : dir;
}

export async function isPackagePublished(
  registry: string,
  name: string,
  version: string,
): Promise<boolean> {
  const url = joinPath(registry, "p2", `${name}.json`);
  const response = await fetch(url, {
    headers: { "User-Agent": "tegami-composer" },
  });

  if (response.status === 404) return false;
  if (!response.ok) {
    throw await fetchFailure(`Unable to validate ${name}@${version} on ${registry}`, response);
  }

  const validated = validateRegistryResponse(await response.json());
  if (!validated.success) return false;

  const versions = validated.data.packages[name];
  return versions?.some((entry) => normalizeVersion(entry.version) === version) ?? false;
}

function normalizeVersion(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}
