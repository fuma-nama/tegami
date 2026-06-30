import { readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import initToml, { edit, parse } from "@rainbowatcher/toml-edit-js";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { DraftPolicy } from "../plans/draft";
import type { Awaitable, TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { WorkspacePackage } from "../graph";
import type { BumpType } from "../utils/semver";
import { cargoManifestSchema, type CargoDependency, type CargoManifest } from "./cargo/schema";

const DEP_FIELDS = ["dependencies", "dev-dependencies", "build-dependencies"] as const;

export class CargoPackage extends WorkspacePackage {
  readonly manager = "cargo";

  constructor(
    readonly path: string,
    readonly manifest: CargoManifest,
    private content: string,
    private readonly workspaceManifest?: CargoManifest,
  ) {
    super();
  }

  get name(): string {
    return this.packageInfo.name;
  }

  get version() {
    return this.packageInfo.version ?? this.workspaceVersion;
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

  get packageInfo() {
    return this.manifest.package;
  }

  private get workspaceVersion(): string | undefined {
    return this.workspaceManifest?.workspace?.package?.version;
  }
}

interface DependentRef {
  dependent: CargoPackage;
  kind: (typeof DEP_FIELDS)[number];
  name: string;
  version: string;
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
        for (const [rawName, dep] of Object.entries(table)) {
          if (!dep || typeof dep === "string" || !dep.path) continue;

          const packageName = dep.package ?? rawName;
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
  const dependentMap = new Map<string, DependentRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof CargoPackage)) continue;

    for (const { table, kind } of dependencyTables(pkg.manifest, "")) {
      for (const [rawName, rawSpec] of Object.entries(table)) {
        const spec = parseSpec(rawSpec);
        if (!spec || !semver.validRange(spec.version)) continue;

        const name = spec.package ?? rawName;
        const id = `cargo:${name}`;
        const refs = dependentMap.get(id);
        if (refs) refs.push({ dependent: pkg, kind, name, version: spec.version });
        else dependentMap.set(id, [{ dependent: pkg, kind, name, version: spec.version }]);
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

        if (semver.satisfies(bumped, dep.version)) continue;

        const bumpType = getBumpDepType(dep);
        if (bumpType === false) continue;

        this.bumpPackage(dep.dependent, {
          type: bumpType,
          reason: `update dependency "${dep.name}"`,
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

async function buildEntry(path: string) {
  try {
    const content = await readFile(join(path, "Cargo.toml"), "utf8");
    return { manifest: cargoManifestSchema.parse(parse(content)), content, path };
  } catch {
    return;
  }
}

async function discoverCargoPackages(cwd: string, add: (pkg: CargoPackage) => void): Promise<void> {
  const root = await buildEntry(cwd);
  if (!root) return;

  if (root.manifest.package?.name)
    add(new CargoPackage(cwd, root.manifest, root.content, root.manifest));

  const workspace = root.manifest.workspace;
  if (!workspace?.members) return;

  const paths = await expandWorkspaceMembers(cwd, workspace.members, workspace.exclude);
  const manifests = await Promise.all(paths.map(buildEntry));

  for (const entry of manifests) {
    if (entry?.manifest.package?.name)
      add(new CargoPackage(entry.path, entry.manifest, entry.content, root.manifest));
  }
}

async function expandWorkspaceMembers(
  cwd: string,
  members: string[],
  exclude: string[] = [],
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

function dependencyTables(manifest: CargoManifest, prefix: string) {
  const tables: {
    kind: (typeof DEP_FIELDS)[number];
    table: Record<string, CargoDependency>;
    path: string;
  }[] = [];

  for (const field of DEP_FIELDS) {
    const table = manifest[field];
    if (table) {
      const path = prefix ? `${prefix}.${field}` : field;
      tables.push({ kind: field, table, path });
    }
  }

  const target = manifest.target;
  if (target) {
    for (const [targetKey, targetConfig] of Object.entries(target)) {
      const targetPath = prefix ? `${prefix}.target.${targetKey}` : `target.${targetKey}`;
      for (const field of DEP_FIELDS) {
        const table = targetConfig[field];
        if (table) tables.push({ kind: field, table, path: `${targetPath}.${field}` });
      }
    }
  }

  return tables;
}

function parseSpec(v: CargoDependency) {
  if (typeof v === "string") {
    return {
      version: v,
      setVersion(version: string) {
        return version;
      },
    };
  }

  return {
    package: v.package,
    version: v.version,
    setVersion(version: string) {
      return { ...v, version };
    },
  };
}
