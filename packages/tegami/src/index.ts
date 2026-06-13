import { readFile } from "node:fs/promises";
import { createTegamiContext } from "./context";
import { DraftPlan, createDraftPlan } from "./draft";
import { readChangelogEntries } from "./markdown";
import { publishFromPlan } from "./publish";
import type { PublishResult } from "./publish";
import type { TegamiOptions } from "./types";
import { isNodeError } from "./utils/error";
import { PackageGraph } from "./workspace";
import { publishPlanSchema } from "./schemas";

export type { PackageOptions } from "./draft";
export type { PackagePublishResult, PublishOptions, PublishResult } from "./publish";
export type { LogGenerator, TegamiOptions, TegamiPlugin } from "./types";
export type { WorkspacePackage } from "./workspace";
export type { DraftPlan } from "./draft";
export type { PackageGraph } from "./workspace";

export interface Tegami {
  /** Build an editable draft from pending changelog files. */
  draft(): Promise<DraftPlan>;
  /** Discover workspace packages and their dependency relationships. */
  graph(): Promise<PackageGraph>;
  /** Publish the current publish plan. */
  publish(): Promise<PublishResult>;
}

/** Create a Tegami project handle. */
export function tegami(options: TegamiOptions = {}): Tegami {
  return {
    async draft() {
      const context = await createTegamiContext(options);
      const changelogs = await readChangelogEntries(context.cwd, context.changelogDir);
      const plan = createDraftPlan(changelogs, context);

      for (const plugin of options.plugins ?? []) {
        await plugin.initPlan?.(plan);
      }

      return plan;
    },

    async graph() {
      return (await createTegamiContext(options)).graph;
    },

    async publish() {
      const context = await createTegamiContext(options);
      const parsed = await readFile(context.planPath, "utf8")
        .then((content) => publishPlanSchema.decode(content))
        .catch((error: unknown) => {
          if (isNodeError(error) && error.code === "ENOENT") return undefined;
          throw error;
        });

      if (parsed === undefined) {
        throw new Error(`No publish plan found at ${context.planPath}.`);
      }

      const result = await publishFromPlan(context, parsed);

      for (const plugin of options.plugins ?? []) {
        await plugin.afterPublish?.(result);
      }

      return result;
    },
  };
}
