import { x } from "tinyexec";
import type { TegamiPlugin } from "../types";

export interface GitPluginOptions {
  /** Set to false to skip creating git tags after all packages publish successfully. */
  createTags?: boolean;
}

/**
 * Basic Git integrations:
 * - auto tags.
 *
 * Note: you do not need this with `github` plugin enabled.
 */
export function git(options: GitPluginOptions = {}): TegamiPlugin {
  const { createTags = true } = options;

  return {
    name: "git",
    enforce: "pre",
    async afterPublish(result) {
      const {
        graph,
        publishOptions: { dryRun = false },
      } = this;
      if (dryRun || !createTags || result.state === "failed") return result;

      for (const pkg of result.packages) {
        try {
          const gitTag = `${pkg.name}@${pkg.version}`;
          await createGitTag(graph.get(pkg.id)!.path, gitTag);
          pkg.gitTag = gitTag;
        } catch (error) {
          return {
            ...result,
            state: "failed",
            packages: result.packages.map((pkgResult) => {
              if (pkgResult.id === pkg.id) {
                return {
                  ...pkgResult,
                  state: "failed",
                  error: error instanceof Error ? error.message : String(error),
                };
              }

              return pkgResult;
            }),
          };
        }
      }

      return result;
    },
  };
}

/** create a Git tag, ignored if already exists */
export async function createGitTag(cwd: string, tag: string): Promise<void> {
  if (await gitTagExists(cwd, tag)) return;

  await x("git", ["tag", tag], {
    nodeOptions: {
      cwd,
    },
    throwOnError: true,
  });
}

export async function gitTagExists(cwd: string, tag: string): Promise<boolean> {
  const result = await x("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    nodeOptions: {
      cwd,
    },
  });

  return result.exitCode === 0;
}
