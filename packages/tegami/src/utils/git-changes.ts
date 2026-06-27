import { join, relative } from "node:path";
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

  await Promise.all(
    [
      ["diff", "--name-only"],
      ["diff", "--cached", "--name-only"],
    ].map(async (args) => {
      const result = await x("git", args, { nodeOptions: { cwd } });
      if (result.exitCode !== 0) return;

      for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) files.add(trimmed);
      }
    }),
  );

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
    const fullPath = join(cwd, file);

    for (const pkg of packages) {
      if (!relative(pkg.path, fullPath).startsWith("..")) {
        matched.set(pkg.id, pkg);
        break;
      }
    }
  }

  return [...matched.values()];
}
