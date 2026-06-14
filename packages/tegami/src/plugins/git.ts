import { x } from "tinyexec";
import type { TegamiPlugin } from "../types";
import { isCI } from "../utils/constants";

export interface GitPluginOptions {
  /** Set to false to skip creating git tags after all packages publish successfully. */
  createTags?: boolean;
  /** Push created tags to origin. Defaults to true in CI. */
  pushTags?: boolean;
}

/**
 * Basic Git integrations:
 * - auto tags.
 *
 * Note: you do not need this with `github` plugin enabled.
 */
export function git(options: GitPluginOptions = {}): TegamiPlugin {
  const { createTags = true, pushTags = isCI() } = options;

  return {
    name: "git",
    enforce: "pre",
    async afterPublish(result) {
      const {
        cwd,
        graph,
        publishOptions: { dryRun = false },
      } = this;
      if (dryRun || !createTags || result.state !== "created") return result;

      const createdTags: string[] = [];

      for (const pkg of result.packages) {
        try {
          const gitTag = `${pkg.name}@${pkg.version}`;
          const packagePath = graph.get(pkg.id)!.path;
          if (await createGitTag(packagePath, gitTag)) createdTags.push(gitTag);
          pkg.gitTag = gitTag;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            ...result,
            state: "failed",
            error: errorMessage,
            packages: result.packages.map((pkgResult) => {
              if (pkgResult.id === pkg.id) {
                return {
                  ...pkgResult,
                  state: "failed",
                  error: errorMessage,
                };
              }

              return pkgResult;
            }),
          };
        }
      }

      if (pushTags && createdTags.length > 0) {
        try {
          await pushGitTags(cwd, createdTags);
        } catch (error) {
          return {
            ...result,
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      return result;
    },
  };
}

/** create a Git tag, ignored if already exists */
async function createGitTag(cwd: string, tag: string): Promise<boolean> {
  if (await gitTagExists(cwd, tag)) return false;

  await x("git", ["tag", tag], {
    nodeOptions: {
      cwd,
    },
    throwOnError: true,
  });

  return true;
}

async function gitTagExists(cwd: string, tag: string): Promise<boolean> {
  const result = await x("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    nodeOptions: {
      cwd,
    },
  });

  return result.exitCode === 0;
}

async function pushGitTags(cwd: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;

  await x("git", ["push", "origin", ...tags], {
    nodeOptions: {
      cwd,
    },
    throwOnError: true,
  });
}
