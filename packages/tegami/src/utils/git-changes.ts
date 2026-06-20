import { isAbsolute, join, normalize, relative } from "node:path";
import { x } from "tinyexec";
import type { PackageGraph, WorkspacePackage } from "../graph";

export async function getChangedPackages(
  graph: PackageGraph,
  cwd: string,
): Promise<WorkspacePackage[]> {
  const files = await getChangedFilePaths(cwd);
  return resolveChangedPackages(graph, files, cwd);
}

export async function getChangedFilePaths(cwd: string): Promise<string[]> {
  const files = new Set<string>();

  for (const args of [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
  ]) {
    await addGitOutput(files, cwd, args);
  }

  return Array.from(files);
}

export function resolveChangedPackages(
  graph: PackageGraph,
  files: string[],
  cwd: string,
): WorkspacePackage[] {
  const packages = [...graph.getPackages()].sort((a, b) => b.path.length - a.path.length);
  const matched = new Map<string, WorkspacePackage>();

  for (const file of files) {
    for (const pkg of packages) {
      if (isUnderDir(file, pkg.path, cwd)) {
        matched.set(pkg.id, pkg);
        break;
      }
    }
  }

  return [...matched.values()];
}

function isUnderDir(file: string, dir: string, cwd: string): boolean {
  const absolute = join(cwd, file);
  const pkg = normalize(dir);
  const rel = relative(pkg, absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function addGitOutput(files: Set<string>, cwd: string, args: string[]): Promise<void> {
  const result = await x("git", args, { nodeOptions: { cwd } });
  if (result.exitCode !== 0) return;

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }
}
