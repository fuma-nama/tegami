import { readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import * as semver from "semver";
import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { PlanStore } from "../plans/store";
import type { TegamiContext } from "../context";
import type { DraftPlan } from "../plans/draft";
import type { Awaitable, TegamiPlugin, PublishPlanStatus, RegistryClient } from "../types";
import { isNodeError } from "../utils/error";
import { PackageGraph, WorkspacePackage } from "../graph";

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

  onPlan(context: TegamiContext) {
    const defaults = super.onPlan(context);
    defaults.publish ??= this.packageInfo.publish !== false;
    return defaults;
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
  function updateRange(range: string, next: semver.SemVer): string | false {
    // Ignore special syntax like "latest".
    if (!semver.validRange(range)) return false;
    const semverRange = new semver.Range(range);
    if (semverRange.test(next)) return false;

    return next.format();
  }

  return {
    name: "cargo",
    enforce: "pre",
    async resolve() {
      await discoverCargoPackages(this.cwd, (pkg) => this.graph.add(pkg));
    },
    createRegistryClient() {
      return new CargoRegistryClient(this.graph);
    },
    async applyPlan(draft: DraftPlan) {
      const { graph } = this;
      const bumpedPackages = new Map<CargoPackage, { $updateVersion: string | null }>();
      const writes: Awaitable<void>[] = [];

      const bumpDeps = (pkg: CargoPackage) => {
        const existing = bumpedPackages.get(pkg);
        if (existing) return existing;

        for (const table of dependencyTables(pkg.manifest)) {
          for (const [rawName, rawSpec] of Object.entries(table)) {
            const spec = tableValue(rawSpec);
            const packageName = stringValue(spec?.package) ?? rawName;

            const linked = graph.get(`cargo:${packageName}`);
            if (!linked || !(linked instanceof CargoPackage)) continue;
            const next = semver.parse(bumpDeps(linked).$updateVersion);
            if (!next) continue;

            if (typeof rawSpec === "string") {
              const result = updateRange(rawSpec, next);
              if (result === false) continue;

              table[rawName] = result;

              // TODO: allow user config
              draft.bumpPackage(pkg, { type: "patch", reason: `update dependency "${rawName}"` });
              continue;
            }

            if (spec) {
              const current = stringValue(spec.version);
              if (current) {
                const result = updateRange(current, next);
                if (result === false) continue;
                spec.version = result;
              } else {
                spec.version = next.format();
              }

              // TODO: allow user config
              draft.bumpPackage(pkg, { type: "patch", reason: `update dependency "${rawName}"` });
            }
          }
        }

        const bumpedVersion = draft.getPackagePlan(pkg.id)?.bumpVersion(pkg);
        const result = {
          $updateVersion: bumpedVersion && pkg.version !== bumpedVersion ? bumpedVersion : null,
        };

        bumpedPackages.set(pkg, result);
        if (result.$updateVersion) {
          tableValue(pkg.manifest.package)!.version = result.$updateVersion;
        }

        writes.push(pkg.write());
        return result;
      };

      for (const pkg of graph.getPackages()) {
        if (pkg instanceof CargoPackage) bumpDeps(pkg);
      }

      await Promise.all(writes);
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
