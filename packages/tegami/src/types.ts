import { SemVer } from "semver";
import type { TegamiContext } from "./context";
import type { DraftPlan, PackagePlan } from "./draft";
import type { ChangelogEntry } from "./changelog/parse";
import type { PublishOptions, PublishResult } from "./publish";
import type { NpmClient } from "./providers/npm";
import type { WorkspacePackage } from "./graph";
import type { PlanStore } from "./schemas";

/** Generates changelog content for a package release. */
export interface LogGenerator {
  generate(
    this: TegamiContext,
    opts: {
      packageId: string;
      packageName: string;
      version: string;
      distTag?: string;
      changelogs: ChangelogEntry[];

      plan: PackagePlan;
      _draft: DraftPlan;
    },
  ): string | Promise<string>;
}

export interface TegamiOptions<Groups extends string = string> {
  /** Workspace root. Defaults to the current working directory. */
  cwd?: string;
  /** Directory containing pending changelog markdown files. */
  changelogDir?: string;
  /** Path to the publish plan file. */
  planPath?: string;
  /** Changelog generator used when applying a publish plan. */
  generator?: LogGenerator;
  /** Per-package release and publish options keyed by package name. */
  packages?: Record<string, PackageOptions<NoInfer<Groups>>>;
  plugins?: TegamiPluginOption[];
  /** Package manager command used for npm registry operations. */
  npmClient?: NpmClient;

  groups?: Record<Groups, GroupOptions>;
}

export interface GroupOptions {
  /** Prerelease identifier appended to bumped versions (e.g. `alpha` → `1.1.0-alpha.0`). */
  prerelease?: string;

  /** all packages in the group will use the same version (obtained from the highest one) */
  syncVersion?: boolean;
  /** when multiple packages in the group are published, only one git tag will be created (as well as GitHub release) */
  syncGitTag?: boolean;
}

export interface PackageOptions<Group extends string = string> {
  /** Prerelease identifier appended to bumped versions (e.g. `alpha` → `1.1.0-alpha.0`). */
  prerelease?: string;
  /** npm dist-tag used when publishing. */
  distTag?: string;
  /** Set to false to keep this package out of npm publishing. */
  publish?: boolean;
  /** the group of this package, ignored if the group doesn't exist */
  group?: Group;
}

export type TegamiPluginOption = TegamiPlugin | TegamiPluginOption[];

export interface TegamiPlugin {
  name: string;
  enforce?: "pre" | "default" | "post";
  /** when Tegami initializes */
  init?(this: TegamiContext): Awaitable<void>;
  /** Resolve workspace packages and dependency metadata into the shared graph. */
  resolve?(this: TegamiContext): Awaitable<void>;
  /** Register registry clients used to handle packages for different package managers. */
  createRegistryClient?(
    this: TegamiContext,
  ): Awaitable<RegistryClient | RegistryClient[] | void | undefined>;
  /** Called after Tegami builds the initial draft plan and before it is returned. */
  initPlan?(this: TegamiContext, plan: DraftPlan): Awaitable<DraftPlan | void | undefined>;
  /** Called after publishing finishes. */
  afterPublish?(
    this: TegamiContext & { publishOptions: PublishOptions },
    result: PublishResult,
  ): Awaitable<PublishResult | void | undefined>;

  /** CLI lifecycle hooks. */
  cli?: {
    /** Called once before a CLI command runs. */
    init?(this: TegamiContext): Awaitable<void>;

    /** Called after `tegami version` returns a draft plan. */
    publishPlanCreated?(this: TegamiContext, draft: DraftPlan): Awaitable<void>;

    /** Called after `tegami version` applies a publish plan. */
    publishPlanApplied?(this: TegamiContext, draft: DraftPlan): Awaitable<void>;
  };

  /**
   * @param pkg - the package that referenced the dependency
   * @param spec - the referenced dependency & its range
   * @param target - the target version to update to
   * @returns fallback to the default behaviour if `undefined`, otherwise replace with updated spec (can reuse the same instance, as long as a value is returned).
   */
  onUpdateRange?(
    this: TegamiContext,
    pkg: WorkspacePackage,
    spec: DependencySpec,
    target: SemVer,
  ): Awaitable<DependencySpec | void | undefined>;
}

export type Awaitable<T> = T | Promise<T>;

export interface PublishPlanStatus {
  state: "pending" | "success";
  error?: string;
}

export interface RegistryClient {
  id: string;
  supports?(pkg: WorkspacePackage): boolean;
  packageVersionExists(pkg: WorkspacePackage, version: string): Promise<boolean>;
  publish(pkg: WorkspacePackage, options?: { distTag?: string }): Promise<void>;
  publishPlanStatus(plan: PlanStore): Promise<PublishPlanStatus>;
}

export interface DependencySpec {
  name: string;
  range: string;
}
