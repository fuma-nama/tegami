import { generateChangelog } from "./changelog/generate";
import type { GenerateChangelogOptions, GeneratedChangelog } from "./changelog/generate";
import { createTegamiContext, TegamiContext } from "./context";
import { Draft, createDraft } from "./plans/draft";
import { readChangelogEntries } from "./changelog/parse";
import type { TegamiOptions } from "./types";
import { PackageGraph } from "./graph";
import {
  cleanupPublishLock,
  type CleanupResult,
  PublishOptions,
  PublishPlan,
  initPublishPlan,
  runPreflights,
  runPublishPlan,
} from "./plans/publish";
import { publishPlanStatus } from "./plans/checks";

export type { GenerateChangelogOptions, GeneratedChangelog } from "./changelog/generate";
export type {
  LogGenerator,
  TegamiOptions,
  TegamiPlugin,
  PublishPreflight,
  GroupOptions,
  PackageOptions,
  TegamiPluginOption,
} from "./types";
export type { PublishLock } from "./plans/lock";
export type { Draft, PackageDraft, DraftPolicy } from "./plans/draft";
export type {
  CleanupResult,
  PackagePublishPlan,
  PackagePublishResult,
  PublishOptions,
  PublishPlan,
} from "./plans/publish";
export type { PackageGraph, PackageGroup, WorkspacePackage } from "./graph";

export interface Tegami {
  /** Create pending changelog files from git commit history. */
  generateChangelog(options?: GenerateChangelogOptions): Promise<GeneratedChangelog[]>;
  /** Build a draft from pending changelog files. */
  draft(): Promise<Draft>;
  /** Publish the current publish plan. */
  publish(options?: PublishOptions): Promise<PublishPlan | "skipped">;
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
  async function prepublish(context: TegamiContext, publishOptions: PublishOptions) {
    const plan = await initPublishPlan(context, publishOptions);
    if (!plan) return "skipped";

    await runPreflights(context, plan);

    if ((await publishPlanStatus(plan, context)) === "success") {
      return "skipped";
    }

    return plan;
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
      return createDraft(changelogs, context);
    },
    async publish(publishOptions = {}) {
      const context = await $context;
      const plan = await prepublish(context, publishOptions);
      if (plan === "skipped") return "skipped";

      await runPublishPlan(context, plan);

      if (
        Array.from(plan.packages.values()).every((pkg) => pkg.publishResult!.type === "skipped")
      ) {
        return "skipped";
      }

      return plan;
    },

    async cleanup() {
      return cleanupPublishLock(await $context);
    },
  };
}
