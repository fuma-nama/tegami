import { readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import initToml, { edit, parse } from "@rainbowatcher/toml-edit-js";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { PlanPolicy } from "../plans/draft";
import type { Awaitable, TegamiPlugin, RegistryClient } from "../types";
import { isNodeError } from "../utils/error";
import { PackageGraph, WorkspacePackage } from "../graph";
import type { BumpType } from "../utils/semver";

interface TomlTable {
  [key: string]: TomlValue;
}
type TomlValue = string | number | boolean | TomlTable | TomlValue[];

const DEP_FIELDS = ["dependencies", "dev-dependencies", "build-dependencies"] as const;

export class CargoPackage extends WorkspacePackage {
  readonly manager = "cargo";

  constructor(
    readonly path: string,
    readonly manifest: TomlTable,
    private content: string,
    private readonly workspaceManifest?: TomlTable,
  ) {
    super();
  }

  get name(): string {
    return this.packageInfo.name as string;
  }

  get version(): string {
    return stringValue(this.packageInfo.version) ?? this.workspaceVersion ?? "0.0.0";
  }

  onPlan(context: TegamiContext) {
    const defaults = super.onPlan(context);
    defaults.publish ??= this.packageInfo.publish !== false;
    return defaults;
  }

  setVersion(version: string): void {
    this.packageInfo.version = version;
    this.patch("package.version", version);
  }

  async write(): Promise<void> {
    await writeFile(join(this.path, "Cargo.toml"), this.content);
  }

  patch(path: string, value: unknown): void {
    this.content = edit(this.content, path, value);
  }

  get packageInfo(): TomlTable {
    this.manifest.package ??= {};
    return this.manifest.package as TomlTable;
  }

  private get workspaceVersion(): string | undefined {
    const workspace = tableValue(this.workspaceManifest?.workspace);
    return stringValue(tableValue(workspace?.package)?.version);
  }
}

export class CargoRegistryClient implements RegistryClient {
  readonly id = "cargo";

  #versionMap = new Map<string, Promise<boolean>>();

  constructor(_graph: PackageGraph) {}

  supports(pkg: WorkspacePackage): boolean {
    return pkg instanceof CargoPackage;
  }

  async isPackagePublished(pkg: CargoPackage): Promise<boolean> {
    const cacheKey = `${pkg.id}@${pkg.version}`;
    let info = this.#versionMap.get(cacheKey);
    if (!info) {
      info = fetch(
        `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${pkg.version}`,
      ).then(async (response) => {
        if (response.status === 200) return true;
        if (response.status === 404) return false;

        throw new Error(
          `Unable to validate ${pkg.name}@${pkg.version} against crates.io: ${await response.text()}`,
        );
      });
      this.#versionMap.set(cacheKey, info);
    }

    return info;
  }

  async publish(pkg: CargoPackage): Promise<void> {
    await x("cargo", ["publish"], {
      nodeOptions: {
        cwd: pkg.path,
      },
      throwOnError: true,
    });
  }
}

export interface CargoPluginOptions {
  bumpDep?: (opts: {
    kind: (typeof DEP_FIELDS)[number];
    name: string;
    version: string;
  }) => BumpType | false;
}

export function cargo({
  bumpDep: getBumpDepType = ({ kind }) => {
    switch (kind) {
      case "dependencies":
        return "patch";
      case "build-dependencies":
      case "dev-dependencies":
        return false;
    }
  },
}: CargoPluginOptions = {}): TegamiPlugin {
  function updateRange(range: string, next: string): string | false {
    // Ignore special syntax like "latest".
    if (!semver.validRange(range)) return false;
    const semverRange = new semver.Range(range);
    if (semverRange.test(next)) return false;

    return next;
  }

  function depsPolicy({ graph }: TegamiContext): PlanPolicy {
    return {
      id: "cargo:deps",
      onUpdate({ pkg, plan }) {
        for (const other of graph.getPackages()) {
          if (!(other instanceof CargoPackage)) continue;

          for (const { table, kind } of dependencyTables(other.manifest, "")) {
            for (const [rawName, rawSpec] of Object.entries(table)) {
              const spec = parseSpec(rawSpec);
              if (!spec) continue;

              const packageName = spec.package ?? rawName;
              if (pkg.id !== `cargo:${packageName}`) continue;

              const result = updateRange(spec.version, plan.bumpVersion(pkg));
              if (result === false) continue;

              const bumpType = getBumpDepType({ kind, name: packageName, version: spec.version });
              if (bumpType === false) continue;

              this.bumpPackage(other, { type: bumpType, reason: `update dependency "${rawName}"` });
            }
          }
        }
      },
    };
  }

  return {
    name: "cargo",
    enforce: "pre",
    async init() {
      await initToml();
    },
    async resolve() {
      await discoverCargoPackages(this.cwd, (pkg) => this.graph.add(pkg));
    },
    createRegistryClient() {
      return new CargoRegistryClient(this.graph);
    },
    initPlan(plan) {
      plan.addPolicy(depsPolicy(this));
    },
    async applyPlan(draft) {
      const { graph } = this;
      const writes: Awaitable<void>[] = [];

      for (const pkg of graph.getPackages()) {
        if (!(pkg instanceof CargoPackage)) continue;

        const plan = draft.getPackagePlan(pkg.id);
        if (plan) {
          pkg.setVersion(plan.bumpVersion(pkg));
        }
      }

      for (const pkg of graph.getPackages()) {
        if (!(pkg instanceof CargoPackage)) continue;

        for (const { table, path: tablePath } of dependencyTables(pkg.manifest, "")) {
          for (const [rawName, rawSpec] of Object.entries(table)) {
            const spec = parseSpec(rawSpec);
            if (!spec) continue;

            const packageName = spec.package ?? rawName;
            const linked = graph.get(`cargo:${packageName}`);
            if (!linked || !(linked instanceof CargoPackage)) continue;

            const result = updateRange(spec.version, linked.version);
            if (result === false) continue;

            table[rawName] = spec.setVersion(result);
            pkg.patch(
              typeof rawSpec === "string"
                ? `${tablePath}.${rawName}`
                : `${tablePath}.${rawName}.version`,
              result,
            );
          }
        }

        writes.push(pkg.write());
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

  addCargoPackage(cwd, root.manifest, root.content, root.manifest, add);

  const workspace = tableValue(root.manifest.workspace);
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
    if (entry)
      addCargoPackage(
        entry.path,
        entry.manifest.manifest,
        entry.manifest.content,
        root.manifest,
        add,
      );
  }
}

function addCargoPackage(
  path: string,
  manifest: TomlTable,
  content: string,
  workspaceManifest: TomlTable,
  add: (pkg: CargoPackage) => void,
): void {
  const packageInfo = tableValue(manifest.package);
  const workspacePackage = tableValue(workspaceManifest.workspace)?.package;
  if (!packageInfo?.name) return;
  if (!packageInfo.version && !tableValue(workspacePackage)?.version) return;

  add(new CargoPackage(path, manifest, content, workspaceManifest));
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

function dependencyTables(manifest: TomlTable, prefix: string) {
  const tables: { kind: (typeof DEP_FIELDS)[number]; table: TomlTable; path: string }[] = [];

  for (const field of DEP_FIELDS) {
    const table = tableValue(manifest[field]);
    if (table) {
      const path = prefix ? `${prefix}.${field}` : field;
      tables.push({ kind: field, table, path });
    }
  }

  const target = tableValue(manifest.target);
  if (target) {
    for (const [targetKey, targetConfig] of Object.entries(target)) {
      const targetTable = tableValue(targetConfig);
      if (!targetTable) continue;

      const targetPath = prefix ? `${prefix}.target.${targetKey}` : `target.${targetKey}`;
      for (const field of DEP_FIELDS) {
        const table = tableValue(targetTable[field]);
        if (table) tables.push({ kind: field, table, path: `${targetPath}.${field}` });
      }
    }
  }

  return tables;
}

function parseSpec(v: TomlValue) {
  if (typeof v === "string") {
    return {
      version: v,
      setVersion(version: string) {
        return version;
      },
    };
  }

  if (isTableValue(v)) {
    return {
      package: stringValue(v.package),
      version: v.version as string,
      setVersion(version: string) {
        return { ...v, version };
      },
    };
  }
}

async function readCargoManifest(path: string): Promise<{ manifest: TomlTable; content: string }> {
  const content = await readFile(join(path, "Cargo.toml"), "utf8");
  return { manifest: parse(content) as TomlTable, content };
}

function isTableValue(value: TomlValue): value is TomlTable {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tableValue(value: TomlValue | undefined): TomlTable | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as TomlTable;
}

function stringValue(value: TomlValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
