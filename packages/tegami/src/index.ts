import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateFromCommits } from "./changelog/generate";
import type { CommitChangelog, GenerateFromCommitsOptions } from "./changelog/generate";
import { createTegamiContext, resolveGraph, TegamiContext } from "./context";
import { Draft, createDraft } from "./plans/draft";
import { parseChangelogFile, readChangelogEntries } from "./changelog/parse";
import type { TegamiOptions } from "./types";
import {
  PublishOptions,
  PublishPlan,
  initPublishPlan,
  runPreflights,
  publishPlanStatus,
  runPublishPlan,
} from "./plans/publish";

export type { CommitChangelog } from "./changelog/generate";
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
  PackagePublishPlan,
  PackagePublishResult,
  PublishOptions,
  PublishPlan,
} from "./plans/publish";
export { PackageGraph, type PackageGroup } from "./graph";
export type { TegamiContext } from "./context";
export type { BumpType } from "./utils/semver";

export interface GenerateChangelogOptions extends GenerateFromCommitsOptions {
  /**
   * Write changelog files to disk.
   *
   * @default true
   */
  write?: boolean;
}

// this is required to fix a bundling problem of tsdown, where it exports abstract classes as type-only
import { WorkspacePackage as b } from "./graph";
export const WorkspacePackage = b;

export interface Tegami {
  /** Create pending changelog files from git commit history. */
  generateChangelog(options?: GenerateChangelogOptions): Promise<CommitChangelog[]>;
  /** Build a draft from pending changelog files. */
  draft(): Promise<Draft>;
  /** Publish packages from the publish lock. */
  publish(options?: PublishOptions): Promise<PublishPlan | "skipped">;
  /**
   * @deprecated use `getPublishStatus()` instead
   */
  publishStatus(options?: PublishOptions): Promise<"pending" | "success" | "idle">;
  /**
   * Check publish plan status.
   *
   * Prefer `publish()` over this if you are publishing packages, this is check-only and can lead to TOCTOU race.
   */
  getPublishStatus(options?: PublishOptions): Promise<{
    /**
     * - `pending`: has pending tasks.
     * - `success`: all tasks finished.
     * - `none`: there is no existing publish plans. */
    status: "pending" | "success" | "none";
    reason?: string;
  }>;
  /** Remove the publish lock file after publishing has finished successfully. */
  cleanup(options?: PublishOptions): Promise<
    | {
        state: "removed";
      }
    | {
        state: "skipped";
        reason: "no-plan" | "pending";
      }
  >;

  /** Internal APIs, do not use it unless you know what you are doing */
  _internal: {
    context(): Promise<TegamiContext>;
    /** access context without requiring graph resolution */
    contextUnresolved(): Promise<TegamiContext>;
    options: TegamiOptions;
  };
}

/** Create a Tegami project handle. */
export function tegami<const Groups extends string = string>(
  options: TegamiOptions<Groups> = {},
): Tegami {
  let $context: Promise<TegamiContext> | undefined;
  let $contextResolved: Promise<TegamiContext> | undefined;
  function getContext() {
    return ($context ??= createTegamiContext(options));
  }
  function getContextResolved() {
    return ($contextResolved ??= getContext().then(async (ctx) => {
      await resolveGraph(ctx);
      return ctx;
    }));
  }

  return {
    async generateChangelog(generateOptions = {}) {
      const { write = true } = generateOptions;
      const context = await getContextResolved();
      const changelogs = await generateFromCommits(context, generateOptions);

      if (write && changelogs.length > 0) {
        await mkdir(context.changelogDir, { recursive: true });
        await Promise.all(
          changelogs.map((entry) =>
            writeFile(join(context.changelogDir, entry.filename), entry.content),
          ),
        );
      }
      return changelogs;
    },
    _internal: {
      options,
      context: getContextResolved,
      contextUnresolved: getContext,
    },
    async draft() {
      const context = await getContextResolved();
      const changelogs = await readChangelogEntries(context);

      if (context.options.conventionalCommits) {
        const generated = await generateFromCommits(context);
        for (const entry of generated) {
          const parsed = parseChangelogFile(entry.filename, entry.content);
          if (!parsed) continue;

          parsed.virtual = true;
          changelogs.push(parsed);
        }
      }

      return createDraft(changelogs, context);
    },
    async getPublishStatus(publishOptions = {}) {
      const context = await getContextResolved();
      const plan = await initPublishPlan(context, publishOptions);
      if (!plan) return { status: "none" };

      await runPreflights(context, plan);
      return publishPlanStatus(plan, context);
    },
    async publishStatus(publishOptions = {}) {
      const { status } = await this.getPublishStatus(publishOptions);
      return status === "none" ? "idle" : status;
    },
    async publish(publishOptions = {}) {
      const context = await getContextResolved();
      const plan = await initPublishPlan(context, publishOptions);
      if (!plan) return "skipped";

      await runPreflights(context, plan);

      if ((await publishPlanStatus(plan, context)).status === "success") {
        return "skipped";
      }

      await runPublishPlan(context, plan);

      if (
        Array.from(plan.packages.values()).every((pkg) => pkg.publishResult!.type === "skipped")
      ) {
        return "skipped";
      }

      return plan;
    },

    async cleanup(publishOptions = {}) {
      const context = await getContextResolved();
      const plan = await initPublishPlan(context, publishOptions);
      if (!plan) {
        return { state: "skipped", reason: "no-plan" };
      }

      await runPreflights(context, plan);
      const { status } = await publishPlanStatus(plan, context);
      if (status !== "success") {
        return { state: "skipped", reason: "pending" };
      }

      await rm(context.lockPath, { force: true });
      return { state: "removed" };
    },
  };
}
