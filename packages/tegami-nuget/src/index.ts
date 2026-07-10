import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { BumpType, DraftPolicy, PackageGraph, TegamiContext, TegamiPlugin } from "tegami";
import { WorkspacePackage } from "tegami";
import { execFailure, fetchFailure } from "tegami/utils";
import { assertFlatContainerIndex } from "./schema";
import {
  addPatch,
  findDescendants,
  findProperty,
  getAttr,
  getElementText,
  parseXml,
  writeXmlFile,
  type Range,
  type XmlFile,
} from "./xml";

const DEFAULT_PACKAGES = ["**/*.csproj", "**/*.fsproj"];
const IGNORE = ["**/bin/**", "**/obj/**", "**/node_modules/**"];
const DEFAULT_SOURCE = "https://api.nuget.org/v3/index.json";
const NUGET_FLAT_CONTAINER = "https://api.nuget.org/v3-flatcontainer";
const PROPS_FILE = "Directory.Build.props";

/** Where a package's version lives (own project file or an inherited `Directory.Build.props`). */
class VersionSource {
  value: string;

  constructor(
    readonly file: XmlFile,
    readonly kind: "Version" | "VersionPrefix",
    readonly range: Range,
    value: string,
  ) {
    this.value = value;
  }

  /** Stable identity for a version location, so packages sharing a props file are treated as one. */
  get key(): string {
    return `${this.file.path}#${this.range.start}`;
  }

  set(version: string): void {
    this.value = version;
    addPatch(this.file, this.range, version);
  }
}

export class NugetPackage extends WorkspacePackage {
  readonly manager = "nuget";

  constructor(
    /** absolute path to the project directory */
    readonly path: string,
    readonly projectFile: XmlFile,
    readonly packageId: string,
    readonly versionSource: VersionSource | undefined,
    readonly packable: boolean,
  ) {
    super();
  }

  get name(): string {
    return this.packageId;
  }

  get version(): string | undefined {
    return this.versionSource?.value;
  }

  setVersion(version: string): void {
    this.versionSource?.set(version);
  }

  async write(): Promise<void> {
    await writeXmlFile(this.projectFile);
  }
}

export interface NugetDependencyRef {
  dependent: NugetPackage;
  /** `project` for `<ProjectReference>`, `package` for `<PackageReference>`. */
  kind: "project" | "package";
  /** the raw `Include` value */
  name: string;
  linked: NugetPackage;
  /** `<PackageReference>` version constraint, if present */
  version?: string;
  setVersion?: (version: string) => void;
}

export interface NugetPluginOptions {
  /**
   * Glob patterns for project files to discover.
   *
   * @default ["**\/*.csproj", "**\/*.fsproj"]
   */
  packages?: string[];

  /**
   * The NuGet feed to push packages to.
   *
   * @default "https://api.nuget.org/v3/index.json"
   */
  source?: string;

  /**
   * Base URL of the flat-container (package base address) resource used to check publish status.
   *
   * Defaults to nuget.org when {@link source} is nuget.org. For private feeds, set this to the
   * feed's flat-container base URL to enable status checks; otherwise status checks are skipped.
   */
  statusUrl?: string;

  /**
   * Decide how to bump the dependents of a bumped package.
   *
   * @default "patch" for both `<ProjectReference>` and `<PackageReference>`
   */
  bumpDep?: (opts: NugetDependencyRef) => BumpType | false;
}

export function nuget({
  packages: patterns = DEFAULT_PACKAGES,
  source = DEFAULT_SOURCE,
  statusUrl,
  bumpDep: getBumpDepType,
}: NugetPluginOptions = {}): TegamiPlugin {
  let active = false;
  let files: XmlFile[] = [];
  const statusBase = resolveStatusBase(source, statusUrl);

  return {
    name: "nuget",
    async resolve() {
      const result = await discoverNugetPackages(this.cwd, patterns);
      for (const pkg of result.packages) this.graph.add(pkg);
      files = result.files;
      active = result.packages.length > 0;
    },
    initDraft(draft) {
      if (!active) return;
      draft.addPolicy(depsPolicy(this, getBumpDepType));
    },
    publishPreflight({ pkg }) {
      if (!(pkg instanceof NugetPackage)) return;

      const wait = dependencyRefs(this.graph, pkg).map((ref) => ref.linked.id);
      return {
        shouldPublish: pkg.packable && pkg.version !== undefined,
        wait,
      };
    },
    resolvePlanStatus({ plan }) {
      if (!statusBase) return;

      return Array.from(plan.packages, async ([id, packagePlan]) => {
        if (!packagePlan.preflight?.shouldPublish) return;
        const pkg = this.graph.get(id);
        if (!(pkg instanceof NugetPackage) || !pkg.version) return;

        if (!(await isPackagePublished(statusBase, pkg.packageId, pkg.version))) {
          return "pending";
        }
      });
    },
    async publish({ pkg }) {
      if (!(pkg instanceof NugetPackage)) return;
      if (!pkg.packable || !pkg.version) return { type: "skipped" };

      const scratch = await mkdtemp(path.join(tmpdir(), "tegami-nuget-"));
      try {
        const pack = await x(
          "dotnet",
          ["pack", pkg.projectFile.path, "-c", "Release", "-o", scratch],
          { nodeOptions: { cwd: pkg.path } },
        );
        if (pack.exitCode !== 0) {
          return {
            type: "failed",
            error: execFailure(`Failed to pack ${pkg.packageId}@${pkg.version}.`, pack).message,
          };
        }

        const nupkg = await findNupkg(scratch);
        if (!nupkg) {
          return { type: "failed", error: `No .nupkg produced for ${pkg.packageId}.` };
        }

        const args = ["nuget", "push", nupkg, "--source", source];
        const apiKey = process.env.NUGET_API_KEY;
        if (apiKey) args.push("--api-key", apiKey);

        const push = await x("dotnet", args, { nodeOptions: { cwd: pkg.path } });
        if (push.exitCode !== 0) {
          if (isAlreadyPushed(`${push.stdout}\n${push.stderr}`)) return { type: "skipped" };
          return {
            type: "failed",
            error: execFailure(`Failed to push ${pkg.packageId}@${pkg.version}.`, push).message,
          };
        }

        return { type: "published" };
      } finally {
        await rm(scratch, { force: true, recursive: true });
      }
    },
    async applyDraft(draft) {
      if (!active) return;

      // Bump versions. Packages that inherit the same Directory.Build.props share
      // one VersionSource, so we resolve the highest bump per location and write it once.
      const updates = new Map<VersionSource, string>();
      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof NugetPackage) || !pkg.versionSource) continue;

        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (!bumped) continue;

        const current = updates.get(pkg.versionSource);
        updates.set(pkg.versionSource, current && semver.gte(current, bumped) ? current : bumped);
      }
      for (const [downSource, version] of updates) downSource.set(version);

      // Rewrite `<PackageReference>` version constraints that no longer accept the new version.
      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof NugetPackage)) continue;

        for (const ref of dependencyRefs(this.graph, pkg)) {
          if (ref.kind !== "package" || !ref.setVersion || !ref.version) continue;
          if (!ref.linked.version) continue;

          const next = rewriteConstraint(ref.version, ref.linked.version);
          if (next !== undefined) ref.setVersion(next);
        }
      }

      await Promise.all(files.map((file) => writeXmlFile(file)));
    },
  };
}

function resolveStatusBase(source: string, statusUrl?: string): string | undefined {
  if (statusUrl) return statusUrl.replace(/\/+$/, "");
  if (source === DEFAULT_SOURCE) return NUGET_FLAT_CONTAINER;
  return undefined;
}

function depsPolicy(
  { graph }: TegamiContext,
  getBumpDepType: NugetPluginOptions["bumpDep"] = () => "patch",
): DraftPolicy {
  const dependentMap = new Map<string, NugetDependencyRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof NugetPackage)) continue;

    for (const ref of dependencyRefs(graph, pkg)) {
      const refs = dependentMap.get(ref.linked.id);
      if (refs) refs.push(ref);
      else dependentMap.set(ref.linked.id, [ref]);
    }
  }

  return {
    id: "nuget:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof NugetPackage)) return;
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
          reason: `update dependency "${pkg.name}"`,
        });
      }
    },
  };
}

function dependencyRefs(graph: PackageGraph, pkg: NugetPackage): NugetDependencyRef[] {
  const root = pkg.projectFile.root;
  if (!root) return [];

  const out: NugetDependencyRef[] = [];

  for (const el of findDescendants(root, "projectreference")) {
    const include = getAttr(el, "include");
    if (!include) continue;

    const target = path.resolve(pkg.path, include.value.replace(/\\/g, "/"));
    const linked = graph
      .getPackages()
      .find(
        (candidate): candidate is NugetPackage =>
          candidate instanceof NugetPackage && path.resolve(candidate.projectFile.path) === target,
      );
    if (!linked || linked === pkg) continue;

    out.push({ dependent: pkg, kind: "project", name: include.value, linked });
  }

  for (const el of findDescendants(root, "packagereference")) {
    const include = getAttr(el, "include");
    if (!include) continue;

    const idLower = include.value.toLowerCase();
    const linked = graph
      .getPackages()
      .find(
        (candidate): candidate is NugetPackage =>
          candidate instanceof NugetPackage && candidate.name.toLowerCase() === idLower,
      );
    if (!linked || linked === pkg) continue;

    const versionAttr = getAttr(el, "version");
    const ref: NugetDependencyRef = {
      dependent: pkg,
      kind: "package",
      name: include.value,
      linked,
    };
    if (versionAttr) {
      ref.version = versionAttr.value;
      ref.setVersion = (version) => addPatch(pkg.projectFile, versionAttr.valueRange, version);
    }
    out.push(ref);
  }

  return out;
}

/**
 * Decide whether a `<PackageReference Version="...">` constraint must be rewritten
 * for a newly released `version`, and to what. Returns `undefined` to keep it as-is.
 *
 * Supported syntaxes:
 * - plain `X.Y.Z` (NuGet minimum, i.e. `>= X.Y.Z`): rewritten to `version` when the
 *   referenced minimum is lower than the released version.
 * - exact `[X.Y.Z]`: rewritten to `[version]` when it no longer equals the release.
 *
 * Floating (`X.*`, `*`) and interval (`[x,y)`, `(x,y]`) ranges are left untouched.
 */
export function rewriteConstraint(constraint: string, version: string): string | undefined {
  const trimmed = constraint.trim();

  // exact match: [X.Y.Z]
  const exact = /^\[\s*([^,[\]()]+?)\s*\]$/.exec(trimmed);
  if (exact) {
    return exact[1] === version ? undefined : `[${version}]`;
  }

  // floating or interval ranges: unsupported, leave as-is
  if (trimmed.includes("*") || trimmed.includes(",") || /[[\]()]/.test(trimmed)) {
    return undefined;
  }

  // plain minimum version (>=)
  if (semver.valid(trimmed, { loose: true }) && semver.lt(trimmed, version, { loose: true })) {
    return version;
  }
  return undefined;
}

async function discoverNugetPackages(
  cwd: string,
  patterns: string[],
): Promise<{ packages: NugetPackage[]; files: XmlFile[] }> {
  const projectPaths = await glob(patterns, { absolute: true, cwd, ignore: IGNORE });

  const propsCache = new Map<string, XmlFile | null>();
  const sourceRegistry = new Map<string, VersionSource>();
  const packages: NugetPackage[] = [];
  const projectFiles: XmlFile[] = [];

  for (const projectPath of projectPaths.sort()) {
    const file = await readXmlFile(projectPath);
    if (!file?.root) continue;
    projectFiles.push(file);

    const dir = path.dirname(projectPath);
    const chain = await loadPropsChain(dir, cwd, propsCache);

    const versionSource = resolveVersionSource(file, chain, sourceRegistry);
    const packable = resolvePackable(file, chain);
    const packageId =
      findPropertyText(file, "packageid") ?? path.basename(projectPath, path.extname(projectPath));

    packages.push(new NugetPackage(dir, file, packageId, versionSource, packable));
  }

  const files: XmlFile[] = [...projectFiles];
  for (const props of propsCache.values()) if (props) files.push(props);

  return { packages, files };
}

/** Nearest-first list of `Directory.Build.props` files from `dir` up to (and including) `root`. */
async function loadPropsChain(
  dir: string,
  root: string,
  cache: Map<string, XmlFile | null>,
): Promise<XmlFile[]> {
  const chain: XmlFile[] = [];
  const rootResolved = path.resolve(root);
  let current = path.resolve(dir);

  while (true) {
    const propsPath = path.join(current, PROPS_FILE);
    let file = cache.get(propsPath);
    if (file === undefined) {
      file = (await readXmlFile(propsPath)) ?? null;
      cache.set(propsPath, file);
    }
    if (file) chain.push(file);

    if (current === rootResolved) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    // never walk above the workspace root
    if (!isWithin(rootResolved, parent) && parent !== rootResolved) break;
    current = parent;
  }

  return chain;
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveVersionSource(
  projectFile: XmlFile,
  chain: XmlFile[],
  registry: Map<string, VersionSource>,
): VersionSource | undefined {
  for (const file of [projectFile, ...chain]) {
    const found = findVersion(file);
    if (!found) continue;

    const source = new VersionSource(file, found.kind, found.range, found.value);
    const existing = registry.get(source.key);
    if (existing) return existing;
    registry.set(source.key, source);
    return source;
  }
  return undefined;
}

function findVersion(
  file: XmlFile,
): { kind: "Version" | "VersionPrefix"; range: Range; value: string } | undefined {
  if (!file.root) return;
  for (const kind of ["Version", "VersionPrefix"] as const) {
    const el = findProperty(file.root, kind.toLowerCase());
    const text = el && getElementText(el);
    if (text) return { kind, range: text.range, value: text.value };
  }
  return undefined;
}

function resolvePackable(projectFile: XmlFile, chain: XmlFile[]): boolean {
  for (const file of [projectFile, ...chain]) {
    if (!file.root) continue;
    const el = findProperty(file.root, "ispackable");
    const text = el && getElementText(el);
    if (text) return text.value.toLowerCase() !== "false";
  }
  return true;
}

function findPropertyText(file: XmlFile, nameLower: string): string | undefined {
  if (!file.root) return;
  const el = findProperty(file.root, nameLower);
  return el && getElementText(el)?.value;
}

async function readXmlFile(filePath: string): Promise<XmlFile | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }

  let root: XmlFile["root"];
  try {
    root = parseXml(content);
  } catch {
    root = undefined;
  }

  return { path: filePath, content, root, patches: [] };
}

function isMissingFileError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function findNupkg(dir: string): Promise<string | undefined> {
  const matches = await glob("*.nupkg", {
    absolute: true,
    cwd: dir,
    ignore: ["*.snupkg"],
  });
  return matches.sort()[0];
}

export function isAlreadyPushed(output: string): boolean {
  return /already exists|409|conflict/i.test(output);
}

export async function isPackagePublished(
  statusBase: string,
  packageId: string,
  version: string,
): Promise<boolean> {
  const url = `${statusBase}/${encodeURIComponent(packageId.toLowerCase())}/index.json`;
  const response = await fetch(url, { headers: { "User-Agent": "tegami-nuget" } });

  if (response.status === 404) return false;
  if (!response.ok) {
    throw await fetchFailure(
      `Unable to validate ${packageId}@${version} on ${statusBase}`,
      response,
    );
  }

  const body = assertFlatContainerIndex(await response.json());
  const target = version.toLowerCase();
  return body.versions.some((entry) => entry.toLowerCase() === target);
}
