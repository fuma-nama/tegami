import type { TegamiContext } from "./context";
import type { DraftPlan, PackageOptions } from "./draft";
import type { ChangelogEntry } from "./markdown";
import type { PublishResult } from "./publish";

/** Generates changelog content for a package release. */
export interface LogGenerator {
  generate(
    this: TegamiContext,
    opts: {
      packageName: string;
      version: string;
      changelogs: ChangelogEntry[];
    },
  ): string | Promise<string>;
}

export interface TegamiOptions {
  /** Workspace root. Defaults to the current working directory. */
  cwd?: string;
  /** Directory containing pending changelog markdown files. */
  changelogDir?: string;
  /** Path to the publish plan file. */
  planPath?: string;
  /** Changelog generator used when creating a publish plan. */
  generator?: LogGenerator;
  /** Per-package release and publish options keyed by package name. */
  packages?: Record<string, PackageOptions>;
  plugins?: TegamiPlugin[];

  /** Package manager command used for npm registry operations. */
  npmClient?: NpmClient;
}

export interface TegamiPlugin {
  name: string;
  /** Called after Tegami builds the initial draft plan and before it is returned. */
  initPlan?(plan: DraftPlan): void | Promise<void>;
  /** Called after publishing finishes. */
  afterPublish?(result: PublishResult): void | Promise<void>;
}

export type NpmClient = "npm" | "pnpm";
