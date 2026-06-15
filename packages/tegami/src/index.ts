import { readFile } from "node:fs/promises";
import { createChangelog } from "./changelog/create";
import type { CreateChangelogOptions, CreatedChangelog } from "./changelog/create";
import { createTegamiContext, TegamiContext } from "./context";
import { DraftPlan, createDraftPlan } from "./draft";
import { getChangelogFiles, readChangelogEntries } from "./changelog/parse";
import { publishFromPlan } from "./publish";
import type { PublishOptions, PublishResult } from "./publish";
import { planStoreSchema } from "./schemas";
import type { TegamiOptions } from "./types";
import { isNodeError } from "./utils/error";
import { PackageGraph } from "./workspace";

export type { PackagePublishResult, PublishOptions, PublishResult } from "./publish";
export type { CreateChangelogOptions, CreatedChangelog } from "./changelog/create";
export type {
  LogGenerator,
  TegamiOptions,
  TegamiPlugin,
  RegistryClient,
  TegamiPluginOption,
} from "./types";
export type { DraftPlan, PackageOptions, PackagePlan } from "./draft";
export type { PackageGraph, WorkspacePackage } from "./workspace";

export interface Tegami {
  /** Create pending changelog files from git commit history. */
  generateChangelog(options?: CreateChangelogOptions): Promise<CreatedChangelog[]>;
  /** Build an editable draft from pending changelog files. */
  draft(): Promise<DraftPlan>;
  /** Publish the current publish plan. */
  publish(options?: PublishOptions): Promise<PublishResult>;

  /** Internal APIs, do not use it unless you know what you are doing */
  _internal: {
    context(): Promise<TegamiContext>;
    graph(): Promise<PackageGraph>;
    options: TegamiOptions;
  };
}

/** Create a Tegami project handle. */
export function tegami(options: TegamiOptions = {}): Tegami {
  const $context = init();
  async function init() {
    return createTegamiContext(options);
  }

  return {
    async generateChangelog(createOptions = {}) {
      return createChangelog(await $context, createOptions);
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
      let plan = createDraftPlan(changelogs, context);

      for (const plugin of context.plugins) {
        plan = (await plugin.initPlan?.call(context, plan)) ?? plan;
      }

      return plan;
    },

    async publish(publishOptions = {}) {
      const context = await $context;
      const changelogs = await getChangelogFiles(context);

      // it implies a new versioning cycle has started
      if (changelogs.length > 0) {
        return { state: "skipped", planPath: context.planPath };
      }

      const parsed = await readFile(context.planPath, "utf8")
        .then((content) => planStoreSchema.decode(content))
        .catch((error: unknown) => {
          if (isNodeError(error) && error.code === "ENOENT") return undefined;
          throw error;
        });

      if (parsed === undefined) return { state: "skipped", planPath: context.planPath };

      let result = await publishFromPlan(context, parsed, publishOptions);

      const publishCtx = { ...context, publishOptions };
      for (const plugin of context.plugins) {
        result = (await plugin.afterPublish?.call(publishCtx, result)) ?? result;
      }

      return result;
    },
  };
}
