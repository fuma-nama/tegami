import { readFile } from "node:fs/promises";
import { createChangelog } from "./changelog/create";
import type { CreateChangelogOptions, CreatedChangelog } from "./changelog/create";
import { createTegamiContext, TegamiContext } from "./context";
import { DraftPlan, createDraftPlan } from "./draft";
import { readChangelogEntries } from "./changelog/parse";
import { publishFromPlan } from "./publish";
import type { PublishOptions, PublishResult } from "./publish";
import type { TegamiOptions } from "./types";
import { isNodeError } from "./utils/error";
import { PackageGraph } from "./workspace";
import { planStoreSchema } from "./schemas";

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
    /** Discover workspace packages and their dependency relationships. */
    graph(): Promise<PackageGraph>;
    options: TegamiOptions;
  };
}

/** Create a Tegami project handle. */
export function tegami(options: TegamiOptions = {}): Tegami {
  return {
    async generateChangelog(createOptions = {}) {
      return createChangelog(await createTegamiContext(options), createOptions);
    },
    _internal: {
      options,
      context() {
        return createTegamiContext(options);
      },
      async graph() {
        return (await createTegamiContext(options)).graph;
      },
    },
    async draft() {
      const context = await createTegamiContext(options);
      const changelogs = await readChangelogEntries(context.cwd, context.changelogDir);
      let plan = createDraftPlan(changelogs, context);

      for (const plugin of context.plugins) {
        plan = (await plugin.initPlan?.call(context, plan)) ?? plan;
      }

      return plan;
    },

    async publish(publishOptions = {}) {
      const context = await createTegamiContext(options);
      const changelogs = await readChangelogEntries(context.cwd, context.changelogDir);

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
