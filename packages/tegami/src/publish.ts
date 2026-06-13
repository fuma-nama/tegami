import { x } from "tinyexec";
import { filterChangelogsByIds, type TegamiContext } from "./context";
import { ChangelogEntry, PublishPlan } from "./schemas";
import { createGitTag } from "./utils/git";
import type { NpmClient } from "./types";

export interface PublishOptions {
  /** Validate the publish plan without publishing packages, creating tags, or running release plugins. */
  dryRun?: boolean;
  /** Package manager command used for npm registry operations. */
  npmClient?: NpmClient;
  /** Set to false to skip creating git tags after all packages publish successfully. */
  gitTags?: boolean;
}

export interface PublishResult {
  /** Path to the publish plan that was executed. */
  planPath: string;
  plan: PublishPlan;
  state: "success" | "failed";
  packages: PackagePublishResult[];
}

export type PackagePublishResult = (
  | {
      state: "failed";
      error?: string;
    }
  | {
      state: "success";
    }
) & {
  name: string;
  version: string;
  distTag: string;
  gitTag: string | false;
  changelogs: ChangelogEntry[];
};

export async function publishFromPlan(
  context: TegamiContext,
  plan: PublishPlan,
): Promise<PublishResult> {
  const packages = await publishStoredPlan(plan, context);
  const result: PublishResult = {
    plan,
    planPath: context.planPath,
    state: packages.some((pkg) => pkg.state === "failed") ? "failed" : "success",
    packages,
  };

  return createGitTags(plan, context, result);
}

async function publishStoredPlan(
  plan: PublishPlan,
  context: TegamiContext,
): Promise<PackagePublishResult[]> {
  const results: PackagePublishResult[] = [];

  for (const packagePlan of plan.packages) {
    if (!packagePlan.publish) continue;
    const pkg = context.graph.get(packagePlan.name);
    if (!pkg) continue;
    const changelogs = filterChangelogsByIds(plan.changelogs, packagePlan.changelogIds);

    if (!context.publish.dryRun) {
      const published = await context.registryClient.packageVersionExists(
        packagePlan.name,
        packagePlan.version,
      );

      if (published) {
        results.push({
          name: packagePlan.name,
          version: packagePlan.version,
          distTag: packagePlan.distTag,
          gitTag: packagePlan.gitTag,
          state: "success",
          changelogs,
        });
        continue;
      }
    }

    try {
      if (pkg.manifest.name !== packagePlan.name) {
        throw new Error(
          `Expected package ${packagePlan.name}, found ${pkg.manifest.name ?? "unknown"}.`,
        );
      }

      if (pkg.manifest.version !== packagePlan.version) {
        throw new Error(
          `Expected ${packagePlan.name}@${packagePlan.version}, found ${pkg.manifest.version ?? "unknown"}.`,
        );
      }

      if (!context.publish.dryRun) {
        const args = ["publish", "--tag", packagePlan.distTag];

        await x(context.npmClient, args, {
          nodeOptions: {
            cwd: pkg.path,
          },
          throwOnError: true,
        });
      }

      results.push({
        name: packagePlan.name,
        version: packagePlan.version,
        distTag: packagePlan.distTag,
        gitTag: packagePlan.gitTag,
        state: "success",
        changelogs,
      });
    } catch (error) {
      results.push({
        name: packagePlan.name,
        version: packagePlan.version,
        distTag: packagePlan.distTag,
        changelogs,
        gitTag: packagePlan.gitTag,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function createGitTags(
  plan: PublishPlan,
  context: TegamiContext,
  result: PublishResult,
): Promise<PublishResult> {
  const { publish: publishConfig, graph } = context;
  if (publishConfig.dryRun || publishConfig.gitTags === false || result.state === "failed")
    return result;

  for (const release of plan.packages) {
    if (!release.publish || !release.gitTag) continue;

    try {
      await createGitTag(graph.get(release.name)!.path, release.gitTag);
    } catch (error) {
      return {
        ...result,
        state: "failed",
        packages: result.packages.map((pkgResult) => {
          if (pkgResult.name === release.name) {
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
}
