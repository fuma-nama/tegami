import { readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import * as semver from "semver";
import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { PlanStore } from "../schemas";
import type { TegamiContext } from "../context";
import type { TegamiPlugin, PublishPlanStatus, RegistryClient } from "../types";
import { isNodeError } from "../utils/error";
import { PackageGraph, WorkspacePackage } from "../workspace";

const DEP_FIELDS = ["dependencies", "dev-dependencies", "build-dependencies"] as const;

export class CargoPackage extends WorkspacePackage {
  readonly manager = "cargo";

  constructor(
    readonly path: string,
    readonly manifest: TomlTable,
    private readonly workspaceManifest?: TomlTable,
  ) {
    super();
  }

  get name(): string {
    return stringValue(this.packageInfo.name)!;
  }

  get version(): string {
    return stringValue(this.packageInfo.version) ?? this.workspaceVersion ?? "0.0.0";
  }

  get publish(): boolean {
    return this.packageInfo.publish !== false;
  }

  setVersion(version: string): void {
    this.packageInfo.version = version;
  }

  async updateDependency(
    target: WorkspacePackage,
    version: string,
    context: TegamiContext,
  ): Promise<void> {
    if (!(target instanceof CargoPackage)) return;

    const next = semver.parse(version);
    if (!next) return;

    for (const table of dependencyTables(this.manifest)) {
      for (const [rawName, rawSpec] of Object.entries(table)) {
        const spec = tableValue(rawSpec);
        const packageName = stringValue(spec?.package) ?? rawName;
        if (packageName !== target.name) continue;

        if (typeof rawSpec === "string") {
          table[rawName] = (
            await this.updateRange(context, { name: packageName, range: rawSpec }, next)
          ).range;
          continue;
        }

        if (spec) {
          const current = stringValue(spec.version);
          spec.version = current
            ? (await this.updateRange(context, { name: packageName, range: current }, next)).range
            : next.format();
        }
      }
    }
  }

  async write(): Promise<void> {
    await writeFile(join(this.path, "Cargo.toml"), stringify(this.manifest));
  }

  private get packageInfo(): TomlTable {
    return tableValue(this.manifest.package) ?? {};
  }

  private get workspaceVersion(): string | undefined {
    const workspace = tableValue(this.workspaceManifest?.workspace);
    return stringValue(tableValue(workspace?.package)?.version);
  }
}

export class CargoRegistryClient implements RegistryClient {
  readonly id = "cargo";

  #versionMap = new Map<string, Promise<boolean>>();

  constructor(private readonly graph: PackageGraph) {}

  supports(pkg: WorkspacePackage): boolean {
    return pkg instanceof CargoPackage;
  }

  async packageVersionExists(pkg: WorkspacePackage, version: string): Promise<boolean> {
    const cacheKey = `${pkg.id}@${version}`;
    let info = this.#versionMap.get(cacheKey);
    if (!info) {
      info = fetch(
        `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${version}`,
      ).then(async (response) => {
        if (response.status === 200) return true;
        if (response.status === 404) return false;

        throw new Error(
          `Unable to validate ${pkg.name}@${version} against crates.io: ${await response.text()}`,
        );
      });
      this.#versionMap.set(cacheKey, info);
    }

    return info;
  }

  async publish(pkg: WorkspacePackage): Promise<void> {
    await x("cargo", ["publish"], {
      nodeOptions: {
        cwd: pkg.path,
      },
      throwOnError: true,
    });
  }

  async publishPlanStatus(plan: PlanStore): Promise<PublishPlanStatus> {
    for (const [id, pkgPlan] of Object.entries(plan.packages)) {
      const pkg = this.graph.get(id);
      if (!(pkg instanceof CargoPackage) || !pkgPlan.publish) continue;

      const exists = await this.packageVersionExists(pkg, pkg.version);
      if (!exists) return { state: "pending" };
    }

    return { state: "success" };
  }
}

export function cargo(): TegamiPlugin {
  return {
    name: "cargo",
    enforce: "pre",
    async resolve() {
      await discoverCargoPackages(this.cwd, (pkg) => this.graph.add(pkg));
    },
    createRegistryClient() {
      return new CargoRegistryClient(this.graph);
    },
  };
}

async function discoverCargoPackages(cwd: string, add: (pkg: CargoPackage) => void): Promise<void> {
  const root = await readCargoManifest(cwd).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!root) return;

  addCargoPackage(cwd, root, root, add);

  const workspace = tableValue(root.workspace);
  const members = workspace?.members;
  if (!workspace || !Array.isArray(members)) return;
  const exclude = Array.isArray(workspace.exclude)
    ? workspace.exclude.filter((member): member is string => typeof member === "string")
    : [];

  const paths = await expandWorkspaceMembers(
    cwd,
    members.filter((member): member is string => typeof member === "string"),
    exclude,
  );
  const manifests = await Promise.all(
    paths.map((path) =>
      readCargoManifest(path)
        .then((manifest) => ({ path, manifest }))
        .catch(() => undefined),
    ),
  );

  for (const entry of manifests) {
    if (entry) addCargoPackage(entry.path, entry.manifest, root, add);
  }
}

function addCargoPackage(
  path: string,
  manifest: TomlTable,
  workspaceManifest: TomlTable,
  add: (pkg: CargoPackage) => void,
): void {
  const packageInfo = tableValue(manifest.package);
  const workspacePackage = tableValue(workspaceManifest.workspace)?.package;
  if (!packageInfo?.name) return;
  if (!packageInfo.version && !tableValue(workspacePackage)?.version) return;

  add(new CargoPackage(path, manifest, workspaceManifest));
}

async function expandWorkspaceMembers(
  cwd: string,
  members: string[],
  exclude: string[],
): Promise<string[]> {
  const paths = members.includes(".") ? [cwd] : [];
  const patterns = members.filter((member) => member !== ".");

  if (patterns.length > 0) {
    paths.push(
      ...(await glob(patterns, {
        absolute: true,
        cwd,
        ignore: ["**/target/**", ...exclude],
        onlyDirectories: true,
        onlyFiles: false,
      })),
    );
  }

  return paths.map(normalize);
}

function dependencyTables(manifest: TomlTable): TomlTable[] {
  const tables: TomlTable[] = [];

  for (const field of DEP_FIELDS) {
    const table = tableValue(manifest[field]);
    if (table) tables.push(table);
  }

  const target = tableValue(manifest.target);
  if (target) {
    for (const targetConfig of Object.values(target)) {
      const targetTable = tableValue(targetConfig);
      if (!targetTable) continue;

      for (const field of DEP_FIELDS) {
        const table = tableValue(targetTable[field]);
        if (table) tables.push(table);
      }
    }
  }

  return tables;
}

async function readCargoManifest(path: string): Promise<TomlTable> {
  return parse(await readFile(join(path, "Cargo.toml"), "utf8"));
}

function tableValue(value: TomlValue | undefined): TomlTable | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as TomlTable;
}

function stringValue(value: TomlValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
