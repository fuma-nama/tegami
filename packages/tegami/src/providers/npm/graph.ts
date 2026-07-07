import typia from "typia";
import * as semver from "semver";
import { glob } from "tinyglobby";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { isSeq, parseDocument } from "yaml";
import type { Document } from "yaml";
import { isNodeError } from "../../utils/error";
import type { AgentName } from "package-manager-detector";
import { WorkspacePackage } from "../../graph";
import type { PackageDraft } from "../../plans/draft";

export class NpmPackage extends WorkspacePackage {
  readonly manager = "npm";
  private dependencies: ResolvedNpmDependency[] | undefined;

  constructor(
    readonly path: string,
    readonly manifest: PackageManifest,
  ) {
    super();
  }

  get name(): string {
    return this.manifest.name;
  }

  get version(): string | undefined {
    return this.manifest.version;
  }

  async write(): Promise<void> {
    await writeFile(
      path.join(this.path, "package.json"),
      `${JSON.stringify(this.manifest, null, 2)}\n`,
    );
  }

  initDraft() {
    const defaults = super.initDraft();
    defaults.npm = {
      distTag: this.manifest.publishConfig?.tag,
    };

    return defaults;
  }

  getRegistry(): string {
    return this.manifest.publishConfig?.registry ?? "https://registry.npmjs.org";
  }

  configureDraft({ draft }: { draft: PackageDraft }): void {
    super.configureDraft({ draft });

    const { distTag = this.group?.options?.npm?.distTag } = this.options.npm ?? {};

    if (distTag) {
      draft.npm ??= {};
      draft.npm.distTag = distTag;
    } else if (draft.prerelease) {
      draft.npm ??= {};
      draft.npm.distTag ??= draft.prerelease;
    }
  }

  listDependencies(graph: NpmGraph) {
    return (this.dependencies ??= listDependencies(graph, this));
  }
}

export interface BunWorkspaces {
  packages?: string[];
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
}

export interface PackageManifest {
  name: string;
  version?: string;
  private?: boolean;
  publishConfig?: {
    access?: "public" | "restricted";
    registry?: string;
    tag?: string;
  };
  scripts?: Record<string, string>;
  workspaces?: string[] | BunWorkspaces;
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const assertPackageManifest = typia.createAssert<PackageManifest>();

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type DepField = (typeof DEP_FIELDS)[number];

export type DependencySpec =
  | {
      protocol: "workspace";
      range: string;
      packageName?: string;
      path?: string;
    }
  | {
      protocol: "file" | "portal";
      path: string;
    }
  | {
      protocol: "catalog";
      catalogName: string;
    }
  | {
      protocol: "npm";
      alias: string;
      range: string;
    }
  | {
      range: string;
      protocol?: undefined;
    };

export function listDependencies(graph: NpmGraph, pkg: NpmPackage) {
  const out: ResolvedNpmDependency[] = [];

  for (const field of DEP_FIELDS) {
    const table = pkg.manifest[field];
    if (!table) continue;

    for (const [name, raw] of Object.entries(table)) {
      out.push(
        resolveDependency(graph, pkg, field, name, raw, (range) => {
          table[name] = range;
        }),
      );
    }
  }

  return out;
}

export function parseDependencySpec(raw: string): DependencySpec {
  if (raw.startsWith("workspace:")) {
    const body = raw.slice("workspace:".length);
    if (!body) return { protocol: "workspace", range: "*" };

    if (body.startsWith(".") || body.startsWith("/")) {
      return { protocol: "workspace", range: body, path: body };
    }

    const separator = body.lastIndexOf("@");
    if (separator > 0) {
      return {
        protocol: "workspace",
        packageName: body.slice(0, separator),
        range: body.slice(separator + 1) || "*",
      };
    }

    // Scoped package name without an explicit range (e.g. workspace:@acme/core).
    if (separator === 0) {
      return { protocol: "workspace", packageName: body, range: "*" };
    }

    return { protocol: "workspace", range: body };
  }

  if (raw.startsWith("file:")) {
    return { protocol: "file", path: raw.slice("file:".length) };
  }

  if (raw.startsWith("portal:")) {
    return { protocol: "portal", path: raw.slice("portal:".length) };
  }

  if (raw === "catalog:") {
    return { protocol: "catalog", catalogName: "default" };
  }

  if (raw.startsWith("catalog:")) {
    return {
      protocol: "catalog",
      catalogName: raw.slice("catalog:".length).trim() || "default",
    };
  }

  if (raw.startsWith("npm:")) {
    const spec = raw.slice("npm:".length);
    const separator = spec.lastIndexOf("@");
    if (separator > 0) {
      return {
        protocol: "npm",
        alias: spec.slice(0, separator),
        range: spec.slice(separator + 1),
      };
    }
  }

  return { range: raw };
}

export function formatDependencySpec(spec: DependencySpec, range?: string): string {
  switch (spec.protocol) {
    case "workspace":
      if (spec.path) return `workspace:${spec.path}`;
      if (spec.packageName) {
        const next = range ?? spec.range;
        return `workspace:${spec.packageName}@${next}`;
      }
      return `workspace:${range ?? spec.range}`;
    case "file":
      return `file:${spec.path}`;
    case "portal":
      return `portal:${spec.path}`;
    case "catalog":
      return spec.catalogName === "default" ? "catalog:" : `catalog:${spec.catalogName}`;
    case "npm":
      return `npm:${spec.alias}@${range ?? spec.range}`;
    default:
      return range ?? spec.range;
  }
}

export interface ResolvedNpmDependency {
  field: DepField;
  name: string;
  spec: DependencySpec;
  linked?: NpmPackage;
  range?: string;
  setRange?: (range: string) => void;
}

export interface NpmGraph {
  root: string;
  /** package name -> package */
  packages: Map<string, NpmPackage>;
  packagesByPath: Map<string, NpmPackage>;
  catalogs: CatalogSource[];
}

interface CatalogSource {
  resolve(name: string, catalogName: string): string | undefined;
  setRange(name: string, catalogName: string, range: string): void;
  write?: () => Promise<void>;
}

export async function resolveNpmGraph(cwd: string, client: AgentName): Promise<NpmGraph> {
  const packages = new Map<string, NpmPackage>();
  const packagesByPath = new Map<string, NpmPackage>();
  const catalogSources: CatalogSource[] = [];

  function addPackage(packagePath: string, manifest: PackageManifest) {
    const pkg = new NpmPackage(packagePath, manifest);
    packages.set(pkg.name, pkg);
    packagesByPath.set(packagePath, pkg);
  }

  const patterns: string[] = [];
  const rootManifest = await readManifest(cwd).catch(() => undefined);
  if (rootManifest) {
    catalogSources.push(createRootCatalogSource(rootManifest));
    if (rootManifest.name) {
      addPackage(cwd, rootManifest);
    }

    if (Array.isArray(rootManifest.workspaces)) {
      patterns.push(...rootManifest.workspaces);
    } else if (rootManifest.workspaces?.packages) {
      patterns.push(...rootManifest.workspaces.packages);
    }
  }

  let workspaceFiles: string[] | undefined;
  switch (client) {
    case "pnpm":
      workspaceFiles = ["pnpm-workspace.yaml"];
      break;
    case "nub":
      workspaceFiles = ["pnpm-workspace.yaml"];
      break;
    case "aube":
      workspaceFiles = ["pnpm-workspace.yaml", "aube-workspace.yaml"];
      break;
    case "yarn":
      const yarnCatalog = await readYarnCatalog(cwd);
      if (yarnCatalog) catalogSources.push(yarnCatalog);
      break;
  }

  if (workspaceFiles) {
    await Promise.all(
      workspaceFiles.map(async (name) => {
        const filePath = path.join(cwd, name);
        const content = await readFile(filePath, "utf8").catch((error: unknown) => {
          if (isNodeError(error) && error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!content) return;

        const doc = parseDocument(content);
        const packages = doc.get("packages");

        catalogSources.push(createWorkspaceCatalogSource(filePath, doc));
        if (isSeq(packages)) {
          for (const pkg of packages.toJSON()) {
            if (typeof pkg === "string") patterns.push(pkg);
          }
        }
      }),
    );
  }

  if (patterns?.length) {
    const candidatePaths = await expandWorkspacePatterns(cwd, patterns);
    await Promise.all(
      candidatePaths.map(async (packagePath) => {
        const manifest = await readManifest(packagePath).catch(() => undefined);
        if (!manifest) return;
        addPackage(packagePath, manifest);
      }),
    );
  }

  return {
    root: cwd,
    packages,
    packagesByPath,
    catalogs: catalogSources,
  };
}

export function resolveDependency(
  graph: NpmGraph,
  dependent: NpmPackage,
  field: DepField,
  name: string,
  raw: string,
  write: (value: string) => void,
): ResolvedNpmDependency {
  const spec = parseDependencySpec(raw);
  const linked = resolveLinkedPackage(graph, dependent, name, spec);
  let range: string | undefined;
  let customSetRange: ((range: string) => void) | undefined;
  switch (spec.protocol) {
    case "catalog": {
      for (const source of graph.catalogs) {
        const resolved = source.resolve(name, spec.catalogName);
        if (!resolved) continue;

        range = resolved;
        customSetRange = (v) => source.setRange(name, spec.catalogName, v);
        break;
      }
      break;
    }
    case "workspace":
      range = semver.validRange(spec.range) ? spec.range : undefined;
      break;
    case "npm":
    case undefined:
      range = spec.range;
      break;
  }

  return {
    field,
    name,
    spec,
    linked,
    range,
    setRange(nextRange) {
      if (customSetRange) {
        customSetRange(nextRange);
        return;
      }

      write(formatDependencySpec(spec, nextRange));
    },
  };
}

function resolveLinkedPackage(
  graph: NpmGraph,
  dependent: NpmPackage,
  name: string,
  spec: DependencySpec,
): NpmPackage | undefined {
  switch (spec.protocol) {
    case "workspace":
      if (spec.path) return findPackageByPath(graph, dependent.path, spec.path);
      return graph.packages.get(spec.packageName || name);
    case "file":
    case "portal":
      return findPackageByPath(graph, dependent.path, spec.path);
    case "npm":
      return graph.packages.get(spec.alias);
    default:
      return graph.packages.get(name);
  }
}

function findPackageByPath(graph: NpmGraph, from: string, target: string): NpmPackage | undefined {
  let absolute = path.resolve(from, target);
  if (path.basename(absolute) === "package.json") {
    absolute = path.dirname(absolute);
  }
  return graph.packagesByPath.get(absolute);
}

async function expandWorkspacePatterns(cwd: string, patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];

  const results = await glob(patterns, {
    absolute: true,
    cwd,
    ignore: ["**/node_modules/**", "**/dist/**"],
    onlyDirectories: true,
    onlyFiles: false,
  });

  return results.map((item) => (item.endsWith(path.sep) ? item.slice(0, -1) : item));
}

async function readManifest(packagePath: string): Promise<PackageManifest> {
  const content = await readFile(path.join(packagePath, "package.json"), "utf8");
  const parsed = JSON.parse(content);
  assertPackageManifest(parsed);
  return parsed;
}

function createWorkspaceCatalogSource(filePath: string, doc: Document): CatalogSource {
  return {
    resolve(name, catalogName) {
      const value = doc.getIn(
        catalogName === "default" ? ["catalog", name] : ["catalogs", catalogName, name],
      );
      return typeof value === "string" ? value : undefined;
    },
    setRange(name, catalogName, range) {
      doc.setIn(
        catalogName === "default" ? ["catalog", name] : ["catalogs", catalogName, name],
        range,
      );
    },
    async write() {
      const output = doc.toString();
      await writeFile(filePath, output.endsWith("\n") ? output : `${output}\n`);
    },
  };
}

function createRootCatalogSource(manifest: PackageManifest): CatalogSource {
  return {
    resolve(name, catalogName) {
      const fromWorkspaces =
        typeof manifest.workspaces === "object" && !Array.isArray(manifest.workspaces)
          ? catalogName === "default"
            ? manifest.workspaces.catalog?.[name]
            : manifest.workspaces.catalogs?.[catalogName]?.[name]
          : undefined;
      if (fromWorkspaces) return fromWorkspaces;

      if (catalogName === "default") return manifest.catalog?.[name];
      return manifest.catalogs?.[catalogName]?.[name];
    },
    setRange(name, catalogName, range) {
      if (typeof manifest.workspaces === "object" && !Array.isArray(manifest.workspaces)) {
        if (catalogName === "default") {
          manifest.workspaces.catalog ??= {};
          manifest.workspaces.catalog[name] = range;
        } else {
          manifest.workspaces.catalogs ??= {};
          manifest.workspaces.catalogs[catalogName] ??= {};
          manifest.workspaces.catalogs[catalogName]![name] = range;
        }
      } else if (catalogName === "default") {
        manifest.catalog ??= {};
        manifest.catalog[name] = range;
      } else {
        manifest.catalogs ??= {};
        manifest.catalogs[catalogName] ??= {};
        manifest.catalogs[catalogName]![name] = range;
      }
    },
  };
}

async function readYarnCatalog(cwd: string): Promise<CatalogSource | undefined> {
  const filePath = path.join(cwd, ".yarnrc.yml");
  const content = await readFile(filePath, "utf8").catch(() => undefined);
  if (!content) return;

  const doc = parseDocument(content);

  return {
    resolve(name, catalogName) {
      const value = doc.getIn(
        catalogName === "default" ? ["catalog", name] : ["catalogs", catalogName, name],
      );
      return typeof value === "string" ? value : undefined;
    },
    setRange(name, catalogName, range) {
      doc.setIn(
        catalogName === "default" ? ["catalog", name] : ["catalogs", catalogName, name],
        range,
      );
    },
    async write() {
      const output = doc.toString();
      await writeFile(filePath, output.endsWith("\n") ? output : `${output}\n`);
    },
  };
}
