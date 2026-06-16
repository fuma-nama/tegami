import { readFile } from "node:fs/promises";
import { createChangelog } from "./changelog/create";
import type { CreateChangelogOptions, CreatedChangelog } from "./changelog/create";
import { createTegamiContext, TegamiContext } from "./context";
import { DraftPlan, createDraftPlan } from "./plans/draft";
import { getChangelogFiles, readChangelogEntries } from "./changelog/parse";
import { publishFromPlan } from "./publish";
import type { PublishOptions, PublishResult } from "./publish";
import type { TegamiOptions } from "./types";
import { isNodeError, handlePluginError } from "./utils/error";
import { PackageGraph } from "./graph";
import { parsePlanStore } from "./plans/store";

export type { PackagePublishResult, PublishOptions, PublishResult } from "./publish";
export type { CreateChangelogOptions, CreatedChangelog } from "./changelog/create";
export type {
  LogGenerator,
  TegamiOptions,
  TegamiPlugin,
  RegistryClient,
  GroupOptions,
  PackageOptions,
  TegamiPluginOption,
} from "./types";
export type { DraftPlan, PackagePlan } from "./plans/draft";
export type { PackageGraph, PackageGroup, WorkspacePackage } from "./graph";

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
export function tegami<const Groups extends string = string>(
  options: TegamiOptions<Groups> = {},
): Tegami {
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
      return createDraftPlan(changelogs, context);
    },

    async publish(publishOptions = {}) {
      const context = await $context;
      const changelogs = await getChangelogFiles(context);

      // it implies a new versioning cycle has started
      if (changelogs.length > 0) {
        return { state: "skipped", planPath: context.planPath };
      }

      const parsed = await readFile(context.planPath, "utf8")
        .then((content) => parsePlanStore(content))
        .catch((error: unknown) => {
          if (isNodeError(error) && error.code === "ENOENT") return undefined;
          throw error;
        });

      if (parsed === undefined) return { state: "skipped", planPath: context.planPath };

      let result = await publishFromPlan(context, parsed, publishOptions);

      const publishCtx = { ...context, publishOptions };
      for (const plugin of context.plugins) {
        const next = await handlePluginError(plugin, "afterPublish", () =>
          plugin.afterPublish?.call(publishCtx, result),
        );
        result = next ?? result;
      }

      return result;
    },
  };
}
