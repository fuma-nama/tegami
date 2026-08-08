import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type {
  BumpType,
  DraftPolicy,
  PackageGraph,
  PackagePublishTaskResult,
  PublishTaskRunContext,
  TegamiContext,
  TegamiPlugin,
} from "tegami";
import { PackagePublishTask, WorkspacePackage } from "tegami";
import { execFailure, fetchFailure } from "tegami/utils";
import {
  applyEdits,
  declaresPublishing,
  findInvocationStrings,
  findProjectRefs,
  findStringAssignments,
  normalizeProjectPath,
  tokenize,
  type Edit,
  type ProjectRef,
  type StringAssignment,
  type Token,
} from "./script";
import { parseProperties, type PropertyEntry } from "./properties";

const DEFAULT_REGISTRY = "https://repo1.maven.org/maven2";

/** `VERSION_NAME` / `GROUP` are the `gradle-maven-publish-plugin` conventions. */
const DEFAULT_VERSION_KEYS = ["version", "VERSION_NAME"];
const DEFAULT_GROUP_KEYS = ["group", "GROUP"];
const DEFAULT_ARTIFACT_ID_KEYS = ["POM_ARTIFACT_ID"];

const BUILD_SCRIPTS = ["build.gradle.kts", "build.gradle"];
const SETTINGS_SCRIPTS = ["settings.gradle.kts", "settings.gradle"];

/** A file that bumps can patch in place, keeping every unrelated byte intact. */
interface EditableFile {
  /** absolute path */
  path: string;
  content: string;
  edits: Edit[];
}

interface ScriptFile extends EditableFile {
  tokens: Token[];
  assignments: StringAssignment[];
  projectRefs: ProjectRef[];
  /** whether the script sets up publishing (a plugin or a `publishing {}` block) */
  publishing: boolean;
}

interface PropertiesFileRef extends EditableFile {
  entries: Map<string, PropertyEntry>;
}

/** Where a resolved value literally lives, so bumps edit the right place. */
interface ValueLocation {
  file: EditableFile;
  start: number;
  end: number;
}

interface ResolvedValue {
  value: string;
  /** absent when the value cannot be rewritten (e.g. string interpolation) */
  location?: ValueLocation;
}

/** A resolved dependency between two workspace projects. */
export interface GradleDependencyRef {
  dependent: GradlePackage;
  linked: GradlePackage;
  /** the Gradle configuration it was declared in, e.g. `implementation` */
  configuration: string;
}

export class GradlePackage extends WorkspacePackage {
  readonly manager = "gradle";

  constructor(
    readonly path: string,
    /** Gradle project path, e.g. `:core` (`:` for the root project) */
    readonly projectPath: string,
    readonly groupId: string,
    readonly artifactId: string,
    private resolvedVersion: string | undefined,
    /** the file + span that literally holds this package's version */
    readonly versionLocation: ValueLocation | undefined,
    /** whether the build script sets publishing up at all */
    readonly publishing: boolean,
    readonly projectRefs: ProjectRef[],
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
   * Update the in-memory version. The file edit is queued separately through the
   * version location — this keeps `version` (used by the publish lock, tags,
   * and status checks) in sync with what was written.
   */
  setVersion(version: string): void {
    this.resolvedVersion = version;
  }

  /** Fully qualified task path, e.g. `:core:publish`. */
  taskPath(task: string): string {
    return this.projectPath === ":" ? `:${task}` : `${this.projectPath}:${task}`;
  }
}

export interface GradlePluginOptions {
  /**
   * Additional project directories or glob patterns to discover.
   *
   * Projects declared with `include` in `settings.gradle(.kts)` are always
   * discovered; use this for builds that are not reachable from the root
   * settings file.
   */
  packages?: string[];

  /**
   * Decide how to bump packages that depend on a bumped workspace project.
   *
   * By default, `test`-prefixed configurations are ignored and every other
   * configuration triggers a `patch` bump.
   */
  bumpDep?: (opts: GradleDependencyRef) => BumpType | false;

  /**
   * Override whether a package should be published.
   *
   * By default a package is published when it has a non-`SNAPSHOT` version and
   * its build script declares publishing — a `maven-publish` / publish plugin,
   * or a `publishing {}` block. Projects that apply publishing through a
   * convention plugin are invisible to that check, so set this (or the
   * per-package option) for them.
   *
   * Per-package `packages["com.acme:core"].gradle.publish` and group
   * `gradle.publish` options take precedence over this.
   */
  publish?: (pkg: GradlePackage) => boolean;

  /**
   * The Gradle task that publishes a project.
   *
   * `gradle-maven-publish-plugin` users typically want `publishToMavenCentral`
   * or `publishAndReleaseToMavenCentral`.
   *
   * @default "publish"
   */
  publishTask?: string;

  /**
   * The command used to publish a package, executed at the workspace root.
   *
   * The default runs a single project's publish task. Tegami publishes in
   * dependency order, so upstream projects are already published by the time a
   * dependent runs.
   *
   * @default ["./gradlew", "--console=plain", "<project>:<publishTask>"]
   */
  publishCommand?: string[] | ((pkg: GradlePackage) => string[]);

  /**
   * Base URL of the registry used to check whether a version is visible.
   *
   * Set to `false` to disable the check (e.g. for private repositories, where
   * Tegami then trusts a successful publish command).
   *
   * @default "https://repo1.maven.org/maven2"
   */
  registry?: string | false;

  /**
   * `gradle.properties` keys to read coordinates from, in order of preference.
   *
   * Defaults cover both plain Gradle (`version`, `group`) and
   * `gradle-maven-publish-plugin` (`VERSION_NAME`, `GROUP`,
   * `POM_ARTIFACT_ID`).
   */
  propertyNames?: {
    version?: string[];
    group?: string[];
    artifactId?: string[];
  };
}

/** Gradle-specific `packages` / `groups` options. */
export interface SharedGradleOptions {
  /** Whether to publish this project. */
  publish?: boolean;
}

declare module "tegami" {
  interface PackageOptions<Group extends string = string> {
    /** gradle-specific options. */
    gradle?: SharedGradleOptions;
  }

  interface GroupOptions {
    /** gradle-specific options. */
    gradle?: SharedGradleOptions;
  }
}

/** publishes a Gradle project with the configured publish command */
export class GradlePublishTask extends PackagePublishTask<GradlePackage> {
  constructor(
    pkg: GradlePackage,
    private readonly registry: string | false,
    private readonly publishCommand: GradlePluginOptions["publishCommand"],
    private readonly publishTask: string,
    private readonly wrapper: string,
  ) {
    super(pkg);
  }

  async publish({ context }: PublishTaskRunContext): Promise<PackagePublishTaskResult> {
    const { pkg, registry } = this;
    const command =
      typeof this.publishCommand === "function"
        ? this.publishCommand(pkg)
        : (this.publishCommand ?? [
            this.wrapper,
            "--console=plain",
            pkg.taskPath(this.publishTask),
          ]);

    const result = await x(command[0]!, command.slice(1), {
      nodeOptions: { cwd: context.cwd },
    });

    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0) {
      // the build may have failed on *another* project that is already
      // published, so the marker alone does not prove this package was the one
      // rejected — confirm against the registry before reporting it as skipped
      if (isAlreadyPublished(output) && (await isThisVersionPublished(registry, pkg))) {
        return { type: "skipped" };
      }

      if (isMissingTask(output)) {
        throw execFailure(
          `Failed to publish ${pkg.name}@${pkg.version}: no "${pkg.taskPath(this.publishTask)}" task. ` +
            `Apply a publishing plugin to the project, set \`publishTask\`, or exclude it with the \`publish\` option.`,
          result,
        );
      }

      throw execFailure(`Failed to publish ${pkg.name}@${pkg.version}.`, result);
    }

    if (isAlreadyPublished(output)) return { type: "skipped" };
    return { type: "published" };
  }

  async status() {
    const { pkg, registry } = this;
    if (registry === false || !pkg.version) return;
    if (!(await isVersionPublished(registry, pkg.groupId, pkg.artifactId, pkg.version))) {
      return "pending" as const;
    }
  }
}

export function gradle({
  packages: extraGlobs = [],
  bumpDep: getBumpDepType,
  publish: shouldPublishOverride,
  publishTask = "publish",
  publishCommand,
  registry = DEFAULT_REGISTRY,
  propertyNames,
}: GradlePluginOptions = {}): TegamiPlugin {
  let active = false;
  let wrapper = "gradle";

  return {
    name: "gradle",
    async resolve() {
      const packages = await discoverGradlePackages(this.cwd, extraGlobs, propertyNames);
      for (const pkg of packages) this.graph.add(pkg);
      active = packages.length > 0;

      if (active) wrapper = await resolveWrapper(this.cwd);
    },
    initDraft(draft) {
      if (!active) return;
      draft.addPolicy(depsPolicy(this, getBumpDepType));
    },
    initPublishPlan({ plan }) {
      if (!active) return;

      for (const [id, packagePlan] of plan.packages) {
        const pkg = this.graph.get(id);
        if (!(pkg instanceof GradlePackage) || !pkg.version) continue;

        // `pkg.name` is `group:artifactId` — a colon is invalid in git ref
        // names, so the git plugin's default `name@version` tag must not apply.
        packagePlan.git ??= {};
        packagePlan.git.tag = `${pkg.groupId}/${pkg.artifactId}@${pkg.version}`;
      }
    },
    publishPreflight({ pkg }) {
      if (!(pkg instanceof GradlePackage)) return;

      // Gradle forbids circular project dependencies, so a hard wait is safe.
      const wait = dependencyRefs(this.graph, pkg).map((ref) => ref.linked.id);

      // most specific wins: per-package option, then group option, then the
      // plugin override, then the built-in rule
      const configured = pkg.options.gradle?.publish ?? pkg.group?.options?.gradle?.publish;
      const shouldPublish =
        configured ??
        (shouldPublishOverride
          ? shouldPublishOverride(pkg)
          : pkg.version !== undefined && !isSnapshot(pkg.version) && pkg.publishing);

      return { shouldPublish, wait };
    },
    publishTasks({ plan }) {
      if (!active) return;
      return plan
        .getPackagesToPublish()
        .map((pkg) =>
          pkg instanceof GradlePackage
            ? new GradlePublishTask(pkg, registry, publishCommand, publishTask, wrapper)
            : undefined,
        );
    },
    async applyDraft(draft) {
      if (!active) return;

      const gradlePackages = this.graph
        .getPackages()
        .filter((pkg): pkg is GradlePackage => pkg instanceof GradlePackage);

      // 1. Group bumps by version location so shared locations (a single
      //    `version` in the root `gradle.properties`, or an `allprojects` block)
      //    collapse to one edit, highest wins.
      const locations = new Map<string, { location: ValueLocation; version: string }>();
      for (const pkg of gradlePackages) {
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

      // 2. Queue one edit per location, and sync every affected package's
      //    in-memory version — the publish lock, git tags, and status checks
      //    all read `pkg.version` after apply.
      const files = new Map<string, EditableFile>();
      for (const { location, version } of locations.values()) {
        location.file.edits.push({ start: location.start, end: location.end, text: version });
        files.set(location.file.path, location.file);
      }

      for (const pkg of gradlePackages) {
        if (!pkg.versionLocation) continue;
        const next = locations.get(locationKey(pkg.versionLocation))?.version;
        if (next && next !== pkg.version) pkg.setVersion(next);
      }

      // Inter-project dependencies (`project(":core")`) carry no version, so
      // there is nothing else to rewrite.
      await Promise.all(
        Array.from(files.values(), (file) =>
          writeFile(file.path, applyEdits(file.content, file.edits)),
        ),
      );
    },
  };
}

function depsPolicy(
  { graph }: TegamiContext,
  getBumpDepType: GradlePluginOptions["bumpDep"] = ({ configuration }) =>
    configuration.startsWith("test") ? false : "patch",
): DraftPolicy {
  const dependentMap = new Map<string, GradleDependencyRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof GradlePackage)) continue;

    for (const ref of dependencyRefs(graph, pkg)) {
      const refs = dependentMap.get(ref.linked.id);
      if (refs) refs.push(ref);
      else dependentMap.set(ref.linked.id, [ref]);
    }
  }

  return {
    id: "gradle:deps",
    onUpdate({ pkg, packageDraft }) {
      if (!(pkg instanceof GradlePackage)) return;
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

function dependencyRefs(graph: PackageGraph, pkg: GradlePackage): GradleDependencyRef[] {
  const refs: GradleDependencyRef[] = [];
  const seen = new Set<string>();

  for (const ref of pkg.projectRefs) {
    const linked = findByProjectPath(graph, ref.path);
    if (!linked || linked === pkg) continue;

    // the same project can be declared in several configurations
    const key = `${linked.id}:${ref.configuration}`;
    if (seen.has(key)) continue;
    seen.add(key);

    refs.push({ dependent: pkg, linked, configuration: ref.configuration });
  }

  return refs;
}

function findByProjectPath(graph: PackageGraph, projectPath: string): GradlePackage | undefined {
  for (const pkg of graph.getPackages()) {
    if (pkg instanceof GradlePackage && pkg.projectPath === projectPath) return pkg;
  }
  return undefined;
}

function locationKey(location: ValueLocation): string {
  return `${location.file.path}@${location.start}`;
}

function isSnapshot(version: string): boolean {
  return version.toUpperCase().endsWith("-SNAPSHOT");
}

function isAlreadyPublished(output: string): boolean {
  return /already exists|does not allow updating|\b409\b|status code 40[09]/i.test(output);
}

/** Gradle's error when the project has no publishing plugin applied. */
function isMissingTask(output: string): boolean {
  return /cannot locate tasks|task .* not found/i.test(output);
}

/**
 * Whether this specific package's version is already on the registry.
 *
 * With `registry: false` there is nothing to ask, so the publish output is
 * trusted — the same fallback {@link GradlePluginOptions.registry} documents.
 */
async function isThisVersionPublished(
  registry: string | false,
  pkg: GradlePackage,
): Promise<boolean> {
  if (registry === false || !pkg.version) return true;

  try {
    return await isVersionPublished(registry, pkg.groupId, pkg.artifactId, pkg.version);
  } catch {
    // an unreachable registry must not turn a real failure into a silent skip
    return false;
  }
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
    headers: { "User-Agent": "tegami-gradle" },
  });

  if (response.status === 404) return false;
  if (response.ok) return true;
  throw await fetchFailure(`Unable to validate ${groupId}:${artifactId}@${version}`, response);
}

/** Prefer the wrapper so releases use the version the repository pins. */
async function resolveWrapper(cwd: string): Promise<string> {
  const windows = process.platform === "win32";
  const candidates = windows ? ["gradlew.bat"] : ["gradlew"];

  for (const candidate of candidates) {
    if (await exists(path.join(cwd, candidate))) {
      return windows ? candidate : `./${candidate}`;
    }
  }

  return "gradle";
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discovery + version/coordinate resolution
// ---------------------------------------------------------------------------

interface ParsedProject {
  /** Gradle project path, e.g. `:core` (`:` for the root project) */
  projectPath: string;
  /** absolute directory */
  dir: string;
  /** Gradle project name, which is the artifact id unless overridden */
  projectName: string;
  script?: ScriptFile;
  properties?: PropertiesFileRef;
}

interface Workspace {
  rootScript?: ScriptFile;
  rootProperties?: PropertiesFileRef;
  projects: ParsedProject[];
}

async function discoverGradlePackages(
  cwd: string,
  extraGlobs: string[],
  propertyNames: GradlePluginOptions["propertyNames"],
): Promise<GradlePackage[]> {
  const workspace = await discoverWorkspace(cwd, extraGlobs);
  const versionKeys = propertyNames?.version ?? DEFAULT_VERSION_KEYS;
  const groupKeys = propertyNames?.group ?? DEFAULT_GROUP_KEYS;
  const artifactIdKeys = propertyNames?.artifactId ?? DEFAULT_ARTIFACT_ID_KEYS;

  const out: GradlePackage[] = [];
  for (const project of workspace.projects) {
    const group = resolveValue(workspace, project, "group", groupKeys);
    if (!group) continue;

    const version = resolveValue(workspace, project, "version", versionKeys);
    // a project without coordinates is not a releasable artifact — it still
    // takes part in the build, but Tegami has nothing to version or publish
    if (!version) continue;

    const artifactId =
      firstProperty(project.properties, artifactIdKeys)?.value ?? project.projectName;

    out.push(
      new GradlePackage(
        project.dir,
        project.projectPath,
        group.value,
        artifactId,
        version.value,
        version.location,
        project.script?.publishing ?? false,
        project.script?.projectRefs ?? [],
      ),
    );
  }

  return out;
}

async function discoverWorkspace(cwd: string, extraGlobs: string[]): Promise<Workspace> {
  const root = path.resolve(cwd);
  const settings = await readScript(root, SETTINGS_SCRIPTS);
  const rootScript = await readScript(root, BUILD_SCRIPTS);

  // not a Gradle build
  if (!settings && !rootScript) return { projects: [] };

  const dirs = new Map<string, { dir: string; name?: string }>();
  dirs.set(":", { dir: root });

  if (settings) {
    for (const include of findInvocationStrings(settings.tokens, "include")) {
      const projectPath = normalizeProjectPath(include.value);
      if (projectPath === ":") continue;
      dirs.set(projectPath, { dir: path.join(root, ...projectPath.slice(1).split(":")) });
    }

    // `project(":x").projectDir = file("y")` / `project(":x").name = "y"`
    for (const override of findProjectOverrides(settings.tokens)) {
      const entry = dirs.get(override.projectPath);
      if (!entry) continue;

      if (override.property === "projectDir") entry.dir = path.resolve(root, override.value);
      else entry.name = override.value;
    }
  }

  if (extraGlobs.length > 0) {
    const matches = await glob(extraGlobs, {
      absolute: true,
      cwd: root,
      ignore: ["**/build/**", "**/node_modules/**", "**/.gradle/**"],
      onlyDirectories: true,
      onlyFiles: false,
    });

    for (const dir of matches) {
      const relative = path.relative(root, dir);
      if (relative === "") continue;

      const projectPath = normalizeProjectPath(relative.split(path.sep).join(":"));
      if (!dirs.has(projectPath)) dirs.set(projectPath, { dir });
    }
  }

  const rootName = settings
    ? findStringAssignments(settings.tokens).find(
        (assignment) => assignment.name === "rootProject.name",
      )?.value
    : undefined;

  const projects: ParsedProject[] = [];
  for (const [projectPath, { dir, name }] of dirs) {
    const script = projectPath === ":" ? rootScript : await readScript(dir, BUILD_SCRIPTS);

    projects.push({
      projectPath,
      dir,
      projectName:
        name ??
        (projectPath === ":"
          ? (rootName ?? path.basename(dir))
          : projectPath.slice(projectPath.lastIndexOf(":") + 1)),
      script,
      properties: await readPropertiesFile(dir),
    });
  }

  return {
    rootScript,
    rootProperties: projects.find((project) => project.projectPath === ":")?.properties,
    projects,
  };
}

/**
 * Resolve a coordinate the way Gradle would, and record where it is authored so
 * a bump edits that exact spot:
 *
 * 1. the project's own build script
 * 2. the project's own `gradle.properties`
 * 3. an `allprojects` / `subprojects` block in the root build script
 * 4. the root `gradle.properties`
 */
function resolveValue(
  workspace: Workspace,
  project: ParsedProject,
  scriptName: string,
  propertyKeys: string[],
): ResolvedValue | undefined {
  const own = findScriptAssignment(project.script, scriptName, []);
  if (own) return own;

  const ownProperty = findProperty(project.properties, propertyKeys);
  if (ownProperty) return ownProperty;

  const shared = ["allprojects", ...(project.projectPath === ":" ? [] : ["subprojects"])];
  for (const block of shared) {
    const inherited = findScriptAssignment(workspace.rootScript, scriptName, [block]);
    if (inherited) return inherited;
  }

  if (project.properties !== workspace.rootProperties) {
    const rootProperty = findProperty(workspace.rootProperties, propertyKeys);
    if (rootProperty) return rootProperty;
  }

  return undefined;
}

function findScriptAssignment(
  script: ScriptFile | undefined,
  name: string,
  blockPath: string[],
): ResolvedValue | undefined {
  const assignment = script?.assignments.find(
    (candidate) =>
      candidate.name === name &&
      candidate.blockPath.length === blockPath.length &&
      candidate.blockPath.every((block, index) => block === blockPath[index]),
  );
  if (!assignment) return;

  // an interpolated value is neither the real version nor safely rewritable
  if (assignment.interpolated) return;

  return {
    value: assignment.value,
    location: { file: script!, start: assignment.contentStart, end: assignment.contentEnd },
  };
}

function findProperty(
  file: PropertiesFileRef | undefined,
  keys: string[],
): ResolvedValue | undefined {
  const entry = firstProperty(file, keys);
  if (!entry || !file) return;

  return {
    value: entry.value,
    location: { file, start: entry.start, end: entry.end },
  };
}

function firstProperty(
  file: PropertiesFileRef | undefined,
  keys: string[],
): PropertyEntry | undefined {
  for (const key of keys) {
    const entry = file?.entries.get(key);
    if (entry) return entry;
  }
  return undefined;
}

interface ProjectOverride {
  projectPath: string;
  property: "projectDir" | "name";
  value: string;
}

/** `project(":x").projectDir = file("y")` and `project(":x").name = "y"`. */
function findProjectOverrides(tokens: Token[]): ProjectOverride[] {
  const out: ProjectOverride[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.kind !== "word" || tokens[i]!.value !== "project") continue;
    if (tokens[i + 1]?.value !== "(") continue;

    const target = tokens[i + 2];
    if (target?.kind !== "string") continue;
    if (tokens[i + 3]?.value !== ")" || tokens[i + 4]?.value !== ".") continue;

    const property = tokens[i + 5];
    if (property?.kind !== "word") continue;
    if (property.value !== "projectDir" && property.value !== "name") continue;
    if (tokens[i + 6]?.value !== "=") continue;

    // `file("y")` / `new File(rootDir, "y")` wrap the value; a bare string works too
    let value = tokens[i + 7];
    if (value?.kind === "word") {
      let j = i + 8;
      while (tokens[j] && tokens[j]!.kind !== "string" && tokens[j]!.value !== ")") j++;
      value = tokens[j];
    }
    if (value?.kind !== "string") continue;

    out.push({
      projectPath: normalizeProjectPath(target.value),
      property: property.value,
      value: value.value,
    });
  }

  return out;
}

async function readScript(dir: string, names: string[]): Promise<ScriptFile | undefined> {
  for (const name of names) {
    const file = path.join(dir, name);

    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }

    const tokens = tokenize(content);
    // a silent skip here would drop the project from versioning and publishing
    // with no diagnostic — surface the broken script instead
    const unterminated = tokens.find((token) => token.unterminated);
    if (unterminated) {
      throw new Error(
        `Failed to parse "${file}": unterminated string at offset ${unterminated.start}.`,
      );
    }

    return {
      path: file,
      content,
      edits: [],
      tokens,
      assignments: findStringAssignments(tokens),
      projectRefs: findProjectRefs(tokens).filter((ref) => ref.blockPath.includes("dependencies")),
      publishing: declaresPublishing(tokens),
    };
  }

  return undefined;
}

async function readPropertiesFile(dir: string): Promise<PropertiesFileRef | undefined> {
  const file = path.join(dir, "gradle.properties");

  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return undefined;
  }

  const parsed = parseProperties(file, content);
  return { path: file, content, edits: [], entries: parsed.entries };
}
