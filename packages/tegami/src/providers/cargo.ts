import { readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import initToml, { edit, parse } from "@rainbowatcher/toml-edit-js";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { DraftPolicy } from "../plans/draft";
import type { Awaitable, TegamiPlugin } from "../types";
import { execFailure, isNodeError } from "../utils/error";
import { WorkspacePackage } from "../graph";
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

  get version() {
    return stringValue(this.packageInfo.version) ?? this.workspaceVersion;
  }

  setVersion(version: string): void {
    this.packageInfo.version = version;
    this.patch("package.version", version);
  }

  async write(): Promise<void> {
    await writeFile(join(this.path, "Cargo.toml"), this.content + "\n");
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
  bumpDep?: (opts: {
    dependent: CargoPackage;
    kind: (typeof DEP_FIELDS)[number];
    name: string;
    version: string;
  }) => BumpType | false;
}

export function cargo({
  updateLockFile = true,
  bumpDep: getBumpDepType,
}: CargoPluginOptions = {}): TegamiPlugin {
  let active = false;

  return {
    name: "cargo",
    enforce: "pre",
    async init() {
      await initToml();
    },
    async resolve() {
      await discoverCargoPackages(this.cwd, (pkg) => this.graph.add(pkg));
      active = this.graph.getPackages().some((pkg) => pkg instanceof CargoPackage);
    },
    initDraft(plan) {
      if (!active) return;
      plan.addPolicy(depsPolicy(this, getBumpDepType));
    },
    async publishPreflight({ pkg }) {
      if (!(pkg instanceof CargoPackage)) return;

      const wait: string[] = [];

      for (const { table } of dependencyTables(pkg.manifest, "")) {
        for (const [rawName, rawSpec] of Object.entries(table)) {
          if (!isTableValue(rawSpec) || typeof rawSpec.path !== "string") continue;

          const packageName = stringValue(rawSpec.package) ?? rawName;
          const id = `cargo:${packageName}`;
          const linked = this.graph.get(id);
          if (!linked || !(linked instanceof CargoPackage)) continue;

          wait.push(id);
        }
      }

      return {
        shouldPublish: pkg.version !== undefined && pkg.packageInfo.publish !== false,
        wait,
      };
    },
    resolvePlanStatus({ plan }) {
      return Array.from(plan.packages, async ([id, { preflight }]) => {
        if (!preflight!.shouldPublish) return;
        const pkg = this.graph.get(id)!;
        if (!(pkg instanceof CargoPackage) || !pkg.version) return;
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
      if (!active) return;

      const { graph } = this;
      const writes: Awaitable<void>[] = [];

      for (const pkg of graph.getPackages()) {
        if (!(pkg instanceof CargoPackage)) continue;

        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped) pkg.setVersion(bumped);
      }

      for (const pkg of graph.getPackages()) {
        if (!(pkg instanceof CargoPackage)) continue;

        for (const { table, path: tablePath } of dependencyTables(pkg.manifest, "")) {
          for (const [rawName, rawSpec] of Object.entries(table)) {
            const spec = parseSpec(rawSpec);
            // Ignore invalid range
            if (!spec || !semver.validRange(spec.version)) continue;

            const packageName = spec.package ?? rawName;
            const linked = graph.get(`cargo:${packageName}`);
            if (!linked || !(linked instanceof CargoPackage)) continue;
            if (!linked.version || semver.satisfies(linked.version, spec.version)) continue;

            let updatedRange: string;
            if (spec.version.startsWith("^")) {
              updatedRange = `^${linked.version}`;
            } else if (spec.version.startsWith("~")) {
              updatedRange = `~${linked.version}`;
            } else {
              updatedRange = linked.version;
            }

            table[rawName] = spec.setVersion(updatedRange);
            pkg.patch(
              typeof rawSpec === "string"
                ? `${tablePath}.${rawName}`
                : `${tablePath}.${rawName}.version`,
              updatedRange,
            );
          }
        }

        writes.push(pkg.write());
      }

      await Promise.all(writes);
    },
    async applyCliDraft() {
      if (!active || !updateLockFile) return;
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
  { graph }: TegamiContext,
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
  return {
    id: "cargo:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof CargoPackage)) return;
      const group = graph.getPackageGroup(pkg.id);

      for (const dependent of graph.getPackages()) {
        if (!(dependent instanceof CargoPackage)) continue;

        for (const { table, kind } of dependencyTables(dependent.manifest, "")) {
          for (const [rawName, rawSpec] of Object.entries(table)) {
            const spec = parseSpec(rawSpec);
            if (!spec || !semver.validRange(spec.version)) continue;
            if (pkg.id !== `cargo:${spec.package ?? rawName}`) continue;

            if (group?.options.syncBump && graph.getPackageGroup(dependent.id) === group) {
              // they will always bump together
              continue;
            }

            const bumped = plan.bumpVersion(pkg);
            if (!bumped || semver.satisfies(bumped, spec.version)) continue;

            const bumpType = getBumpDepType({
              kind,
              dependent,
              name: pkg.name,
              version: spec.version,
            });
            if (bumpType === false) continue;

            this.bumpPackage(dependent, {
              type: bumpType,
              reason: `update dependency "${rawName}"`,
            });
          }
        }
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
  if (!packageInfo?.name) return;

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
