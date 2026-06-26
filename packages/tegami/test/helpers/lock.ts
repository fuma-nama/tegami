import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump } from "js-yaml";
import { lockDumpOptions } from "../../src/plans/lock";

export interface LockChangelog {
  filename: string;
  content: string;
}

export interface LockPackage {
  id: string;
  updated?: boolean;
  changelogIds?: string[];
}

export interface LockNpmPackage {
  id: string;
  distTag?: string;
}

/** Write a minimal publish-lock.yaml fixture for tests. */
export async function writePublishLock(
  cwd: string,
  options: {
    changelogs?: LockChangelog[];
    packages?: LockPackage[];
    npm?: LockNpmPackage[];
    path?: string;
  } = {},
): Promise<string> {
  const lockPath = options.path ?? join(cwd, ".tegami/publish-lock.yaml");
  const data: Record<string, unknown[]> = {};

  if (options.changelogs?.length) {
    data["core:changelogs"] = options.changelogs.map((entry) => ({
      v: "0.0.0",
      filename: entry.filename,
      content: entry.content,
    }));
  }

  if (options.packages?.length) {
    data["core:packages"] = options.packages.map((pkg) => ({
      id: pkg.id,
      updated: pkg.updated ?? true,
      ...(pkg.changelogIds ? { changelogIds: pkg.changelogIds } : {}),
    }));
  }

  if (options.npm?.length) {
    data["npm:packages"] = options.npm.map((pkg) => ({
      id: pkg.id,
      ...(pkg.distTag ? { distTag: pkg.distTag } : {}),
    }));
  }

  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await writeFile(lockPath, dump(data, lockDumpOptions) + "\n");
  return lockPath;
}
