import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import initToml, { edit, parse } from "@rainbowatcher/toml-edit-js";
import { satisfies, validRange } from "@renovatebot/pep440";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { BumpType, DraftPolicy, PackageGraph, TegamiContext, TegamiPlugin } from "tegami";
import { WorkspacePackage } from "tegami";
import { execFailure } from "tegami/utils";
import { pyprojectManifestSchema, type PyprojectManifest, type UvIndex } from "./schema";
import { isPackagePublished, updateConstraintRange } from "./utils";

const DEP_FIELDS = ["dependencies", "optional-dependencies", "dependency-groups"] as const;

export class PipPackage extends WorkspacePackage {
  readonly manager = "pip";

  constructor(
    readonly path: string,
    readonly manifest: PyprojectManifest,
    private content: string,
  ) {
    super();
  }

  get name(): string {
    return this.projectInfo.name;
  }

  get version(): string | undefined {
    return this.projectInfo.version;
  }

  setVersion(version: string): void {
    this.projectInfo.version = version;
    this.patch("project.version", version);
  }

  async write(): Promise<void> {
    await writeFile(path.join(this.path, "pyproject.toml"), this.content + "\n");
  }

  patch(path: string, value: unknown): void {
    this.content = edit(this.content, path, value);
  }

  get projectInfo() {
    return this.manifest.project;
  }
}

interface DependentRef {
  dependent: PipPackage;
  kind: (typeof DEP_FIELDS)[number];
  spec: DependencySpec;
  linked: PipPackage;
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
  bumpDep?: (opts: DependentRef) => BumpType | false;

  /**
   * Named `[[tool.uv.index]]` entry for publishing and publish-status checks.
   * Defaults to PyPI when unset.
   */
  publishIndex?: string;
}

export function pip({
  updateLockFile = true,
  bumpDep: getBumpDepType,
  publishIndex,
}: PipPluginOptions = {}): TegamiPlugin {
  let active = false;
  let publishTarget: UvIndex = { name: "pypi", url: "https://pypi.org/simple/" };

  return {
    name: "pip",
    enforce: "post",
    async init() {
      await initToml();
    },
    async resolve() {
      const root = await discoverPipPackages(this.cwd, (pkg) => this.graph.add(pkg));
      if (root && publishIndex) {
        const found = root.tool?.uv?.index?.find((entry) => entry.name === publishIndex);
        if (!found) {
          throw new Error(
            `[Tegami] pip publish index "${publishIndex}" was not found in pyproject.toml.`,
          );
        }
        publishTarget = found;
      }

      active = this.graph.getPackages().some((pkg) => pkg instanceof PipPackage);
    },
    initDraft(plan) {
      if (!active) return;
      plan.addPolicy(depsPolicy(this, getBumpDepType));
    },
    async publishPreflight({ pkg }) {
      if (!(pkg instanceof PipPackage)) return;

      return {
        shouldPublish: pkg.version !== undefined && pkg.projectInfo.private !== true,
      };
    },
    resolvePlanStatus({ plan }) {
      return Array.from(plan.packages, async ([id, { preflight }]) => {
        if (!preflight!.shouldPublish) return;
        const pkg = this.graph.get(id)!;
        if (!(pkg instanceof PipPackage) || !pkg.version) return;
        if (!(await isPackagePublished(pkg.name, pkg.version, publishTarget.url))) return "pending";
      });
    },
    async publish({ pkg }) {
      if (!(pkg instanceof PipPackage)) return;

      const publishArgs = ["publish"];
      if (publishIndex && publishTarget["publish-url"]) {
        publishArgs.push(
          "--publish-url",
          publishTarget["publish-url"],
          "--check-url",
          publishTarget.url,
        );
      } else if (publishIndex) {
        publishArgs.push("--index", publishTarget.name);
      }

      const result = await x("uv", publishArgs, {
        nodeOptions: { cwd: pkg.path },
      });

      if (result.exitCode !== 0) {
        if (
          /already exists|already uploaded|file already exists/i.test(
            `${result.stdout}\n${result.stderr}`,
          )
        ) {
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
            const spec = parseDependencySpec(rawSpec);
            if (!spec || !("version" in spec) || !validRange(spec.version)) {
              next.push(rawSpec);
              continue;
            }

            const linked = resolveLinkedPackage(graph, pkg, spec);
            if (!linked?.version) {
              next.push(rawSpec);
              continue;
            }

            const workspace = pkg.manifest.tool?.uv?.sources?.[spec.name]?.workspace === true;
            if (!workspace || satisfies(linked.version, spec.version)) {
              next.push(rawSpec);
              continue;
            }

            next.push(`${spec.name}${updateConstraintRange(spec.version, linked.version)}`);
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
      case "optional-dependencies":
        return "patch";
      case "dependency-groups":
        return false;
    }
  },
): DraftPolicy {
  const dependentMap = new Map<string, DependentRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof PipPackage)) continue;

    for (const { table, kind } of dependencyTables(pkg.manifest)) {
      for (const rawSpec of table) {
        const spec = parseDependencySpec(rawSpec);
        if (!spec) continue;

        const linked = resolveLinkedPackage(graph, pkg, spec);
        if (!linked) continue;

        const workspace = pkg.manifest.tool?.uv?.sources?.[spec.name]?.workspace === true;
        if (!workspace) continue;

        const refs = dependentMap.get(linked.id);
        if (refs) refs.push({ dependent: pkg, kind, spec, linked });
        else dependentMap.set(linked.id, [{ dependent: pkg, kind, spec, linked }]);
      }
    }
  }

  return {
    id: "pip:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof PipPackage)) return;
      const deps = dependentMap.get(pkg.id);
      if (!deps) return;

      const group = graph.getPackageGroup(pkg.id);
      const bumped = plan.bumpVersion(pkg);
      if (!bumped) return;

      for (const dep of deps) {
        if (group?.options.syncBump && graph.getPackageGroup(dep.dependent.id) === group) {
          continue;
        }

        const bumpType = getBumpDepType(dep);
        if (bumpType === false) continue;

        this.bumpPackage(dep.dependent, {
          type: bumpType,
          reason: `update dependency "${dep.spec.name}"`,
        });
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

  const source = pkg.manifest.tool?.uv?.sources?.[spec.name];
  let absolute: string;

  if (source?.path) {
    absolute = path.resolve(pkg.path, source.path);
  } else if ("url" in spec && spec.url.startsWith("file:")) {
    absolute = fileURLToPath(
      new URL(spec.url, pathToFileURL(path.join(pkg.path, "pyproject.toml"))),
    );
  } else {
    return;
  }

  return graph
    .getPackages()
    .find(
      (candidate): candidate is PipPackage =>
        candidate instanceof PipPackage && candidate.path === absolute,
    );
}

async function buildEntry(dir: string) {
  try {
    const content = await readFile(path.join(dir, "pyproject.toml"), "utf8");
    return {
      manifest: pyprojectManifestSchema.parse(parse(content)),
      content,
      path: dir.endsWith(path.sep) ? dir.slice(0, -1) : dir,
    };
  } catch {
    return;
  }
}

async function discoverPipPackages(
  cwd: string,
  add: (pkg: PipPackage) => void,
): Promise<PyprojectManifest | undefined> {
  const root = await buildEntry(cwd);
  if (!root) return;

  const members = root.manifest.tool?.uv?.workspace?.members;
  if (members && members.length > 0) {
    const paths = await glob(members, {
      absolute: true,
      cwd,
      ignore: ["**/.venv/**", "**/__pycache__/**", "**/dist/**"],
      onlyDirectories: true,
      onlyFiles: false,
    });

    const manifests = await Promise.all(paths.map(buildEntry));

    for (const entry of manifests) {
      if (entry?.manifest.project?.name)
        add(new PipPackage(entry.path, entry.manifest, entry.content));
    }
  } else if (root.manifest.project?.name) {
    add(new PipPackage(cwd, root.manifest, root.content));
  }

  return root.manifest;
}

function dependencyTables(manifest: PyprojectManifest) {
  const project = manifest.project;
  if (!project) return [];

  const tables: {
    kind: (typeof DEP_FIELDS)[number];
    table: string[];
    path: string;
  }[] = [];

  for (const field of DEP_FIELDS) {
    if (field === "dependencies") {
      if (project.dependencies) {
        tables.push({ kind: field, table: project.dependencies, path: "project.dependencies" });
      }
      continue;
    }

    if (field === "optional-dependencies") {
      const optional = project["optional-dependencies"];
      if (!optional) continue;

      for (const [group, deps] of Object.entries(optional)) {
        tables.push({
          kind: field,
          table: deps,
          path: `project.optional-dependencies.${group}`,
        });
      }
      continue;
    }

    const groups = manifest["dependency-groups"];
    if (!groups) continue;

    for (const [group, deps] of Object.entries(groups)) {
      tables.push({
        kind: field,
        table: deps,
        path: `dependency-groups.${group}`,
      });
    }
  }

  return tables;
}

type DependencySpec =
  | {
      name: string;
      version: string;
    }
  | {
      name: string;
      url: string;
    }
  | {
      name: string;
    };

function parseDependencySpec(spec: string): DependencySpec | undefined {
  const trimmed = spec.trim();
  const [content = "", url] = trimmed.split(/\s+@\s+/, 2);

  const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?/.exec(content)?.[1];
  if (!name) return;

  if (url) {
    return { name, url };
  }

  const remainder = trimmed.slice(name.length).trim();
  if (!remainder) return { name };

  return { name, version: remainder };
}
