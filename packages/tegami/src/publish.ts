import type { TegamiContext } from "./context";
import { parseChangelogFile, type ChangelogEntry } from "./changelog/parse";
import type { PlanStore } from "./plans/store";
import { publishPlanStatus } from "./plans/checks";
import { handlePluginError } from "./utils/error";
import type { Awaitable, PublishPreflight } from "./types";

async function resolvePublishTargets(context: TegamiContext, store: PlanStore): Promise<string[]> {
  const targets: string[] = [];
  const preflightPromises: Awaitable<PublishPreflight | undefined | void>[] = [];

  for (const [id, plan] of Object.entries(store.packages)) {
    if (!plan.publish) continue;
    const pkg = context.graph.get(id);
    if (!pkg) continue;
    targets.push(pkg.id);
    preflightPromises.push(
      context.getRegistryClient(pkg).publishPreflight?.(pkg, {
        store,
        packageStore: plan,
      }),
    );
  }

  const preflights = await Promise.all(preflightPromises);
  const children = new Map<string, string[] | undefined>();

  for (let i = 0; i < targets.length; i++) {
    const id = targets[i]!;
    children.set(id, preflights[i]?.wait);
  }

  const ordered: string[] = [];
  function scan(id: string, stack = new Set<string>()) {
    if (stack.has(id)) {
      throw new Error(`circular reference of deps: ${[...stack, id].join(" -> ")}`);
    }

    if (ordered.includes(id)) return;

    const deps = children.get(id);
    if (deps) {
      stack.add(id);
      for (const dep of deps) scan(dep, stack);
      stack.delete(id);
    }

    ordered.push(id);
  }

  for (const id of targets) scan(id);
  return ordered;
}

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
  git?: {
    /** will be defined even if publishing fails */
    tag: string;
    tagState: "created" | "skipped" | "failed";
  };
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

  const orderedIds = await resolvePublishTargets(context, store);
  const parsedChangelogs = new Map<string, ChangelogEntry>();

  for (const [id, entry] of Object.entries(store.changelogs)) {
    const parsed = parseChangelogFile(entry.filename, entry.content);
    if (!parsed) continue;
    parsedChangelogs.set(id, parsed);
  }

  for (const id of orderedIds) {
    const plan = store.packages[id]!;
    const pkg = context.graph.get(id)!;

    const registryClient = context.getRegistryClient(pkg);
    const changelogs: ChangelogEntry[] = [];
    for (const id of plan.changelogIds ?? []) {
      const entry = parsedChangelogs.get(id);
      if (entry) changelogs.push(entry);
    }

    if (dryRun) {
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

    if (await registryClient.isPackagePublished(pkg)) {
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

    try {
      let result: PackagePublishResult | false | undefined;

      for (const plugin of context.plugins) {
        const next = await handlePluginError(plugin, "willPublish", () =>
          plugin.willPublish?.call(context, { pkg }),
        );

        if (next !== undefined) {
          result = next;
          break;
        }
      }

      if (result === undefined) {
        await registryClient.publish(pkg, { packageStore: plan, store });
        result = {
          id: pkg.id,
          name: pkg.name,
          version: pkg.version,
          npm: plan.npm,
          state: "success",
          changelogs,
        };
      }

      if (result === false) continue;

      for (const plugin of context.plugins) {
        const next = await handlePluginError(plugin, "afterPublish", () =>
          plugin.afterPublish?.call(context, {
            pkg,
            result: result as PackagePublishResult,
          }),
        );

        if (next) result = next;
      }

      packages.push(result);
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

export function publishError(result: Exclude<PublishResult, { state: "skipped" }>, error?: string) {
  result.state = "failed";
  if (result.state === "failed" && error) {
    result.error = result.error ? `${result.error}\n${error}` : error;
  }
}

export function packagePublishError(
  result: Exclude<PublishResult, { state: "skipped" }>,
  packageResult: PackagePublishResult,
  error?: string,
) {
  result.state = "failed";
  packageResult.state = "failed";
  if (packageResult.state === "failed" && error) {
    packageResult.error = packageResult.error ? `${packageResult.error}\n${error}` : error;
  }
}
