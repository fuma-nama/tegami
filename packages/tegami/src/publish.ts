import type { TegamiContext } from "./context";
import type { ChangelogEntry } from "./markdown";
import type { PlanStore } from "./schemas";

export interface PublishOptions {
  /** Validate the publish plan without publishing packages, creating tags, or running release plugins. */
  dryRun?: boolean;
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
  id: string;
  name: string;
  version: string;
  distTag: string | undefined;
  gitTag?: string;
  changelogs: ChangelogEntry[];
};

export async function publishFromPlan(
  context: TegamiContext,
  plan: PlanStore,
  options: PublishOptions,
): Promise<PublishResult> {
  const packages = await publishStoredPlan(plan, context, options);
  return {
    planPath: context.planPath,
    state: packages.some((pkg) => pkg.state === "failed") ? "failed" : "success",
    packages,
    _rawPlan: plan,
  };
}

async function publishStoredPlan(
  store: PlanStore,
  context: TegamiContext,
  { dryRun = false }: PublishOptions,
): Promise<PackagePublishResult[]> {
  const results: PackagePublishResult[] = [];

  for (const [id, plan] of Object.entries(store.packages)) {
    if (!plan.publish) continue;

    const pkg = context.graph.get(id);
    if (!pkg) continue;

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
      const registryClient = context.getRegistryClient(pkg);
      const published = await registryClient.packageVersionExists(pkg, pkg.version);

      if (published) {
        results.push({
          id: pkg.id,
          name: pkg.name,
          version: pkg.version,
          distTag: plan.distTag,
          state: "success",
          changelogs,
        });
        continue;
      }
    }

    try {
      if (!dryRun) {
        await context.getRegistryClient(pkg).publish(pkg, { distTag: plan.distTag });
      }

      results.push({
        id: pkg.id,
        name: pkg.name,
        version: pkg.version,
        distTag: plan.distTag,
        state: "success",
        changelogs,
      });
    } catch (error) {
      results.push({
        id: pkg.id,
        name: pkg.name,
        version: pkg.version,
        distTag: plan.distTag,
        changelogs,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
