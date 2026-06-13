import { readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { load } from "js-yaml";
import { glob } from "tinyglobby";
import { packageManifestSchema, workspacePatternsSchema, type PackageManifest } from "./schemas";
import { isNodeError } from "./utils/error";

/** Package discovered in the workspace. */
export interface WorkspacePackage {
  name: string;
  path: string;
  version: string;
  private: boolean;
  manifest: PackageManifest;
}

/** Dependency graph for discovered workspace packages. */
export class PackageGraph {
  readonly packages: WorkspacePackage[];
  readonly byName: Map<string, WorkspacePackage>;

  constructor(packages: WorkspacePackage[]) {
    this.packages = packages;
    this.byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  }

  /** Get a package by exact name. */
  get(name: string): WorkspacePackage | undefined {
    return this.byName.get(name);
  }
}

/** Discover workspace packages from pnpm-workspace.yaml or package.json workspaces. */
export async function discoverWorkspace(cwd: string): Promise<PackageGraph> {
  const patterns = await readWorkspacePatterns(cwd);
  const candidatePaths = await expandWorkspacePatterns(cwd, patterns);

  // Read the root manifest and every candidate manifest once, all in parallel.
  // Missing or unnamed manifests are skipped.
  const rootManifestPromise = readManifest(cwd).catch(() => undefined);
  const manifests = await Promise.all(
    candidatePaths.map((path) =>
      readManifest(path)
        .then((manifest) => ({ path, manifest }))
        .catch(() => undefined),
    ),
  );

  const packages: WorkspacePackage[] = [];
  const seen = new Set<string>();

  const rootManifest = await rootManifestPromise;
  if (rootManifest?.name && rootManifest.version && rootManifest.private !== true) {
    packages.push(toWorkspacePackage(cwd, rootManifest));
    seen.add(rootManifest.name);
  }

  for (const entry of manifests) {
    if (!entry?.manifest.name || !entry.manifest.version) continue;
    if (seen.has(entry.manifest.name)) continue;

    seen.add(entry.manifest.name);
    packages.push(toWorkspacePackage(entry.path, entry.manifest));
  }

  return new PackageGraph(packages);
}

function toWorkspacePackage(path: string, manifest: PackageManifest): WorkspacePackage {
  return {
    name: manifest.name!,
    path,
    version: manifest.version!,
    private: manifest.private === true,
    manifest,
  };
}

/** Write a package manifest back to disk. */
export async function writeManifest(
  pkg: WorkspacePackage,
  manifest: PackageManifest,
): Promise<void> {
  const path = join(pkg.path, "package.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readWorkspacePatterns(cwd: string): Promise<string[]> {
  const pnpmPatterns = await readFile(join(cwd, "pnpm-workspace.yaml"), "utf8")
    .then((content) => workspacePatternsSchema.parse(load(content) ?? {}))
    .catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });

  if (pnpmPatterns) {
    return pnpmPatterns;
  }

  const rootManifest = await readManifest(cwd).catch(() => undefined);
  return rootManifest?.workspaces ?? ["."];
}

async function expandWorkspacePatterns(cwd: string, patterns: string[]): Promise<string[]> {
  const paths = patterns.includes(".") ? [cwd] : [];
  const globPatterns = patterns.filter((pattern) => pattern !== ".");

  if (globPatterns.length > 0) {
    const globPaths = await glob(globPatterns, {
      absolute: true,
      cwd,
      ignore: ["**/node_modules/**"],
      onlyDirectories: true,
      onlyFiles: false,
    });
    paths.push(...globPaths);
  }

  return paths.map(normalizePackagePath);
}

function normalizePackagePath(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
}

async function readManifest(packagePath: string): Promise<PackageManifest> {
  const content = await readFile(join(packagePath, "package.json"), "utf8");
  return packageManifestSchema.parse(JSON.parse(content));
}
