import { x } from "tinyexec";
import type { TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { isCI } from "../utils/constants";
import { TegamiContext } from "../context";
import type { PackagePublishResult } from "../publish";

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

  function resolveGitTag(context: TegamiContext, result: PackagePublishResult): string {
    const pkg = context.graph.get(result.id);
    const groupName = pkg?.getPackageOptions().group;
    const group = groupName ? context.graph.getGroup(groupName) : undefined;
    if (group?.options.syncGitTag) {
      return `${group.name}@${result.version}`;
    }

    return `${result.name}@${result.version}`;
  }

  return {
    name: "git",
    enforce: "pre",
    cli: {
      async init() {
        if (!isCI()) return;

        const gitOptions = { nodeOptions: { cwd: this.cwd } };

        for (const args of [
          ["config", "user.name", "github-actions[bot]"],
          ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
        ] as const) {
          const result = await x("git", [...args], gitOptions);
          if (result.exitCode !== 0) {
            throw execFailure("Failed to configure git user for GitHub Actions.", result);
          }
        }
      },
    },
    async afterPublish(result) {
      const {
        cwd,
        publishOptions: { dryRun = false },
      } = this;
      if (dryRun || !createTags || result.state !== "created") return result;

      const pendingTags = new Set<string>();

      for (const pkg of result.packages) {
        pkg.gitTag = resolveGitTag(this, pkg);
        pendingTags.add(pkg.gitTag);
      }

      try {
        const createdTags: string[] = [];

        await Promise.all(
          Array.from(pendingTags).map(async (tag) => {
            if (await gitTagExists(cwd, tag)) return;

            const gitOut = await x("git", ["tag", tag], {
              nodeOptions: { cwd },
            });

            if (gitOut.exitCode !== 0)
              throw execFailure(`Failed to create Git tag "${tag}" for release`, gitOut);

            createdTags.push(tag);
          }),
        );

        if (pushTags && createdTags.length > 0) {
          const gitOut = await x("git", ["push", "origin", ...createdTags], {
            nodeOptions: { cwd },
          });

          if (gitOut.exitCode !== 0) {
            throw execFailure(
              `Failed to push Git tags to origin: ${createdTags.join(", ")}`,
              gitOut,
            );
          }
        }
      } catch (error) {
        return {
          ...result,
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }

      return result;
    },
  };
}

async function gitTagExists(cwd: string, tag: string): Promise<boolean> {
  const result = await x("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    nodeOptions: {
      cwd,
    },
  });

  return result.exitCode === 0;
}
