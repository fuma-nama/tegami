import { join, relative } from "node:path";
import { x } from "tinyexec";
import type { WorkspacePackage } from "../graph";

export async function getChangedPackages(
  packages: WorkspacePackage[],
  cwd: string,
): Promise<Set<WorkspacePackage>> {
  const files = await getChangedFilePaths(cwd);
  const sortedPackages = packages.toSorted((a, b) => b.path.length - a.path.length);
  const matched = new Set<WorkspacePackage>();

  for (const file of files) {
    const fullPath = join(cwd, file);

    for (const pkg of sortedPackages) {
      if (!relative(pkg.path, fullPath).startsWith("..")) {
        matched.add(pkg);
        break;
      }
    }
  }

  return matched;
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
