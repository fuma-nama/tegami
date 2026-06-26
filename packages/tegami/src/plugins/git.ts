import { x } from "tinyexec";
import type { TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { isCI } from "../utils/constants";
import type { PackagePublishPlan, PublishPlan } from "../plans/publish";

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

  function getPendingTags(plan: PublishPlan, filterPackage?: (pkg: PackagePublishPlan) => boolean) {
    const pendingTags = new Set<string>();
    const dryRun = plan.options.dryRun ?? false;

    if (dryRun || !createTags) return pendingTags;

    for (const pkg of plan.packages.values()) {
      if (filterPackage && !filterPackage(pkg)) continue;

      const tag = pkg.git?.tag;
      if (tag) pendingTags.add(tag);
    }
    return pendingTags;
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
    initPublishPlan({ plan }) {
      const { graph } = this;

      for (const [id, packagePlan] of plan.packages) {
        const pkg = graph.get(id)!;
        const group = pkg && graph.getPackageGroup(pkg.id);

        let tag: string;
        if (group?.options.syncGitTag) {
          tag = `${group.name}@${pkg.version}`;
        } else {
          tag = `${pkg.name}@${pkg.version}`;
        }

        packagePlan.git = { tag };
      }
    },
    async resolvePlanStatus({ plan }) {
      const pendingTags = getPendingTags(plan, (pkg) => pkg.preflight!.publish ?? true);
      if (pendingTags.size === 0) return;

      try {
        await Promise.all(
          Array.from(pendingTags, async (tag) => {
            if (!(await gitTagExists(this.cwd, tag))) throw "pending";
          }),
        );
      } catch (e) {
        if (e === "pending") return "pending";
        throw e;
      }
    },
    async afterPublishAll({ plan }) {
      const { cwd } = this;
      const createdTags: string[] = [];
      const pendingTags = getPendingTags(plan, (pkg) => pkg.publishResult!.type === "published");
      if (pendingTags.size === 0) return;

      await Promise.all(
        Array.from(pendingTags, async (tag) => {
          if (await gitTagExists(cwd, tag)) return;

          const gitOut = await x("git", ["tag", tag], {
            nodeOptions: { cwd },
          });

          if (gitOut.exitCode !== 0) {
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
          throw execFailure(`Failed to push Git tags to origin: ${createdTags.join(", ")}`, gitOut);
        }
      }
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
