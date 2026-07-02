import { x } from "tinyexec";
import type { TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { isCI } from "../utils/common";
import type { PublishPlan } from "../plans/publish";

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

  function getPendingTags(plan: PublishPlan) {
    const pendingTags = new Set<string>();
    const dryRun = plan.options.dryRun ?? false;

    if (dryRun || !createTags) return pendingTags;

    for (const pkg of plan.packages.values()) {
      if (!pkg.preflight!.shouldPublish) continue;
      if (pkg.publishResult && pkg.publishResult.type === "failed") continue;

      const tag = pkg.git?.tag;
      if (tag) pendingTags.add(tag);
    }
    return pendingTags;
  }

  return {
    name: "git",
    enforce: "pre",
    async initCli() {
      if (!isCI()) return;

      const gitOptions = { nodeOptions: { cwd: this.cwd } };

      for (const args of [
        ["config", "user.name", "github-actions[bot]"],
        ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
      ] as const) {
        const result = await x("git", args, gitOptions);
        if (result.exitCode !== 0) {
          throw execFailure("Failed to configure git user for GitHub Actions.", result);
        }
      }
    },
    initPublishPlan({ plan }) {
      const { graph } = this;

      for (const [id, packagePlan] of plan.packages) {
        const pkg = graph.get(id)!;
        packagePlan.git ??= {};

        if (pkg.group?.options.syncGitTag && pkg.version) {
          packagePlan.git.tag = `${pkg.group.name}@${pkg.version}`;
        } else if (pkg.version) {
          packagePlan.git.tag = `${pkg.name}@${pkg.version}`;
        }
      }
    },
    async resolvePlanStatus({ plan }) {
      const pendingTags = getPendingTags(plan);

      return Array.from(pendingTags, async (tag) => {
        const local = await x("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
          nodeOptions: { cwd: this.cwd },
        });
        if (local.exitCode === 0) return;

        // check from remote if `git pull` is not necessarily ran.
        const origin = await x(
          "git",
          ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
          { nodeOptions: { cwd: this.cwd } },
        );

        if (origin.exitCode === 0) return;
        return "pending";
      });
    },
    async afterPublishAll({ plan }) {
      const { cwd } = this;
      const createdTags: string[] = [];
      const pendingTags = getPendingTags(plan);
      if (pendingTags.size === 0) return;

      await Promise.all(
        Array.from(pendingTags, async (tag) => {
          const gitOut = await x("git", ["tag", tag], {
            nodeOptions: { cwd },
          });

          if (gitOut.exitCode !== 0) {
            if (/already exists/i.test(`${gitOut.stdout}\n${gitOut.stderr}`)) return;

            throw execFailure(`Failed to create Git tag "${tag}" for release`, gitOut);
          }

          createdTags.push(tag);
        }),
      );

      if (pushTags && createdTags.length > 0) {
        const gitOut = await x("git", ["push", "origin", ...createdTags], {
          nodeOptions: { cwd },
        });

        if (gitOut.exitCode !== 0) {
          // this can happen in two concurrent runs: one of it pushed the tags, while another one just passed `git tag` but not pushed yet.
          if (/already exists/i.test(`${gitOut.stdout}\n${gitOut.stderr}`)) return;

          throw execFailure(`Failed to push Git tags to origin: ${createdTags.join(", ")}`, gitOut);
        }
      }
    },
  };
}
