import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import initToml, { edit, parse } from "@rainbowatcher/toml-edit-js";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { DraftPolicy } from "../plans/draft";
import type { RequireFields, TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { WorkspacePackage } from "../graph";
import type { BumpType } from "../utils/semver";
import { cargoManifestSchema, type CargoDependency, type CargoManifest } from "./cargo/schema";

const DEP_FIELDS = ["dependencies", "dev-dependencies", "build-dependencies"] as const;

interface CargoToml<Data extends CargoManifest = CargoManifest> {
  path: string;
  content: string;
  data: Data;
}

export class CargoPackage extends WorkspacePackage {
  readonly manager = "cargo";
  readonly manifest: RequireFields<CargoManifest, "package">;

  constructor(
    readonly path: string,
    /** a crate must have `package` field defined, otherwise it is merely a virutal workspace file, and Tegami should not include it. */
    readonly file: CargoToml<RequireFields<CargoManifest, "package">>,
    readonly workspaceFile?: CargoToml<RequireFields<CargoManifest, "workspace">>,
  ) {
    super();
    this.manifest = file.data;
  }

  get name(): string {
    return this.manifest.package.name;
  }

  get version(): string {
    const packageVersion = this.manifest.package.version;
    if (typeof packageVersion === "string") return packageVersion;

    const inherited = this.workspaceFile?.data.workspace.package;
    if (packageVersion.workspace && inherited?.version) return inherited.version;
    throw new Error(`Invalid Cargo.toml in "${this.path}".`);
  }

  setVersion(version: string): void {
    const packageInfo = this.manifest.package;

    if (typeof packageInfo.version === "string") {
      packageInfo.version = version;
      patchFile(this.file, "package.version", version);
      return;
    }

    if (packageInfo.version.workspace && this.workspaceFile?.data.workspace.package) {
      this.workspaceFile.data.workspace.package.version = version;
      patchFile(this.workspaceFile, "workspace.package.version", version);
      return;
    }

    throw new Error(`Invalid Cargo.toml in "${this.path}".`);
  }
}

function patchFile(file: CargoToml, path: string, value: unknown): void {
  file.content = edit(file.content, path, value);
}

interface DependentRef {
  dependent: CargoPackage;
  kind: (typeof DEP_FIELDS)[number];
  name: string;
  spec: CargoDependency;
  version?: string;
}

export interface CargoPluginOptions {
  /**
   * Update lock file after versioning.
   *
   * @default true
   */
  updateLockFile?: boolean;

  /**
   * Decide how to bump the dependents of a bumped package.
   */
  bumpDep?: (opts: DependentRef) => BumpType | false;
}

export function cargo({
  updateLockFile = true,
  bumpDep: getBumpDepType,
}: CargoPluginOptions = {}): TegamiPlugin {
  return {
    name: "cargo",
    enforce: "pre",
    async init() {
      await initToml();
    },
    async resolve() {
      const graph = await resolveCargoGraph(this.cwd);
      if (graph.packages.size === 0) return;

      this.cargo = { graph };
      for (const pkg of graph.packages.values()) this.graph.add(pkg);
    },
    initDraft(plan) {
      if (!this.cargo) return;
      plan.addPolicy(depsPolicy(this, getBumpDepType));
    },
    async publishPreflight({ pkg }) {
      if (!(pkg instanceof CargoPackage) || !this.cargo) return;
      let shouldPublish = true;

      if (typeof pkg.manifest.package.publish === "boolean") {
        shouldPublish = pkg.manifest.package.publish;
      } else if (pkg.manifest.package.publish?.workspace) {
        shouldPublish = pkg.workspaceFile?.data.workspace?.package?.publish ?? shouldPublish;
      }

      const wait: string[] = [];

      for (const { table, tablePath } of dependencyTables(pkg.manifest)) {
        for (const [rawName, spec] of Object.entries(table)) {
          const resolved = resolveLinkedDep(
            pkg.workspaceFile,
            pkg.file,
            this.cargo.graph,
            tablePath,
            rawName,
            spec,
          );
          if (!resolved) continue;

          wait.push(resolved.linked.id);
        }
      }

      return { shouldPublish, wait };
    },
    resolvePlanStatus({ plan }) {
      if (!this.cargo) return;

      return Array.from(plan.packages, async ([id, { preflight }]) => {
        if (!preflight!.shouldPublish) return;
        const pkg = this.graph.get(id)!;
        if (!(pkg instanceof CargoPackage)) return;
        if (!(await isPackagePublished(pkg.name, pkg.version))) return "pending";
      });
    },
    async publish({ pkg }) {
      if (!(pkg instanceof CargoPackage)) return;

      const result = await x("cargo", ["publish"], {
        nodeOptions: {
          cwd: pkg.path,
        },
      });

      if (result.exitCode !== 0) {
        if (/already exists|already published/i.test(`${result.stdout}\n${result.stderr}`)) {
          return { type: "skipped" };
        }

        return {
          type: "failed",
          error: execFailure(`Failed to publish ${pkg.name}@${pkg.version}.`, result).message,
        };
      }

      return {
        type: "published",
      };
    },
    async applyDraft(draft) {
      if (!this.cargo) return;
      const graph = this.cargo.graph;

      for (const pkg of graph.packages.values()) {
        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped) pkg.setVersion(bumped);
      }

      for (const pkg of graph.packages.values()) {
        for (const { table, tablePath } of dependencyTables(pkg.manifest)) {
          for (const [rawName, spec] of Object.entries(table)) {
            const resolved = resolveLinkedDep(
              pkg.workspaceFile,
              pkg.file,
              graph,
              tablePath,
              rawName,
              spec,
            );
            if (
              !resolved ||
              !resolved.range ||
              !resolved.setRange ||
              semver.satisfies(resolved.linked.version, resolved.range)
            )
              continue;

            let updatedRange: string;
            if (resolved.range.startsWith("^")) {
              updatedRange = `^${resolved.linked.version}`;
            } else if (resolved.range.startsWith("~")) {
              updatedRange = `~${resolved.linked.version}`;
            } else {
              updatedRange = resolved.linked.version;
            }

            table[rawName] = resolved.setRange(updatedRange);
          }
        }
      }

      await Promise.all(
        Array.from(graph.files.values(), (file) => writeFile(file.path, file.content + "\n")),
      );
    },
    async applyCliDraft() {
      if (!this.cargo || !updateLockFile) return;
      const result = await x("cargo", ["update", "--workspace"], {
        nodeOptions: { cwd: this.cwd },
      });

      if (result.exitCode !== 0) {
        throw execFailure("Failed to update Cargo lock file", result);
      }
    },
  };
}

function depsPolicy(
  { graph, cargo }: TegamiContext,
  getBumpDepType: CargoPluginOptions["bumpDep"] = ({ kind }) => {
    switch (kind) {
      case "dependencies":
        return "patch";
      case "build-dependencies":
      case "dev-dependencies":
        return false;
    }
  },
): DraftPolicy {
  const cargoGraph = cargo!.graph;
  const dependentMap = new Map<string, DependentRef[]>();

  for (const pkg of cargoGraph.packages.values()) {
    for (const { table, tablePath } of dependencyTables(pkg.manifest)) {
      for (const [name, spec] of Object.entries(table)) {
        const resolved = resolveLinkedDep(
          pkg.workspaceFile,
          pkg.file,
          cargoGraph,
          tablePath,
          name,
          spec,
        );
        if (!resolved) continue;

        const id = resolved.linked.id;
        const refs = dependentMap.get(id);
        const kind = tablePath.at(-1) as (typeof DEP_FIELDS)[number];

        if (refs) refs.push({ dependent: pkg, kind, name, spec, version: resolved.range });
        else dependentMap.set(id, [{ dependent: pkg, kind, name, spec, version: resolved.range }]);
      }
    }
  }

  return {
    id: "cargo:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof CargoPackage)) return;
      const deps = dependentMap.get(pkg.id);
      if (!deps) return;

      const group = graph.getPackageGroup(pkg.id);
      const bumped = plan.bumpVersion(pkg);
      if (!bumped) return;

      for (const dep of deps) {
        if (group?.options.syncBump && graph.getPackageGroup(dep.dependent.id) === group) {
          // they will always bump together
          continue;
        }

        if (dep.version && semver.satisfies(bumped, dep.version)) continue;

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

async function isPackagePublished(name: string, version: string) {
  const response = await fetch(
    `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${version}`,
  );

  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new Error(
    `Unable to validate ${name}@${version} against crates.io: ${await response.text()}`,
  );
}

async function buildEntry(dir: string): Promise<CargoToml | undefined> {
  try {
    const filePath = path.join(dir, "Cargo.toml");
    const content = await readFile(filePath, "utf8");
    return {
      path: filePath,
      data: cargoManifestSchema.parse(parse(content)),
      content,
    };
  } catch {
    return;
  }
}

export interface CargoGraph {
  /** path -> Cargo.toml */
  files: Map<string, CargoToml>;
  /** name -> package */
  packages: Map<string, CargoPackage>;
}

async function resolveCargoGraph(cwd: string): Promise<CargoGraph> {
  const out: CargoGraph = {
    packages: new Map(),
    files: new Map(),
  };
  const root = await buildEntry(cwd);
  if (!root) return out;

  const rootWorkspace = root.data.workspace;
  out.files.set(root.path, root);

  if (root.data.package) {
    const pkg = new CargoPackage(cwd, root as never, rootWorkspace ? (root as never) : undefined);
    out.packages.set(pkg.name, pkg);
  }

  if (!rootWorkspace || !rootWorkspace.members) return out;

  const dirs = await expandWorkspaceMembers(cwd, rootWorkspace.members, rootWorkspace.exclude);
  await Promise.all(
    dirs.map(async (dir) => {
      const entry = await buildEntry(dir);
      if (!entry || !entry.data.package) return;

      const pkg = new CargoPackage(dir, entry as never, root as never);
      out.files.set(entry.path, entry);
      out.packages.set(pkg.name, pkg);
    }),
  );

  return out;
}

async function expandWorkspaceMembers(
  cwd: string,
  members: string[],
  exclude: string[] = [],
): Promise<string[]> {
  const patterns = members.filter((member) => member !== ".");
  if (patterns.length === 0) return [];

  const results = await glob(patterns, {
    absolute: true,
    cwd,
    ignore: ["**/target/**", ...exclude],
    onlyDirectories: true,
    onlyFiles: false,
  });

  return results.map((item) => {
    return item.endsWith(path.sep) ? item.slice(0, -1) : item;
  });
}

function dependencyTables(manifest: CargoManifest, prefix: string[] = []) {
  const tables: {
    table: Record<string, CargoDependency>;
    tablePath: [...string[], (typeof DEP_FIELDS)[number]];
  }[] = [];

  for (const field of DEP_FIELDS) {
    const table = manifest[field];
    if (!table) continue;
    tables.push({ table, tablePath: [...prefix, field] });
  }

  const target = manifest.target;
  if (target) {
    for (const [targetKey, targetConfig] of Object.entries(target)) {
      for (const field of DEP_FIELDS) {
        const table = targetConfig[field];
        if (!table) continue;
        tables.push({ table, tablePath: [...prefix, "target", targetKey, field] });
      }
    }
  }

  return tables;
}

function resolveLinkedDep(
  workspaceFile: CargoToml | undefined,
  file: CargoToml,
  graph: CargoGraph,
  tablePath: [...string[], (typeof DEP_FIELDS)[number]],
  rawName: string,
  spec: CargoDependency,
):
  | {
      linked: CargoPackage;
      range?: string;
      setRange?: (v: string) => CargoDependency;
    }
  | undefined {
  if (typeof spec === "string") {
    const linked = graph.packages.get(rawName);
    if (!linked) return;

    return {
      linked,
      range: spec,
      setRange(v) {
        patchFile(file, [...tablePath, rawName].join("."), v);
        return v;
      },
    };
  }

  if ("git" in spec) return;

  if ("workspace" in spec) {
    const kind = tablePath[tablePath.length - 1] as (typeof DEP_FIELDS)[number];
    const entry = workspaceFile?.data.workspace?.[kind]?.[rawName];
    if (!entry) return;
    const resolved = resolveLinkedDep(
      undefined,
      workspaceFile,
      graph,
      ["workspace", kind],
      rawName,
      entry,
    );
    if (!resolved || !resolved.setRange) return resolved;

    return {
      ...resolved,
      setRange(v) {
        workspaceFile.data.workspace![kind]![rawName] = resolved.setRange!(v);
        return spec;
      },
    };
  }

  if ("path" in spec) {
    const pkgPath = path.resolve(path.dirname(file.path), spec.path);

    for (const pkg of graph.packages.values()) {
      if (pkg.path !== pkgPath) continue;
      return {
        linked: pkg,
        range: spec.version,
        setRange(v) {
          patchFile(file, [...tablePath, rawName, "version"].join("."), v);
          return { ...spec, version: v };
        },
      };
    }
    return;
  }

  const linked = graph.packages.get(spec.package ?? rawName);
  if (!linked) return;

  return {
    linked,
    range: spec.version,
    setRange(v) {
      patchFile(file, [...tablePath, rawName, "version"].join("."), v);
      return { ...spec, version: v };
    },
  };
}
