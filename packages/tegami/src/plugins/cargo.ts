import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import initToml, { edit, parse } from "@rainbowatcher/toml-edit-js";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { DraftPolicy } from "../plans/draft";
import type { RequireFields, TegamiPlugin } from "../types";
import { execFailure, fetchFailure } from "../utils/error";
import { WorkspacePackage } from "../graph";
import type { BumpType } from "../utils/semver";
import { assertCargoManifest, type CargoDependency, type CargoManifest } from "./cargo/schema";

const DEP_FIELDS = ["dependencies", "dev-dependencies", "build-dependencies"] as const;
type DepKind = (typeof DEP_FIELDS)[number];

class CargoToml<Data extends CargoManifest = CargoManifest> {
  private dependencies: ResolvedDependency[] | undefined;
  workspace?: CargoToml<RequireFields<CargoManifest, "workspace">>;

  constructor(
    public path: string,
    public content: string,
    public data: Data,
  ) {}

  listDependencies(graph: CargoGraph): ResolvedDependency[] {
    return (this.dependencies ??= listDependencies(graph, this));
  }

  patch(path: string, value: unknown) {
    this.content = edit(this.content, path, value);
  }
}

interface ResolvedDependency {
  path: [...string[], kind: DepKind, key: string];
  spec: CargoDependency;
  resolved?: CargoPackage;
  range?: string;
  setRange?: (v: string) => void;
}

export class CargoPackage extends WorkspacePackage {
  readonly manager = "cargo";
  readonly manifest: RequireFields<CargoManifest, "package">;

  constructor(
    readonly path: string,
    /** a crate must have `package` field defined, otherwise it is merely a virutal workspace file, and Tegami should not include it. */
    readonly file: CargoToml<RequireFields<CargoManifest, "package">>,
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

    const inherited = this.file.workspace?.data.workspace.package;
    if (packageVersion.workspace && inherited?.version) return inherited.version;
    throw new Error(`Invalid Cargo.toml in "${this.path}".`);
  }

  setVersion(version: string): void {
    const packageInfo = this.manifest.package;

    if (typeof packageInfo.version === "string") {
      packageInfo.version = version;
      this.file.patch("package.version", version);
      return;
    }

    if (packageInfo.version.workspace && this.file.workspace?.data.workspace.package) {
      this.file.workspace.data.workspace.package.version = version;
      this.file.workspace.patch("workspace.package.version", version);
      return;
    }

    throw new Error(`Invalid Cargo.toml in "${this.path}".`);
  }
}

interface DependentRef {
  dependent: CargoPackage;
  kind: DepKind;
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
        shouldPublish = pkg.file.workspace?.data.workspace?.package?.publish ?? shouldPublish;
      }

      const wait: string[] = [];
      for (const { resolved } of pkg.file.listDependencies(this.cargo.graph)) {
        if (resolved) wait.push(resolved.id);
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

      for (const file of graph.files.values()) {
        for (const { range, resolved, setRange } of file.listDependencies(graph)) {
          if (!resolved || !range || !setRange || semver.satisfies(resolved.version, range))
            continue;

          let updatedRange: string;
          if (range.startsWith("^")) {
            updatedRange = `^${resolved.version}`;
          } else if (range.startsWith("~")) {
            updatedRange = `~${resolved.version}`;
          } else {
            updatedRange = resolved.version;
          }

          setRange(updatedRange);
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
  { cargo }: TegamiContext,
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
    for (const { resolved, path, spec, range } of pkg.file.listDependencies(cargoGraph)) {
      if (!resolved) continue;
      const refs = dependentMap.get(resolved.id);
      const kind = path[path.length - 2] as DepKind;
      const name = path[path.length - 1]!;

      if (refs) refs.push({ dependent: pkg, kind, name, spec, version: range });
      else dependentMap.set(resolved.id, [{ dependent: pkg, kind, name, spec, version: range }]);
    }
  }

  return {
    id: "cargo:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof CargoPackage)) return;
      const deps = dependentMap.get(pkg.id);
      if (!deps) return;

      const bumped = plan.bumpVersion(pkg);
      if (!bumped) return;

      for (const dep of deps) {
        if (pkg.group?.options.syncBump && dep.dependent.group === pkg.group) {
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
  throw await fetchFailure(`Unable to validate ${name}@${version} against crates.io`, response);
}

async function buildEntry(dir: string): Promise<CargoToml | undefined> {
  try {
    const filePath = path.join(dir, "Cargo.toml");
    const content = await readFile(filePath, "utf8");
    return new CargoToml(filePath, content, assertCargoManifest(parse(content)));
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

  out.files.set(root.path, root);

  if (root.data.package) {
    const pkg = new CargoPackage(cwd, root as never);
    out.packages.set(pkg.name, pkg);
  }

  if (root.data.workspace?.members) {
    root.workspace = root as never;
    const dirs = await expandWorkspaceMembers(
      cwd,
      root.data.workspace.members,
      root.data.workspace.exclude,
    );

    await Promise.all(
      dirs.map(async (dir) => {
        const entry = await buildEntry(dir);
        if (!entry || !entry.data.package) return;

        entry.workspace = root as never;
        const pkg = new CargoPackage(dir, entry as never);
        out.files.set(entry.path, entry);
        out.packages.set(pkg.name, pkg);
      }),
    );
  }

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

function listDependencies(graph: CargoGraph, file: CargoToml): ResolvedDependency[] {
  const out: ResolvedDependency[] = [];
  function scan(
    obj: Partial<Record<DepKind, Record<string, CargoDependency>>>,
    prefix: string[] = [],
  ) {
    for (const field of DEP_FIELDS) {
      const table = obj[field];
      if (!table) continue;

      const tablePath = [...prefix, field] as const;
      for (const [key, spec] of Object.entries(table)) {
        const { linked, range, setRange } =
          resolveLinkedDep(file, graph, tablePath, key, spec) ?? {};
        out.push({
          path: [...tablePath, key],
          spec,
          resolved: linked,
          range,
          setRange:
            setRange &&
            ((v) => {
              table[key] = setRange(v);
            }),
        });
      }
    }
  }

  scan(file.data);
  if (file.data.target) {
    for (const [key, config] of Object.entries(file.data.target)) scan(config, ["target", key]);
  }
  if (file.data.workspace) {
    scan(file.data.workspace);
  }

  return out;
}

function resolveLinkedDep(
  file: CargoToml,
  graph: CargoGraph,
  tablePath: readonly [...string[], DepKind],
  key: string,
  spec: CargoDependency,
):
  | {
      linked: CargoPackage;
      range?: string;
      setRange?: (v: string) => CargoDependency;
    }
  | undefined {
  if (typeof spec === "string") {
    const linked = graph.packages.get(key);
    if (!linked) return;

    return {
      linked,
      range: spec,
      setRange(v) {
        file.patch([...tablePath, key].join("."), v);
        return v;
      },
    };
  }

  if ("git" in spec) return;

  if ("workspace" in spec) {
    const kind = tablePath[tablePath.length - 1] as DepKind;
    const entry = file.workspace?.data.workspace?.[kind]?.[key];
    if (!entry) return;
    const resolved = resolveLinkedDep(file.workspace!, graph, ["workspace", kind], key, entry);
    if (!resolved) return;

    delete resolved.setRange;
    return resolved;
  }

  if ("path" in spec) {
    const pkgPath = path.resolve(path.dirname(file.path), spec.path);

    for (const pkg of graph.packages.values()) {
      if (pkg.path !== pkgPath) continue;
      return {
        linked: pkg,
        range: spec.version,
        setRange(v) {
          file.patch([...tablePath, key, "version"].join("."), v);
          return { ...spec, version: v };
        },
      };
    }
    return;
  }

  const linked = graph.packages.get(spec.package ?? key);
  if (!linked) return;

  return {
    linked,
    range: spec.version,
    setRange(v) {
      file.patch([...tablePath, key, "version"].join("."), v);
      return { ...spec, version: v };
    },
  };
}
