import { relative, resolve } from "node:path";
import * as semver from "semver";
import { x } from "tinyexec";
import z from "zod";
import type { TegamiContext } from "../context";
import type { DraftPolicy } from "../plans/draft";
import type { Awaitable, TegamiPlugin } from "../types";
import { execFailure, isNodeError } from "../utils/error";
import { PackageGraph, WorkspacePackage } from "../graph";
import type { BumpType } from "../utils/semver";

interface GoModFile {
  module: string;
  requires: Map<string, string>;
  replaces: Map<string, GoReplace>;
}

interface GoReplace {
  module: string;
  path?: string;
  version?: string;
}

const goWorkJsonSchema = z.object({
  Use: z
    .array(
      z.object({
        DiskPath: z.string(),
        ModulePath: z.string().optional(),
      }),
    )
    .optional(),
});

const goModJsonSchema = z.object({
  Module: z.object({ Path: z.string() }),
  Require: z
    .array(
      z.object({
        Path: z.string(),
        Version: z.string().optional(),
      }),
    )
    .optional(),
  Replace: z
    .array(
      z.object({
        Old: z.object({
          Path: z.string(),
          Version: z.string().optional(),
        }),
        New: z.object({
          Path: z.string(),
          Version: z.string().optional(),
        }),
      }),
    )
    .optional(),
});

export class GoPackage extends WorkspacePackage {
  readonly manager = "go";
  private versionValue: string;
  private pendingRequires = new Map<string, string>();

  constructor(
    readonly path: string,
    readonly mod: GoModFile,
    version: string,
  ) {
    super();
    this.versionValue = version;
  }

  get name(): string {
    return this.mod.module;
  }

  get version(): string {
    return this.versionValue;
  }

  setVersion(version: string): void {
    this.versionValue = version;
  }

  setRequire(module: string, version: string): void {
    const formatted = formatGoVersion(version);
    this.mod.requires.set(module, formatted);
    this.pendingRequires.set(module, formatted);
  }

  async write(): Promise<void> {
    if (this.pendingRequires.size === 0) return;

    const args = ["mod", "edit"];
    for (const [module, version] of this.pendingRequires) {
      args.push(`-require=${module}@${version}`);
    }

    const result = await x("go", args, {
      nodeOptions: { cwd: this.path },
    });

    if (result.exitCode !== 0) {
      throw execFailure(`Failed to update go.mod requires in ${this.path}.`, result);
    }

    this.pendingRequires.clear();
  }
}

interface DependentRef {
  dependent: GoPackage;
  name: string;
  version: string;
}

export interface GoPluginOptions {
  /**
   * Run `go work sync` or `go mod tidy` after versioning.
   *
   * @default true
   */
  updateLockFile?: boolean;

  bumpDep?: (opts: DependentRef) => BumpType | false;
}

const packageLockSchema = z.object({
  id: z.string(),
  version: z.string(),
});

/**
 * Plugin for Golang, the release flow of Golang is pretty special, there's some exceptions for it:
 *
 * - Version is stored in lock file, normally, it should prefer to store versions in a file like `package.json` & `Cargo.toml`, but for Golang, there is no such file.
 * - Publishing is handed to Git plugin, because Golang uses Git tag for publishing.
 */
export function go({
  updateLockFile = true,
  bumpDep: getBumpDepType,
}: GoPluginOptions = {}): TegamiPlugin {
  let active = false;

  return {
    name: "go",
    enforce: "post",
    async resolve() {
      await discoverGoPackages(this.cwd, (pkg) => this.graph.add(pkg));
      active = this.graph.getPackages().some((pkg) => pkg instanceof GoPackage);

      if (active && !this.plugins.some((plugin) => plugin.name === "git")) {
        throw new Error(
          'The go plugin requires the git plugin. Add git() from "tegami/plugins/git" to your plugins array.',
        );
      }
    },
    initDraft(plan) {
      if (!active) return;
      plan.addPolicy(depsPolicy(this, getBumpDepType));
    },
    async applyDraft(draft) {
      if (!active) return;

      const { graph } = this;
      const writes: Awaitable<void>[] = [];

      for (const pkg of graph.getPackages()) {
        if (!(pkg instanceof GoPackage)) continue;

        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped) pkg.setVersion(bumped);
      }

      for (const pkg of graph.getPackages()) {
        if (!(pkg instanceof GoPackage)) continue;

        for (const [moduleName, requireVersion] of pkg.mod.requires) {
          const linked = graph.get(`go:${moduleName}`);
          if (!linked || !(linked instanceof GoPackage)) continue;
          if (semver.satisfies(linked.version, stripGoVersion(requireVersion))) continue;

          pkg.setRequire(moduleName, linked.version);
        }

        writes.push(pkg.write());
      }

      await Promise.all(writes);
    },
    initPublishLock({ lock, draft }) {
      if (!active) return;

      for (const [id, packageDraft] of draft.getPackageDrafts()) {
        const pkg = this.graph.get(id);
        if (!(pkg instanceof GoPackage) || !packageDraft.type) continue;

        lock.write("go:packages", {
          id,
          version: pkg.version,
        } satisfies z.input<typeof packageLockSchema>);
      }
    },
    initPublishPlan({ lock, plan }) {
      if (!active) return;

      let data: unknown;
      while ((data = lock.read("go:packages"))) {
        const parsed = packageLockSchema.safeParse(data).data;
        if (!parsed) continue;

        const pkg = this.graph.get(parsed.id);
        if (pkg instanceof GoPackage) pkg.setVersion(parsed.version);
      }

      for (const [id, packagePlan] of plan.packages) {
        const pkg = this.graph.get(id);
        if (!(pkg instanceof GoPackage)) continue;
        packagePlan.git ??= {};
        packagePlan.git.tag = formatGoTag(this.cwd, pkg.path, pkg.version);
      }
    },
    async publishPreflight({ pkg }) {
      if (!(pkg instanceof GoPackage)) return;

      const shouldPublish =
        pkg.getPackageOptions().go?.publish ??
        this.graph.getPackageGroup(pkg.id)?.options?.go?.publish ??
        true;
      const wait: string[] = [];

      for (const [moduleName] of pkg.mod.requires) {
        const linked = this.graph.get(`go:${moduleName}`);
        if (linked instanceof GoPackage) wait.push(linked.id);
      }

      for (const replace of pkg.mod.replaces.values()) {
        if (!replace.path) continue;

        const linked = findLocalModule(this.graph, pkg.path, replace.path);
        if (!linked) continue;

        wait.push(linked.id);
      }

      return {
        shouldPublish,
        wait,
      };
    },
    resolvePlanStatus({ plan }) {
      return Array.from(plan.packages, async ([id, { preflight }]) => {
        if (!preflight!.shouldPublish) return;

        const pkg = this.graph.get(id)!;
        if (!(pkg instanceof GoPackage)) return;
        if (!(await isModulePublished(pkg.name, pkg.version))) return "pending";
      });
    },
    async publish({ pkg }) {
      if (!(pkg instanceof GoPackage)) return;

      return { type: (await isModulePublished(pkg.name, pkg.version)) ? "skipped" : "published" };
    },
    async applyCliDraft() {
      if (!active || !updateLockFile) return;

      if (await listGoWorkUsePaths(this.cwd)) {
        const result = await x("go", ["work", "sync"], {
          nodeOptions: { cwd: this.cwd },
        });
        if (result.exitCode !== 0) {
          throw execFailure("Failed to run `go work sync`.", result);
        }
        return;
      }

      await Promise.all(
        this.graph.getPackages().map(async (pkg) => {
          if (!(pkg instanceof GoPackage)) return;

          const result = await x("go", ["mod", "tidy"], {
            nodeOptions: { cwd: pkg.path },
          });
          if (result.exitCode !== 0) {
            throw execFailure(`Failed to run \`go mod tidy\` in ${pkg.path}.`, result);
          }
        }),
      );
    },
  };
}

function depsPolicy(
  { graph }: TegamiContext,
  getBumpDepType: GoPluginOptions["bumpDep"] = () => "patch",
): DraftPolicy {
  const dependentMap = new Map<string, DependentRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof GoPackage)) continue;

    for (const [name, version] of pkg.mod.requires) {
      const id = `go:${name}`;
      const refs = dependentMap.get(id);
      if (refs) refs.push({ dependent: pkg, name, version });
      else dependentMap.set(id, [{ dependent: pkg, name, version }]);
    }
  }

  return {
    id: "go:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof GoPackage)) return;
      const deps = dependentMap.get(pkg.id);
      if (!deps) return;

      const group = graph.getPackageGroup(pkg.id);
      const bumped = plan.bumpVersion(pkg);
      if (!bumped) return;

      for (const dep of deps) {
        if (group?.options.syncBump && graph.getPackageGroup(dep.dependent.id) === group) {
          continue;
        }

        if (semver.satisfies(bumped, stripGoVersion(dep.version))) continue;

        const bumpType = getBumpDepType?.(dep);
        if (bumpType === false) continue;

        this.bumpPackage(dep.dependent, {
          type: bumpType,
          reason: `update require "${dep.name}"`,
        });
      }
    },
  };
}

async function discoverGoPackages(cwd: string, add: (pkg: GoPackage) => void): Promise<void> {
  const modulePaths = await listModulePaths(cwd);
  await Promise.all(
    modulePaths.map(async (modulePath) => {
      const mod = await readGoMod(modulePath).catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!mod) return;

      const version = await readLatestVersion(cwd, modulePath);
      add(new GoPackage(modulePath, mod, version));
    }),
  );
}

async function listModulePaths(cwd: string): Promise<string[]> {
  const workPaths = await listGoWorkUsePaths(cwd);
  if (workPaths) return workPaths;

  if (await readGoMod(cwd)) return [cwd];
  return [];
}

async function listGoWorkUsePaths(cwd: string): Promise<string[] | undefined> {
  const result = await x("go", ["work", "edit", "-json"], {
    nodeOptions: { cwd },
  });
  if (result.exitCode !== 0) return undefined;

  const data = goWorkJsonSchema.safeParse(JSON.parse(result.stdout)).data;
  if (!data?.Use?.length) return [cwd];

  return data.Use.map((use) => resolve(cwd, use.DiskPath));
}

async function readGoMod(path: string): Promise<GoModFile | undefined> {
  const result = await x("go", ["mod", "edit", "-json"], {
    nodeOptions: { cwd: path },
  });
  if (result.exitCode !== 0) return;

  const data = goModJsonSchema.safeParse(JSON.parse(result.stdout)).data;
  if (!data) return;

  const requires = new Map<string, string>();
  for (const req of data.Require ?? []) {
    if (req.Version) requires.set(req.Path, req.Version);
  }

  const replaces = new Map<string, GoReplace>();
  for (const rep of data.Replace ?? []) {
    replaces.set(rep.Old.Path, {
      module: rep.New.Path,
      path: rep.New.Version ? undefined : rep.New.Path,
      version: rep.New.Version,
    });
  }

  return {
    module: data.Module.Path,
    requires,
    replaces,
  };
}

function findLocalModule(
  graph: PackageGraph,
  modulePath: string,
  replacePath: string,
): GoPackage | undefined {
  const absolute = resolve(modulePath, replacePath);
  return graph
    .getPackages()
    .find((pkg): pkg is GoPackage => pkg instanceof GoPackage && pkg.path === absolute);
}

async function readLatestVersion(cwd: string, modulePath: string): Promise<string> {
  const result = await x(
    "git",
    ["tag", "--list", formatGoTag(cwd, modulePath, "v*"), "--sort=-v:refname"],
    {
      nodeOptions: { cwd },
    },
  );

  if (result.exitCode !== 0) return "0.0.0";

  for (const tag of result.stdout.split("\n")) {
    const version = parseTagVersion(tag.trim());
    if (version) return version;
  }

  return "0.0.0";
}

function parseTagVersion(tag: string): string | undefined {
  const version = stripGoVersion(tag.slice(tag.lastIndexOf("/") + 1));
  if (semver.valid(version)) return version;
}

function formatGoTag(cwd: string, modulePath: string, version: string): string {
  const relativeDir = relative(cwd, modulePath).replaceAll("\\", "/");

  if (relativeDir === "") return formatGoVersion(version);
  return `${relativeDir}/${formatGoVersion(version)}`;
}

function formatGoVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function stripGoVersion(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

async function isModulePublished(module: string, version: string): Promise<boolean> {
  const formatted = formatGoVersion(version);
  const response = await fetch(
    `https://proxy.golang.org/${encodeURIComponent(module)}/@v/${formatted}.info`,
  );

  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new Error(
    `Unable to validate ${module}@${formatted} against proxy.golang.org: ${await response.text()}`,
  );
}
