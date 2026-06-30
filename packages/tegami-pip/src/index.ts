import { readFile, writeFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import initToml, { edit, parse } from "@rainbowatcher/toml-edit-js";
import { satisfies, validRange } from "@renovatebot/pep440";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { TegamiContext } from "tegami/context";
import { PackageGraph, WorkspacePackage } from "tegami/graph";
import type { DraftPolicy } from "tegami/plans/draft";
import type { TegamiPlugin } from "tegami";
import { execFailure, isNodeError } from "tegami/utils/error";
import type { BumpType } from "tegami/utils/semver";

interface TomlTable {
  [key: string]: TomlValue;
}
type TomlValue = string | number | boolean | TomlTable | TomlValue[];

const DEP_FIELDS = ["dependencies", "optional-dependencies"] as const;

export class PipPackage extends WorkspacePackage {
  readonly manager = "pip";

  constructor(
    readonly path: string,
    readonly manifest: TomlTable,
    private content: string,
  ) {
    super();
  }

  get name(): string {
    return this.projectInfo.name as string;
  }

  get version(): string | undefined {
    return stringValue(this.projectInfo.version);
  }

  setVersion(version: string): void {
    this.projectInfo.version = version;
    this.patch("project.version", version);
  }

  async write(): Promise<void> {
    await writeFile(join(this.path, "pyproject.toml"), this.content + "\n");
  }

  patch(path: string, value: unknown): void {
    this.content = edit(this.content, path, value);
  }

  get projectInfo(): TomlTable {
    this.manifest.project ??= {};
    return this.manifest.project as TomlTable;
  }
}

export interface PipPluginOptions {
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
    dependent: PipPackage;
    kind: (typeof DEP_FIELDS)[number];
    name: string;
    version: string;
  }) => BumpType | false;
}

export function pip({
  updateLockFile = true,
  bumpDep: getBumpDepType,
}: PipPluginOptions = {}): TegamiPlugin {
  let active = false;

  return {
    name: "pip",
    enforce: "post",
    async init() {
      await initToml();
    },
    async resolve() {
      await discoverPipPackages(this.cwd, (pkg) => this.graph.add(pkg));
      active = this.graph.getPackages().some((pkg) => pkg instanceof PipPackage);
    },
    initDraft(plan) {
      if (!active) return;
      plan.addPolicy(depsPolicy(this, getBumpDepType));
    },
    async publishPreflight({ pkg }) {
      if (!(pkg instanceof PipPackage)) return;

      const wait: string[] = [];

      for (const { table } of dependencyTables(pkg.manifest)) {
        for (const rawSpec of table) {
          const spec = parseDependencySpec(String(rawSpec));
          if (!spec) continue;

          const linked = resolveLinkedPackage(this.graph, pkg, spec);
          if (!linked) continue;

          wait.push(linked.id);
        }
      }

      return {
        shouldPublish: pkg.version !== undefined && pkg.projectInfo.private !== true,
        wait,
      };
    },
    resolvePlanStatus({ plan }) {
      return Array.from(plan.packages, async ([id, { preflight }]) => {
        if (!preflight!.shouldPublish) return;
        const pkg = this.graph.get(id)!;
        if (!(pkg instanceof PipPackage) || !pkg.version) return;
        if (!(await isPackagePublished(pkg.name, pkg.version))) return "pending";
      });
    },
    async publish({ pkg }) {
      if (!(pkg instanceof PipPackage)) return;
      if (!pkg.version) return { type: "skipped" };

      const result = await x("uv", ["publish"], {
        nodeOptions: { cwd: pkg.path },
      });

      if (result.exitCode !== 0) {
        if (/already exists|already uploaded|file already exists/i.test(`${result.stdout}\n${result.stderr}`)) {
          return { type: "skipped" };
        }

        return {
          type: "failed",
          error: execFailure(`Failed to publish ${pkg.name}@${pkg.version}.`, result).message,
        };
      }

      return { type: "published" };
    },
    async applyDraft(draft) {
      if (!active) return;

      const { graph } = this;
      const writes: Promise<void>[] = [];

      for (const pkg of graph.getPackages()) {
        if (!(pkg instanceof PipPackage)) continue;

        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped) pkg.setVersion(bumped);
      }

      for (const pkg of graph.getPackages()) {
        if (!(pkg instanceof PipPackage)) continue;

        for (const { table, path: tablePath } of dependencyTables(pkg.manifest)) {
          const next: string[] = [];
          let changed = false;

          for (const rawSpec of table) {
            const spec = parseDependencySpec(String(rawSpec));
            if (!spec?.version || !validRange(spec.version)) {
              next.push(String(rawSpec));
              continue;
            }

            const linked = resolveLinkedPackage(graph, pkg, spec);
            if (!linked?.version) {
              next.push(String(rawSpec));
              continue;
            }

            const workspace = getUvSource(pkg.manifest, spec.name)?.workspace === true;
            if (
              !workspace &&
              spec.version &&
              validRange(spec.version) &&
              satisfies(linked.version, spec.version)
            ) {
              next.push(String(rawSpec));
              continue;
            }

            if (!workspace && !spec.version && !spec.url) {
              next.push(String(rawSpec));
              continue;
            }

            next.push(formatDependencySpec(spec, linked.version));
            changed = true;
          }

          if (changed) {
            table.splice(0, table.length, ...next);
            pkg.patch(tablePath, next);
          }
        }

        writes.push(pkg.write());
      }

      await Promise.all(writes);
    },
    async applyCliDraft() {
      if (!active || !updateLockFile) return;

      const result = await x("uv", ["lock"], {
        nodeOptions: { cwd: this.cwd },
      });

      if (result.exitCode !== 0) {
        throw execFailure("Failed to update uv lock file", result);
      }
    },
  };
}

function depsPolicy(
  { graph }: TegamiContext,
  getBumpDepType: PipPluginOptions["bumpDep"] = ({ kind }) => {
    switch (kind) {
      case "dependencies":
        return "patch";
      case "optional-dependencies":
        return false;
    }
  },
): DraftPolicy {
  return {
    id: "pip:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof PipPackage)) return;
      const group = graph.getPackageGroup(pkg.id);

      for (const dependent of graph.getPackages()) {
        if (!(dependent instanceof PipPackage)) continue;

        for (const { table, kind } of dependencyTables(dependent.manifest)) {
          for (const rawSpec of table) {
            const spec = parseDependencySpec(String(rawSpec));
            if (!spec) continue;

            const linked = resolveLinkedPackage(graph, dependent, spec);
            if (!linked || linked !== pkg) continue;

            if (group?.options.syncBump && graph.getPackageGroup(dependent.id) === group) {
              continue;
            }

            const bumped = plan.bumpVersion(pkg);
            if (!bumped) continue;

            if (
              getUvSource(dependent.manifest, spec.name)?.workspace !== true &&
              (!spec.version || !validRange(spec.version) || satisfies(bumped, spec.version))
            ) {
              continue;
            }

            const bumpType = getBumpDepType({
              kind,
              dependent,
              name: pkg.name,
              version: spec.version ?? "*",
            });
            if (bumpType === false) continue;

            this.bumpPackage(dependent, {
              type: bumpType,
              reason: `update dependency "${spec.name}"`,
            });
          }
        }
      }
    },
  };
}

function resolveLinkedPackage(
  graph: PackageGraph,
  pkg: PipPackage,
  spec: NonNullable<ReturnType<typeof parseDependencySpec>>,
): PipPackage | undefined {
  const linked = graph.get(`pip:${spec.name}`);
  if (linked instanceof PipPackage) return linked;

  const source = getUvSource(pkg.manifest, spec.name);
  const absolute = source?.path
    ? resolve(pkg.path, source.path)
    : spec.url?.startsWith("file:")
      ? resolveFileUrl(pkg.path, spec.url)
      : undefined;
  if (!absolute) return;

  return graph
    .getPackages()
    .find((candidate): candidate is PipPackage => candidate instanceof PipPackage && candidate.path === absolute);
}

async function isPackagePublished(name: string, version: string) {
  const response = await fetch(
    `https://pypi.org/pypi/${encodeURIComponent(normalizePyPiName(name))}/${version}/json`,
  );

  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new Error(
    `Unable to validate ${name}@${version} against PyPI: ${await response.text()}`,
  );
}

async function discoverPipPackages(cwd: string, add: (pkg: PipPackage) => void): Promise<void> {
  const root = await readPyprojectManifest(cwd).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!root) return;

  const uv = tableValue(tableValue(root.manifest.tool)?.uv);
  const workspace = tableValue(uv?.workspace);
  const members = workspace?.members;
  if (Array.isArray(members) && members.length > 0) {
    const paths = await glob(
      members.filter((member): member is string => typeof member === "string"),
      {
        absolute: true,
        cwd,
        ignore: ["**/.venv/**", "**/__pycache__/**", "**/dist/**"],
        onlyDirectories: true,
        onlyFiles: false,
      },
    );

    for (const path of paths.map(normalize)) {
      const manifest = await readPyprojectManifest(path).catch(() => undefined);
      if (!manifest) continue;

      const project = tableValue(manifest.manifest.project);
      if (!project?.name) continue;

      add(new PipPackage(path, manifest.manifest, manifest.content));
    }
    return;
  }

  const project = tableValue(root.manifest.project);
  if (!project?.name) return;

  add(new PipPackage(cwd, root.manifest, root.content));
}

function dependencyTables(manifest: TomlTable) {
  const project = tableValue(manifest.project);
  if (!project) return [];

  const tables: {
    kind: (typeof DEP_FIELDS)[number];
    table: TomlValue[];
    path: string;
  }[] = [];

  for (const field of DEP_FIELDS) {
    const raw = project[field];
    if (field === "dependencies" && Array.isArray(raw)) {
      tables.push({ kind: field, table: raw, path: "project.dependencies" });
      continue;
    }

    const optional = tableValue(raw);
    if (!optional) continue;

    for (const [group, deps] of Object.entries(optional)) {
      if (!Array.isArray(deps)) continue;
      tables.push({
        kind: field,
        table: deps,
        path: `project.optional-dependencies.${group}`,
      });
    }
  }

  return tables;
}

function parseDependencySpec(spec: string) {
  const trimmed = spec.trim();
  const atIndex = trimmed.indexOf(" @ ");
  if (atIndex > 0) {
    const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?/.exec(trimmed.slice(0, atIndex).trim())?.[1];
    if (!name) return;
    return { name, url: trimmed.slice(atIndex + 3).trim() };
  }

  const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?/.exec(trimmed)?.[1];
  if (!name) return;

  const remainder = trimmed.slice(name.length).trim();
  if (!remainder) return { name };

  return { name, version: remainder };
}

function formatDependencySpec(
  spec: NonNullable<ReturnType<typeof parseDependencySpec>>,
  version: string,
): string {
  if (!spec.version) return spec.name;

  const trimmed = spec.version.trim();
  if (trimmed.startsWith(">=")) return `${spec.name}>=${version}`;
  if (trimmed.startsWith("~=")) return `${spec.name}~=${version}`;
  if (trimmed.startsWith("==")) return `${spec.name}==${version}`;
  if (trimmed.startsWith("^")) return `${spec.name}^${version}`;
  if (trimmed.startsWith("!=")) return `${spec.name}!=${version}`;

  return `${spec.name}>=${version}`;
}

function getUvSource(manifest: TomlTable, name: string) {
  const sources = tableValue(tableValue(tableValue(manifest.tool)?.uv)?.sources);
  const source = tableValue(sources?.[name]);
  if (!source) return;

  return {
    workspace: source.workspace === true,
    path: stringValue(source.path),
  };
}

function resolveFileUrl(basePath: string, url: string): string {
  const raw = url.slice("file:".length);
  if (raw.startsWith("//")) {
    return normalize(decodeURIComponent(raw.replace(/^\/\//, "")));
  }

  return normalize(resolve(basePath, decodeURIComponent(raw)));
}

/** PEP 503 name normalization for PyPI JSON API URLs. */
export function normalizePyPiName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

async function readPyprojectManifest(path: string) {
  const content = await readFile(join(path, "pyproject.toml"), "utf8");
  return { manifest: parse(content) as TomlTable, content };
}

function tableValue(value: TomlValue | undefined): TomlTable | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as TomlTable;
}

function stringValue(value: TomlValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
