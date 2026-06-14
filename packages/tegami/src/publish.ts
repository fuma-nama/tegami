import type { TegamiContext } from "./context";
import { createGitTag } from "./utils/git";
import type { ChangelogEntry } from "./markdown";
import type { PlanStore } from "./schemas";

export interface PublishOptions {
  /** Validate the publish plan without publishing packages, creating tags, or running release plugins. */
  dryRun?: boolean;
  /** Set to false to skip creating git tags after all packages publish successfully. */
  gitTags?: boolean;
}

export interface PublishResult {
  /** Path to the publish plan that was executed. */
  planPath: string;
  state: "success" | "failed";
  packages: PackagePublishResult[];

  /** the persisted plan object. This is not a public API, can be changed without notice */
  _rawPlan: PlanStore;
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
  distTag: string | undefined;
  gitTag?: string;
  changelogs: ChangelogEntry[];
};

export async function publishFromPlan(
  context: TegamiContext,
  plan: PlanStore,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const packages = await publishStoredPlan(plan, context, options);
  const result: PublishResult = {
    planPath: context.planPath,
    state: packages.some((pkg) => pkg.state === "failed") ? "failed" : "success",
    packages,
    _rawPlan: plan,
  };

  return createGitTags(context, result, options);
}

async function publishStoredPlan(
  store: PlanStore,
  context: TegamiContext,
  { dryRun = false }: PublishOptions,
): Promise<PackagePublishResult[]> {
  const results: PackagePublishResult[] = [];

  for (const [name, plan] of Object.entries(store.packages)) {
    if (!plan.publish) continue;

    const pkg = context.graph.get(name);
    if (!pkg || !pkg.manifest.version) continue;

    const changelogs: ChangelogEntry[] = [];
    for (const id of plan.changelogIds) {
      const entry = store.changelogs[id];
      if (entry)
        changelogs.push({
          ...entry,
          packages: new Set(entry.packages),
          id,
        });
    }

    if (!dryRun) {
      const published = await context.registryClient.packageVersionExists(
        pkg.name,
        pkg.manifest.version,
      );

      if (published) {
        results.push({
          name: pkg.name,
          version: pkg.manifest.version,
          distTag: plan.distTag,
          state: "success",
          changelogs,
        });
        continue;
      }
    }

    try {
      if (!dryRun) {
        await context.registryClient.publish({
          path: pkg.path,
          distTag: plan.distTag,
        });
      }

      results.push({
        name: pkg.name,
        version: pkg.manifest.version,
        distTag: plan.distTag,
        state: "success",
        changelogs,
      });
    } catch (error) {
      results.push({
        name: pkg.name,
        version: pkg.manifest.version,
        distTag: plan.distTag,
        changelogs,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function createGitTags(
  context: TegamiContext,
  result: PublishResult,
  { dryRun = false, gitTags = true }: PublishOptions,
): Promise<PublishResult> {
  const { graph } = context;
  if (dryRun || !gitTags || result.state === "failed") return result;

  for (const pkg of result.packages) {
    try {
      const gitTag = `${pkg.name}@${pkg.version}`;
      await createGitTag(graph.get(pkg.name)!.path, gitTag);
      pkg.gitTag = gitTag;
    } catch (error) {
      return {
        ...result,
        state: "failed",
        packages: result.packages.map((pkgResult) => {
          if (pkgResult.name === pkg.name) {
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
