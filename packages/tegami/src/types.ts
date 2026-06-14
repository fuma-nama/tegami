import { SemVer } from "semver";
import type { TegamiContext } from "./context";
import type { DraftPlan, PackageOptions } from "./draft";
import type { ChangelogEntry } from "./changelog/parse";
import type { PublishOptions, PublishResult } from "./publish";
import type { NpmClient } from "./providers/npm";
import type { WorkspacePackage } from "./workspace";
import type { PlanStore } from "./schemas";

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
  plugins?: TegamiPluginOption[];

  /** Package manager command used for npm registry operations. */
  npmClient?: NpmClient;
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
    /** Called after `tegami version` creates a publish plan. */
    afterVersion?(this: TegamiContext, draft: DraftPlan): Awaitable<void>;
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
