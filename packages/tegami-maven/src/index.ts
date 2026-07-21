import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { BumpType, DraftPolicy, PackageGraph, TegamiContext, TegamiPlugin } from "tegami";
import { WorkspacePackage } from "tegami";
import { execFailure, fetchFailure } from "tegami/utils";
import { parseDocument, type XmlDocument, type XmlElement } from "@tegami/xml-util";

const DEFAULT_REGISTRY = "https://repo1.maven.org/maven2";

/** A parsed `pom.xml` on disk. */
interface PomFile {
  /** absolute path to the `pom.xml` file */
  path: string;
  /** absolute directory containing the `pom.xml` */
  dir: string;
  doc: XmlDocument;
  root: XmlElement;
}

/** Write a pom back to disk, but only when it has queued edits. */
async function writePom(file: PomFile): Promise<void> {
  if (!file.doc.dirty) return;
  await writeFile(file.path, file.doc.toString());
}

/** Where a resolved version literally lives, so bumps edit the right place. */
interface VersionLocation {
  file: PomFile;
  element: XmlElement;
}

/** A `<dependency>` inside `project > dependencies`. */
interface RawDependency {
  groupId?: string;
  artifactId?: string;
  scope: string;
  versionElement?: XmlElement;
  versionRaw?: string;
}

/** A resolved inter-module dependency between two workspace packages. */
export interface MavenDependencyRef {
  dependent: MavenPackage;
  linked: MavenPackage;
  /** Maven dependency scope (`compile` when unspecified). */
  scope: string;
  /** The `<version>` element inside the `<dependency>`, if one is declared literally. */
  versionElement?: XmlElement;
  /** Literal `<version>` text, which may be a `${property}` reference. */
  versionRaw?: string;
}

export class MavenPackage extends WorkspacePackage {
  readonly manager = "maven";

  constructor(
    readonly path: string,
    readonly file: PomFile,
    readonly groupId: string,
    readonly artifactId: string,
    private resolvedVersion: string | undefined,
    /** the file + element that literally holds this package's version */
    readonly versionLocation: VersionLocation | undefined,
    readonly packaging: string,
    /** coordinates of the `<parent>` module, if declared */
    readonly parentCoords: { groupId: string; artifactId: string } | undefined,
    /** the `<parent><version>` element and its literal text, if declared */
    readonly parentVersionRef: { element: XmlElement; raw: string } | undefined,
    readonly dependencies: RawDependency[],
  ) {
    super();
  }

  get name(): string {
    return `${this.groupId}:${this.artifactId}`;
  }

  get version(): string | undefined {
    return this.resolvedVersion;
  }

  /**
   * Update the in-memory version. The pom edit is queued separately through the
   * version location — this keeps `version` (used by the publish lock, tags,
   * and status checks) in sync with what was written.
   */
  setVersion(version: string): void {
    this.resolvedVersion = version;
  }
}

export interface MavenPluginOptions {
  /**
   * Additional package directories or glob patterns to discover.
   *
   * Modules reachable from the root `pom.xml` through `<modules>` are always
   * discovered; use this for poms that are not reachable from the root.
   */
  packages?: string[];

  /**
   * Decide how to bump packages that depend on a bumped workspace module.
   *
   * By default, `test` and `provided` scoped dependencies are ignored and every
   * other scope triggers a `patch` bump.
   */
  bumpDep?: (opts: MavenDependencyRef) => BumpType | false;

  /**
   * Override whether a package should be published.
   *
   * By default a package is published when it has a non-`SNAPSHOT` version.
   *
   * Per-package `packages["com.acme:app"].maven.publish` and group
   * `maven.publish` options take precedence over this.
   */
  publish?: (pkg: MavenPackage) => boolean;

  /**
   * The command used to publish a package, executed at the workspace root.
   *
   * The default deploys a single module. `-am` (also make) is deliberately not
   * used: it would run `deploy` for the module's workspace dependencies too,
   * re-deploying versions Tegami already published (which most repositories
   * reject, failing the build) and deploying modules excluded by {@link publish}.
   * Tegami publishes in dependency order, so upstream modules are already
   * deployed by the time a dependent runs.
   *
   * @default ["mvn", "-B", "-ntp", "-DskipTests", "deploy", "-pl", "<module>"]
   */
  publishCommand?: string[] | ((pkg: MavenPackage) => string[]);

  /**
   * Base URL of the registry used to check whether a version is visible.
   *
   * Set to `false` to disable the check (e.g. for private repositories, where
   * Tegami then trusts a successful publish command).
   *
   * @default "https://repo1.maven.org/maven2"
   */
  registry?: string | false;
}

/** Maven-specific `packages` / `groups` options. */
export interface SharedMavenOptions {
  /** Whether to deploy this module. */
  publish?: boolean;
}

declare module "tegami" {
  interface PackageOptions<Group extends string = string> {
    /** maven-specific options. */
    maven?: SharedMavenOptions;
  }

  interface GroupOptions {
    /** maven-specific options. */
    maven?: SharedMavenOptions;
  }
}

export function maven({
  packages: extraGlobs = [],
  bumpDep: getBumpDepType,
  publish: shouldPublishOverride,
  publishCommand,
  registry = DEFAULT_REGISTRY,
}: MavenPluginOptions = {}): TegamiPlugin {
  let active = false;

  return {
    name: "maven",
    async resolve() {
      const packages = await discoverMavenPackages(this.cwd, extraGlobs);
      for (const pkg of packages) this.graph.add(pkg);
      active = packages.length > 0;
    },
    initDraft(draft) {
      if (!active) return;
      draft.addPolicy(depsPolicy(this, getBumpDepType));
    },
    initPublishPlan({ plan }) {
      if (!active) return;

      for (const [id, packagePlan] of plan.packages) {
        const pkg = this.graph.get(id);
        if (!(pkg instanceof MavenPackage) || !pkg.version) continue;

        // `pkg.name` is `groupId:artifactId` — a colon is invalid in git ref
        // names, so the git plugin's default `name@version` tag must not apply.
        packagePlan.git ??= {};
        packagePlan.git.tag = `${pkg.groupId}/${pkg.artifactId}@${pkg.version}`;
      }
    },
    publishPreflight({ pkg }) {
      if (!(pkg instanceof MavenPackage)) return;

      const wait = dependencyRefs(this.graph, pkg).map((ref) => ref.linked.id);
      const parent = resolveParentPackage(this.graph, pkg);
      if (parent) wait.push(parent.id);

      // most specific wins: per-package option, then group option, then the
      // plugin override, then the built-in non-SNAPSHOT rule
      const configured = pkg.options.maven?.publish ?? pkg.group?.options?.maven?.publish;
      const shouldPublish =
        configured ??
        (shouldPublishOverride
          ? shouldPublishOverride(pkg)
          : pkg.version !== undefined && !isSnapshot(pkg.version));

      return { shouldPublish, wait };
    },
    resolvePlanStatus({ plan }) {
      if (registry === false) return;

      return Array.from(plan.packages, async ([id, packagePlan]) => {
        if (!packagePlan.preflight!.shouldPublish) return;

        const pkg = this.graph.get(id);
        if (!(pkg instanceof MavenPackage) || !pkg.version) return;

        if (!(await isVersionPublished(registry, pkg.groupId, pkg.artifactId, pkg.version))) {
          return "pending";
        }
      });
    },
    async publish({ pkg }) {
      if (!(pkg instanceof MavenPackage)) return;

      const command = resolvePublishCommand(publishCommand, pkg, this.cwd);
      const result = await x(command[0]!, command.slice(1), {
        nodeOptions: { cwd: this.cwd },
      });

      const output = `${result.stdout}\n${result.stderr}`;
      if (result.exitCode !== 0) {
        // A reactor build can fail on *another* module that is already deployed,
        // so the marker alone does not prove this package was the one rejected —
        // confirm against the registry before reporting it as skipped.
        if (isAlreadyDeployed(output) && (await isThisVersionDeployed(registry, pkg))) {
          return { type: "skipped" };
        }

        return {
          type: "failed",
          error: execFailure(`Failed to publish ${pkg.name}@${pkg.version}.`, result).message,
        };
      }

      if (isAlreadyDeployed(output)) return { type: "skipped" };
      return { type: "published" };
    },
    async applyDraft(draft) {
      if (!active) return;

      const mavenPackages = this.graph
        .getPackages()
        .filter((pkg): pkg is MavenPackage => pkg instanceof MavenPackage);

      // 1. Group bumps by version location so shared locations (inherited parent
      //    versions or a single `${revision}`) collapse to one edit, highest wins.
      const locations = new Map<string, { location: VersionLocation; version: string }>();
      for (const pkg of mavenPackages) {
        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (!bumped || bumped === pkg.version || !pkg.versionLocation) continue;

        const key = locationKey(pkg.versionLocation);
        const existing = locations.get(key);
        if (!existing) {
          locations.set(key, { location: pkg.versionLocation, version: bumped });
        } else if (semver.gt(bumped, existing.version)) {
          existing.version = bumped;
        }
      }

      const newVersionOf = (pkg: MavenPackage): string | undefined => {
        if (!pkg.versionLocation) return pkg.version;
        return locations.get(locationKey(pkg.versionLocation))?.version ?? pkg.version;
      };

      // 2. Write each version location once, and sync every affected package's
      //    in-memory version — the publish lock, git tags, and status checks
      //    all read `pkg.version` after apply.
      for (const { location, version } of locations.values()) {
        location.file.doc.setText(location.element, version);
      }
      for (const pkg of mavenPackages) {
        const next = newVersionOf(pkg);
        if (next && next !== pkg.version) pkg.setVersion(next);
      }

      // 3. Update literal `<parent><version>` references to bumped parents.
      for (const pkg of mavenPackages) {
        const ref = pkg.parentVersionRef;
        if (!ref || parsePropertyRef(ref.raw)) continue;

        const parent = resolveParentPackage(this.graph, pkg);
        if (!parent) continue;

        const parentVersion = newVersionOf(parent);
        if (parentVersion && parentVersion !== ref.raw) {
          pkg.file.doc.setText(ref.element, parentVersion);
        }
      }

      // 4. Rewrite literal inter-module dependency versions (leave ${...} and ranges).
      for (const pkg of mavenPackages) {
        for (const ref of dependencyRefs(this.graph, pkg)) {
          if (!ref.versionElement || !ref.versionRaw) continue;
          if (parsePropertyRef(ref.versionRaw) || isVersionRange(ref.versionRaw)) continue;

          const linkedVersion = newVersionOf(ref.linked);
          if (!linkedVersion || linkedVersion === ref.versionRaw) continue;

          pkg.file.doc.setText(ref.versionElement, linkedVersion);
        }
      }

      // 5. Flush every touched pom (dedup by path; locations may target other files).
      const files = new Map<string, PomFile>();
      for (const pkg of mavenPackages) {
        files.set(pkg.file.path, pkg.file);
        if (pkg.versionLocation) files.set(pkg.versionLocation.file.path, pkg.versionLocation.file);
      }

      await Promise.all(Array.from(files.values(), (file) => writePom(file)));
    },
  };
}

function depsPolicy(
  { graph }: TegamiContext,
  getBumpDepType: MavenPluginOptions["bumpDep"] = ({ scope }) =>
    scope === "test" || scope === "provided" ? false : "patch",
): DraftPolicy {
  const dependentMap = new Map<string, MavenDependencyRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof MavenPackage)) continue;

    for (const ref of dependencyRefs(graph, pkg)) {
      const refs = dependentMap.get(ref.linked.id);
      if (refs) refs.push(ref);
      else dependentMap.set(ref.linked.id, [ref]);
    }
  }

  return {
    id: "maven:deps",
    onUpdate({ pkg, packageDraft }) {
      if (!(pkg instanceof MavenPackage)) return;
      const deps = dependentMap.get(pkg.id);
      if (!deps) return;

      const bumped = packageDraft.bumpVersion(pkg);
      if (!bumped) return;

      for (const dep of deps) {
        if (pkg.group?.options.syncBump && dep.dependent.group === pkg.group) continue;

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

function dependencyRefs(graph: PackageGraph, pkg: MavenPackage): MavenDependencyRef[] {
  const refs: MavenDependencyRef[] = [];

  for (const dep of pkg.dependencies) {
    if (!dep.artifactId) continue;

    const groupId =
      dep.groupId === "${project.groupId}" || dep.groupId === undefined ? pkg.groupId : dep.groupId;

    const linked = findPackage(graph, `${groupId}:${dep.artifactId}`);
    if (!linked || linked === pkg) continue;

    refs.push({
      dependent: pkg,
      linked,
      scope: dep.scope,
      versionElement: dep.versionElement,
      versionRaw: dep.versionRaw,
    });
  }

  return refs;
}

function resolveParentPackage(graph: PackageGraph, pkg: MavenPackage): MavenPackage | undefined {
  if (!pkg.parentCoords) return;
  return findPackage(graph, `${pkg.parentCoords.groupId}:${pkg.parentCoords.artifactId}`);
}

function findPackage(graph: PackageGraph, name: string): MavenPackage | undefined {
  for (const pkg of graph.getByName(name)) {
    if (pkg instanceof MavenPackage) return pkg;
  }
  return undefined;
}

function locationKey(location: VersionLocation): string {
  return `${location.file.path}@${location.element.start}`;
}

function resolvePublishCommand(
  publishCommand: MavenPluginOptions["publishCommand"],
  pkg: MavenPackage,
  cwd: string,
): string[] {
  if (typeof publishCommand === "function") return publishCommand(pkg);
  if (publishCommand) return publishCommand;

  const module = path.relative(cwd, pkg.path) || ".";
  return ["mvn", "-B", "-ntp", "-DskipTests", "deploy", "-pl", module];
}

function isSnapshot(version: string): boolean {
  return version.toUpperCase().endsWith("-SNAPSHOT");
}

function isAlreadyDeployed(output: string): boolean {
  return /already exists|does not allow updating|\b409\b/i.test(output);
}

/**
 * Whether this specific package's version is already on the registry.
 *
 * With `registry: false` there is nothing to ask, so the deploy output is
 * trusted — the same fallback {@link MavenPluginOptions.registry} documents.
 */
async function isThisVersionDeployed(
  registry: string | false,
  pkg: MavenPackage,
): Promise<boolean> {
  if (registry === false || !pkg.version) return true;

  try {
    return await isVersionPublished(registry, pkg.groupId, pkg.artifactId, pkg.version);
  } catch {
    // an unreachable registry must not turn a real failure into a silent skip
    return false;
  }
}

/** Maven version ranges use `[`/`(` bounds; soft requirements are bare versions. */
function isVersionRange(version: string): boolean {
  const trimmed = version.trim();
  return trimmed.startsWith("[") || trimmed.startsWith("(");
}

/** Returns the inner name of a whole-string `${name}` reference. */
function parsePropertyRef(text: string): string | undefined {
  const match = /^\$\{([^}]+)\}$/.exec(text.trim());
  return match?.[1];
}

export async function isVersionPublished(
  registry: string,
  groupId: string,
  artifactId: string,
  version: string,
): Promise<boolean> {
  const groupPath = groupId.split(".").join("/");
  const base = registry.replace(/\/+$/, "");
  const url = `${base}/${groupPath}/${artifactId}/${version}/${artifactId}-${version}.pom`;

  const response = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": "tegami-maven" },
  });

  if (response.status === 404) return false;
  if (response.ok) return true;
  throw await fetchFailure(`Unable to validate ${groupId}:${artifactId}@${version}`, response);
}

// ---------------------------------------------------------------------------
// Discovery + version/coordinate resolution
// ---------------------------------------------------------------------------

interface ParsedPom {
  file: PomFile;
  groupIdRaw?: string;
  artifactId?: string;
  versionRaw?: string;
  versionElement?: XmlElement;
  packaging: string;
  modules: string[];
  properties: Map<string, XmlElement>;
  parentCoords?: { groupId: string; artifactId: string };
  parentVersionRef?: { element: XmlElement; raw: string };
  parentRelativePath?: string;
  parentFile?: ParsedPom;
}

async function discoverMavenPackages(cwd: string, extraGlobs: string[]): Promise<MavenPackage[]> {
  const parsed = new Map<string, ParsedPom>();

  await collectModule(cwd, parsed);

  if (extraGlobs.length > 0) {
    const dirs = await glob(extraGlobs, {
      absolute: true,
      cwd,
      ignore: ["**/target/**", "**/node_modules/**"],
      onlyDirectories: true,
      onlyFiles: false,
    });
    for (const dir of dirs) await collectModule(dir, parsed);
  }

  const poms = Array.from(parsed.values());
  linkParents(poms);

  const out: MavenPackage[] = [];
  for (const pom of poms) {
    if (!pom.artifactId) continue;

    const groupId = resolveGroupId(pom);
    if (!groupId) continue;

    const version = resolveVersion(pom);
    out.push(
      new MavenPackage(
        pom.file.dir,
        pom.file,
        groupId,
        pom.artifactId,
        version?.version,
        version?.location,
        pom.packaging,
        pom.parentCoords,
        pom.parentVersionRef,
        resolveDependencies(pom),
      ),
    );
  }

  return out;
}

async function collectModule(dir: string, parsed: Map<string, ParsedPom>): Promise<void> {
  const pomPath = path.join(dir, "pom.xml");
  if (parsed.has(pomPath)) return;

  let content: string;
  try {
    content = await readFile(pomPath, "utf8");
  } catch {
    return;
  }

  parsed.set(pomPath, parsePomFile(pomPath, dir, content));

  for (const module of parsed.get(pomPath)!.modules) {
    await collectModule(path.resolve(dir, module), parsed);
  }
}

function parsePomFile(pomPath: string, dir: string, content: string): ParsedPom {
  let doc: XmlDocument;
  try {
    doc = parseDocument(content);
  } catch (error) {
    throw new Error(`Failed to parse "${pomPath}": ${(error as Error).message}`);
  }
  // a silent skip here would drop the module from versioning and publishing
  // with no diagnostic — surface the broken manifest instead.
  if (!doc.root) throw new Error(`Failed to parse "${pomPath}": no root element.`);

  const file: PomFile = { path: pomPath, dir, doc, root: doc.root };
  const root = doc.root;

  const versionElement = root.get("version");
  const parentElement = root.get("parent");

  const properties = new Map<string, XmlElement>();
  const propsElement = root.get("properties");
  if (propsElement) {
    for (const prop of propsElement.children) {
      properties.set(localOf(prop.name), prop);
    }
  }

  const modulesElement = root.get("modules");
  const modules = modulesElement
    ? modulesElement
        .getAll("module")
        .map((el) => el.text)
        .filter((value) => value.length > 0)
    : [];

  let parentCoords: ParsedPom["parentCoords"];
  let parentVersionRef: ParsedPom["parentVersionRef"];
  let parentRelativePath: string | undefined;
  if (parentElement) {
    const groupId = textOf(parentElement.get("groupId"));
    const artifactId = textOf(parentElement.get("artifactId"));
    if (groupId && artifactId) parentCoords = { groupId, artifactId };

    const versionEl = parentElement.get("version");
    if (versionEl) {
      parentVersionRef = { element: versionEl, raw: versionEl.text };
    }

    parentRelativePath = textOf(parentElement.get("relativePath"));
  }

  return {
    file,
    groupIdRaw: textOf(root.get("groupId")),
    artifactId: textOf(root.get("artifactId")),
    versionRaw: versionElement ? versionElement.text : undefined,
    versionElement,
    packaging: textOf(root.get("packaging")) ?? "jar",
    modules,
    properties,
    parentCoords,
    parentVersionRef,
    parentRelativePath,
  };
}

/** Link each pom to its parent pom in the workspace by coordinates. */
function linkParents(poms: ParsedPom[]): void {
  const index = new Map<string, ParsedPom>();
  for (const pom of poms) {
    const groupId = shallowGroupId(pom);
    if (groupId && pom.artifactId) index.set(`${groupId}:${pom.artifactId}`, pom);
  }

  for (const pom of poms) {
    if (!pom.parentCoords) continue;
    pom.parentFile = index.get(`${pom.parentCoords.groupId}:${pom.parentCoords.artifactId}`);
  }
}

/** groupId resolvable without the parent chain (own literal or explicit `<parent>` groupId). */
function shallowGroupId(pom: ParsedPom): string | undefined {
  return pom.groupIdRaw ?? pom.parentCoords?.groupId;
}

function resolveGroupId(pom: ParsedPom): string | undefined {
  if (pom.groupIdRaw) return pom.groupIdRaw;
  if (pom.parentCoords) return pom.parentCoords.groupId;
  if (pom.parentFile) return resolveGroupId(pom.parentFile);
  return undefined;
}

/** Resolve the effective version and where its text literally lives. */
function resolveVersion(
  pom: ParsedPom,
  seen = new Set<ParsedPom>(),
): { version: string; location?: VersionLocation } | undefined {
  if (seen.has(pom)) return;
  seen.add(pom);

  if (pom.versionRaw !== undefined && pom.versionElement) {
    const propName = parsePropertyRef(pom.versionRaw);
    if (propName) {
      const property = findProperty(pom, propName);
      if (property) {
        return {
          version: property.element.text,
          location: { file: property.file, element: property.element },
        };
      }
    }

    return {
      version: pom.versionRaw,
      location: { file: pom.file, element: pom.versionElement },
    };
  }

  // No own <version>: inherit from the workspace parent's resolved version.
  if (pom.parentFile) return resolveVersion(pom.parentFile, seen);

  // Parent is outside the workspace: fall back to the literal <parent><version>.
  if (pom.parentVersionRef && !parsePropertyRef(pom.parentVersionRef.raw)) {
    return {
      version: pom.parentVersionRef.raw,
      location: { file: pom.file, element: pom.parentVersionRef.element },
    };
  }

  return undefined;
}

/** Walk up the parent chain to find where a property is defined. */
function findProperty(
  pom: ParsedPom,
  name: string,
  seen = new Set<ParsedPom>(),
): { file: PomFile; element: XmlElement } | undefined {
  if (seen.has(pom)) return;
  seen.add(pom);

  const element = pom.properties.get(name);
  if (element) return { file: pom.file, element };
  if (pom.parentFile) return findProperty(pom.parentFile, name, seen);
  return undefined;
}

function resolveDependencies(pom: ParsedPom): RawDependency[] {
  const dependenciesElement = pom.file.root.get("dependencies");
  if (!dependenciesElement) return [];

  const out: RawDependency[] = [];
  for (const dependency of dependenciesElement.getAll("dependency")) {
    const versionElement = dependency.get("version");
    out.push({
      groupId: textOf(dependency.get("groupId")),
      artifactId: textOf(dependency.get("artifactId")),
      scope: textOf(dependency.get("scope")) ?? "compile",
      versionElement,
      versionRaw: versionElement ? versionElement.text : undefined,
    });
  }

  return out;
}

function textOf(element: XmlElement | undefined): string | undefined {
  if (!element) return undefined;
  const text = element.text;
  return text.length > 0 ? text : undefined;
}

function localOf(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}
