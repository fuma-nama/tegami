import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PublishLock } from "../../src/plans/lock";

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
    npmMarkLatest?: string[];
    path?: string;
  } = {},
): Promise<string> {
  const lockPath = options.path ?? join(cwd, ".tegami/publish-lock.yaml");
  const lock = new PublishLock();

  if (options.changelogs?.length) {
    for (const entry of options.changelogs) {
      lock.write("core:changelogs", {
        v: "0.0.0",
        filename: entry.filename,
        content: entry.content,
      });
    }
  }

  if (options.packages?.length) {
    for (const pkg of options.packages) {
      lock.write("core:packages", {
        id: pkg.id,
        updated: pkg.updated ?? true,
        ...(pkg.changelogIds ? { changelogIds: pkg.changelogIds } : {}),
      });
    }
  }

  if (options.npm?.length) {
    for (const pkg of options.npm) {
      lock.write("npm:packages", {
        id: pkg.id,
        ...(pkg.distTag ? { distTag: pkg.distTag } : {}),
      });
    }
  }

  if (options.npmMarkLatest?.length) {
    for (const id of options.npmMarkLatest) {
      lock.write("npm:mark-latest", { id });
    }
  }

  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await writeFile(lockPath, lock.serialize());
  return lockPath;
}
