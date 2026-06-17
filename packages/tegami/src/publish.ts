import type { TegamiContext } from "./context";
import type { ChangelogEntry } from "./changelog/parse";
import type { PlanStore } from "./plans/store";
import { publishPlanStatus } from "./plans/checks";
import { handlePluginError } from "./utils/error";

export interface PublishOptions {
  /** Validate the publish plan without publishing packages, creating tags, or running release plugins. */
  dryRun?: boolean;
}

export type PublishResult =
  | {
      state: "created";
      packages: PackagePublishResult[];
      /** the persisted plan object. This is not a public API, can be changed without notice */
      _rawPlan: PlanStore;
    }
  | {
      state: "failed";
      error?: string;
      packages: PackagePublishResult[];

      /** the persisted plan object. This is not a public API, can be changed without notice */
      _rawPlan: PlanStore;
    }
  | {
      state: "skipped";
    };

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
  npm?: {
    distTag?: string;
  };
  /** added by the `git` plugin */
  gitTag?: string;
  changelogs: ChangelogEntry[];
};

export async function publishFromPlan(
  context: TegamiContext,
  store: PlanStore,
  options: PublishOptions,
): Promise<PublishResult> {
  const { dryRun = false } = options;
  const packages: PackagePublishResult[] = [];
  const status = await publishPlanStatus(store, context);
  if (status.state !== "pending") {
    return { state: "skipped" };
  }

  for (const [id, plan] of Object.entries(store.packages)) {
    if (!plan.publish) continue;

    const pkg = context.graph.get(id);
    if (!pkg) continue;

    const changelogs: ChangelogEntry[] = [];
    for (const id of plan.changelogIds ?? []) {
      const entry = store.changelogs[id];
      if (entry)
        changelogs.push({
          ...entry,
          packages: new Map(Object.entries(entry.packages)),
          id,
        });
    }

    if (!dryRun) {
      const registryClient = context.getRegistryClient(pkg);
      const published = await registryClient.isPackagePublished(pkg);

      if (published) {
        packages.push({
          id: pkg.id,
          name: pkg.name,
          version: pkg.version,
          npm: plan.npm,
          state: "success",
          changelogs,
        });
        continue;
      }
    }

    try {
      if (!dryRun) {
        for (const plugin of context.plugins) {
          await handlePluginError(plugin, "willPublish", () =>
            plugin.willPublish?.call(context, { pkg }),
          );
        }

        await context.getRegistryClient(pkg).publish(pkg, { packageStore: plan, store });
      }

      packages.push({
        id: pkg.id,
        name: pkg.name,
        version: pkg.version,
        npm: plan.npm,
        state: "success",
        changelogs,
      });
    } catch (error) {
      packages.push({
        id: pkg.id,
        name: pkg.name,
        version: pkg.version,
        npm: plan.npm,
        changelogs,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (packages.length === 0) return { state: "skipped" };

  return {
    state: packages.some((pkg) => pkg.state === "failed") ? "failed" : "created",
    packages,
    _rawPlan: store,
  };
}
