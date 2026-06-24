import { generateChangelog } from "./changelog/generate";
import type { GenerateChangelogOptions, GeneratedChangelog } from "./changelog/generate";
import { createTegamiContext, TegamiContext } from "./context";
import { DraftPlan, cleanupPublishPlan, createDraftPlan } from "./plans/draft";
import type { CleanupResult } from "./plans/draft";
import { readChangelogEntries } from "./changelog/parse";
import { publishFromPlan } from "./publish";
import type { PublishOptions, PublishResult } from "./publish";
import type { TegamiOptions } from "./types";
import { handlePluginError } from "./utils/error";
import { PackageGraph } from "./graph";
import { readPlanStore } from "./plans/store";

export type { PackagePublishResult, PublishOptions, PublishResult } from "./publish";
export type { GenerateChangelogOptions, GeneratedChangelog } from "./changelog/generate";
export type {
  LogGenerator,
  TegamiOptions,
  TegamiPlugin,
  PublishPreflight,
  RegistryClient,
  GroupOptions,
  PackageOptions,
  TegamiPluginOption,
} from "./types";
export type { DraftPlan, PackagePlan } from "./plans/draft";
export type { PackageGraph, PackageGroup, WorkspacePackage } from "./graph";

export interface Tegami {
  /** Create pending changelog files from git commit history. */
  generateChangelog(options?: GenerateChangelogOptions): Promise<GeneratedChangelog[]>;
  /** Build a draft from pending changelog files. */
  draft(): Promise<DraftPlan>;
  /** Publish the current publish plan. */
  publish(options?: PublishOptions): Promise<PublishResult>;
  /** Remove the publish plan file after it has finished successfully. */
  cleanup(): Promise<CleanupResult>;

  /** Internal APIs, do not use it unless you know what you are doing */
  _internal: {
    context(): Promise<TegamiContext>;
    graph(): Promise<PackageGraph>;
    options: TegamiOptions;
  };
}

/** Create a Tegami project handle. */
export function tegami<const Groups extends string = string>(
  options: TegamiOptions<Groups> = {},
): Tegami {
  const $context = init();
  async function init() {
    return createTegamiContext(options);
  }

  return {
    async generateChangelog(createOptions = {}) {
      return generateChangelog(await $context, createOptions);
    },
    _internal: {
      options,
      context() {
        return $context;
      },
      async graph() {
        return (await $context).graph;
      },
    },
    async draft() {
      const context = await $context;
      const changelogs = await readChangelogEntries(context);
      return createDraftPlan(changelogs, context);
    },
    async publish(publishOptions = {}) {
      const context = await $context;
      const parsed = await readPlanStore(context);
      if (!parsed) return { state: "skipped" };

      let result = await publishFromPlan(context, parsed, publishOptions);

      const publishCtx = { ...context, publishOptions };
      for (const plugin of context.plugins) {
        const next = await handlePluginError(plugin, "afterPublishAll", () =>
          plugin.afterPublishAll?.call(publishCtx, result),
        );
        if (next) result = next;
      }

      return result;
    },

    async cleanup() {
      return cleanupPublishPlan(await $context);
    },
  };
}
