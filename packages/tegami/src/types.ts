import type { TegamiContext } from "./context";
import type { Draft, PackageDraft } from "./plans/draft";
import type { NpmPluginOptions } from "./providers/npm";
import type { WorkspacePackage } from "./graph";
import type { CargoPluginOptions } from "./providers/cargo";
import type { PackagePublishResult, PublishPlan } from "./plans/publish";
import type { PublishLock } from "./plans/lock";

/** Generates changelog content for a package release. */
export interface LogGenerator {
  generate(
    this: TegamiContext,
    opts: {
      pkg: WorkspacePackage;
      packageDraft: PackageDraft;
      draft: Draft;
    },
  ): string | Promise<string>;
}

export interface TegamiOptions<Groups extends string = string> {
  /** Workspace root. Defaults to the current working directory. */
  cwd?: string;
  /** Directory containing pending changelog markdown files. */
  changelogDir?: string;
  /** Path to the publish lock file. Defaults to `.tegami/publish-lock.yaml`. */
  lockPath?: string;
  /** Changelog generator used when applying a draft. */
  generator?: LogGenerator;
  /** Per-package options keyed by package name or a function. */
  packages?:
    | Record<string, PackageOptions<NoInfer<Groups>>>
    | ((pkg: WorkspacePackage) => PackageOptions<NoInfer<Groups>> | undefined);
  plugins?: TegamiPluginOption[];

  groups?: Record<Groups, GroupOptions>;

  /** Package names, ids, or regex patterns to exclude from the dependency graph. */
  ignore?: (string | RegExp)[];

  /**
   * When creating draft, automatically generate changelogs from conventional commits.
   *
   * When disabled (default), it requires you to run `generateChangelog()` to pre-generate changelogs before draft.
   *
   * @default false
   */
  conventionalCommits?: boolean;

  npm?: NpmPluginOptions;
  cargo?: CargoPluginOptions;
}

export interface GroupOptions {
  /** Prerelease identifier appended to bumped versions (e.g. `alpha` → `1.1.0-alpha.0`). */
  prerelease?: string;

  /** all member packages will share the same type of version bump (e.g. when one package is bumped by a minor, other member packages will also be bumped by a minor) */
  syncBump?: boolean;

  /** when multiple packages in the group are published, only one git tag will be created (as well as GitHub release) */
  syncGitTag?: boolean;

  /** npm-specific options. */
  npm?: {
    /** npm dist-tag used when publishing. */
    distTag?: string;
  };
}

export interface PackageOptions<Group extends string = string> {
  /** Prerelease identifier appended to bumped versions (e.g. `alpha` → `1.1.0-alpha.0`). */
  prerelease?: string;
  /** the group of this package, ignored if the group doesn't exist */
  group?: Group;

  /** npm-specific options. */
  npm?: {
    /** npm dist-tag used when publishing. */
    distTag?: string;
  };
}

export type TegamiPluginOption = TegamiPlugin | TegamiPluginOption[];

export interface TegamiPlugin {
  name: string;
  enforce?: "pre" | "default" | "post";
  /** When Tegami initializes */
  init?(this: TegamiContext): Awaitable<void>;
  /** Resolve workspace packages and dependency metadata into the shared graph. */
  resolve?(this: TegamiContext): Awaitable<void>;

  /** Called when Tegami creates an empty draft. */
  initDraft?(this: TegamiContext, draft: Draft): Awaitable<Draft | void | undefined>;

  /** Called when Tegami applies the draft. */
  applyDraft?(this: TegamiContext, draft: Draft): Awaitable<void>;

  /** Called when Tegami creates publish lock. */
  initPublishLock?(this: TegamiContext, opts: { lock: PublishLock; draft: Draft }): Awaitable<void>;

  /** Called when Tegami creates publish plan. */
  initPublishPlan?(
    this: TegamiContext,
    opts: { lock: PublishLock; plan: PublishPlan },
  ): Awaitable<void>;

  /**
   * Collect data before publishing a package.
   *
   * If multiple plugins return preflight data for the same package, only the first plugin will be considered.
   */
  publishPreflight?(
    this: TegamiContext,
    opts: { pkg: WorkspacePackage; plan: PublishPlan },
  ): Awaitable<PublishPreflight | void | undefined>;

  /** Publish package, return a result object indicating if the package is published, skipped, or failed. Return `undefined` if the package is not handled by this plugin. */
  publish?(
    this: TegamiContext,
    opts: { pkg: WorkspacePackage; plan: PublishPlan },
  ): Promise<PackagePublishResult | undefined | void>;

  /**
   * Resolve publish plan status, used to check if the plan is finished successfully, or needs retries.
   *
   * Each plugin should only report the status of its own tasks, Tegami will summarize the results from all plugins.
   */
  resolvePlanStatus?(
    this: TegamiContext,
    opts: { plan: PublishPlan },
  ): Awaitable<
    "success" | "pending" | undefined | void | Awaitable<"success" | "pending" | undefined>[]
  >;

  /** Called before a package will be published, return `false` to prevent from publishing. */
  willPublish?(
    this: TegamiContext,
    opts: { pkg: WorkspacePackage },
  ): Awaitable<false | void | undefined>;

  /** Called after a package is published successfully, or failed. */
  afterPublish?(
    this: TegamiContext,
    opts: { pkg: WorkspacePackage; plan: PublishPlan },
  ): Awaitable<void>;

  /** Called after all publishing finishes. */
  afterPublishAll?(this: TegamiContext, opts: { plan: PublishPlan }): Awaitable<void>;

  /** CLI lifecycle hooks. */
  cli?: {
    /** Called once before a CLI command runs. */
    init?(this: TegamiContext): Awaitable<void>;

    /** Called after `tegami version` returns a draft. */
    draftCreated?(this: TegamiContext, draft: Draft): Awaitable<void>;

    /** Called after `tegami version` applies a draft. */
    draftApplied?(this: TegamiContext, draft: Draft): Awaitable<void>;
  };
}

export type Awaitable<T> = T | Promise<T>;

export interface PublishPreflight {
  /**
   * Whether the package should be published, the state **must not** be changed across different runs.
   *
   * To note if the package is already published, hook `resolvePlanStatus` on plugins, or skip at publish-time.
   */
  shouldPublish: boolean;

  /**
   * Package ids that must be published before this one, this will automatically disallow circular dependency.
   *
   * It is okay to add unpublished packages to `wait`, they will be ignored.
   */
  wait?: string[];
}
