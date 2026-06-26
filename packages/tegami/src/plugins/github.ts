import { x } from "tinyexec";
import { join, relative } from "node:path";
import { prerelease as getPrerelease } from "semver";
import type { TegamiContext } from "../context";
import type { ChangelogEntry } from "../changelog/parse";
import type { Draft } from "../plans/draft";
import type { Awaitable, TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { formatNpmDistTag, formatPackageVersion } from "../utils/semver";
import { git, type GitPluginOptions } from "./git";
import { isCI } from "../utils/constants";
import { PackagePublishPlan, PublishPlan } from "../plans/publish";
import { WorkspacePackage } from "../graph";
import {
  createPullRequest,
  createRelease as createGitHubRelease,
  findOpenPullRequest,
  releaseExistsByTag,
  updatePullRequest,
} from "./github/api";

interface GithubRelease {
  /** Release title */
  title?: string;
  /** Release notes */
  notes?: string;
  /** Whether to mark release as prerelease */
  prerelease?: boolean;
}

type ResolvedGithubRelease = Required<GithubRelease>;

interface VersionPullRequest {
  /** Pull request title. */
  title?: string;
  /** Pull request body. */
  body?: string;
}

interface VersionPullRequestOptions {
  /**
   * Create the PR even outside of CI.
   *
   * @default false
   */
  forceCreate?: boolean;
  /**
   * Pull request branch.
   *
   * @default "tegami/version-packages"
   */
  branch?: string;
  /**
   * Pull request base branch.
   *
   * @default "main"
   */
  base?: string;

  /** Override details for "Version Packages" PR. */
  create?: (this: TegamiContext, opts: { draft: Draft }) => Awaitable<VersionPullRequest>;
}

/** Options for creating GitHub releases after a successful publish. */
export interface GitHubPluginOptions extends GitPluginOptions {
  /** GitHub repository. */
  repo?: string;
  /** Optional GitHub token for Git & GitHub operations. */
  token?: string;

  /**
   * Create GitHub release for published packages.
   *
   * @default true
   */
  release?:
    | boolean
    | {
        /**
         * Create GitHub release immediately after successful publish, without waiting for others.
         *
         * @default false
         */
        eager?: boolean;

        /** Override release details for a single package. */
        create?: (
          this: TegamiContext,
          opts: { tag: string; pkg: WorkspacePackage; plan: PublishPlan },
        ) => Awaitable<GithubRelease>;
        /** Override release details when multiple packages share a git tag. */
        createGrouped?: (
          this: TegamiContext,
          opts: { tag: string; packages: WorkspacePackage[]; plan: PublishPlan },
        ) => Awaitable<GithubRelease>;
      };

  /**
   * (CLI only) Open a version pull request after versioning.
   *
   * Defaults to enabled in CI and disabled locally.
   */
  versionPr?: VersionPullRequestOptions | false;
}

/** Create GitHub releases for successfully published packages after the whole plan succeeds. */
export function github(options: GitHubPluginOptions = {}): TegamiPlugin[] {
  const { release: releaseOptions = true } = options;

  let renderer: ChangelogRenderer | undefined;
  function getRenderer(context: TegamiContext): ChangelogRenderer {
    return (renderer ??= createChangelogRenderer(context));
  }

  function resolvePROptions(): [false] | [true, VersionPullRequestOptions] {
    const config = options.versionPr ?? {};

    if (config === false) {
      return [false];
    }

    if (config.forceCreate || isCI()) {
      return [true, config];
    }

    return [false];
  }

  function defaultVersionPRBody(draft: Draft, context: TegamiContext): string {
    const packageLines: string[] = [];

    for (const pkg of context.graph.getPackages()) {
      const packageDraft = draft.getPackageDraft(pkg.id);
      if (!packageDraft) continue;
      const originalVersion = cliOriginalPackageVersions.get(pkg.id) ?? pkg.version;
      if (originalVersion === pkg.version) continue;

      packageLines.push(
        `| \`${pkg.name}\` | \`${originalVersion}\` | \`${pkg.version}\`${formatNpmDistTag(packageDraft.npm?.distTag)} |`,
      );
    }

    const changelogLines: string[] = [];
    for (const entry of draft.getChangelogs()) {
      changelogLines.push(`### ${entry.subject ?? `\`${entry.filename}\``}`, "");
      for (const section of entry.sections) {
        changelogLines.push(`#### ${section.title}`, "");
        if (section.content) changelogLines.push(section.content);
      }
    }

    const sections = ["## Summary", "", "Merge this PR to publish the versioned packages.", ""];

    if (packageLines.length > 0) {
      sections.push("| Package | From | To |", "| --- | --- | --- |", ...packageLines);
    }

    if (changelogLines.length > 0) {
      sections.push("", "## Changelogs", ...changelogLines);
    }

    sections.push("");

    return sections.join("\n");
  }

  const cliOriginalPackageVersions = new Map<string, string>();
  const plugin: TegamiPlugin = {
    name: "github",
    init() {
      this.github = {
        repo: options.repo ?? process.env.GITHUB_REPOSITORY,
        token: options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
      };
    },
    async resolvePlanStatus({ plan }) {
      const { repo, token } = this.github!;
      if (!repo || !token || releaseOptions === false) return;
      const requiredTags = new Set<string>();

      for (const pkg of plan.packages.values()) {
        if (pkg.preflight!.publish && pkg.git) requiredTags.add(pkg.git.tag);
      }

      try {
        await Promise.all(
          Array.from(requiredTags, async (tag) => {
            if (!(await releaseExistsByTag(repo, tag, token))) throw "pending";
          }),
        );
      } catch (e) {
        if (e === "pending") return "pending";
        throw e;
      }
    },
    async afterPublishAll({ plan }) {
      const { repo, token } = this.github!;
      if (!repo || !token || releaseOptions === false) return;
      const {
        eager = false,
        create,
        createGrouped,
      } = releaseOptions === true ? {} : releaseOptions;

      const groups = new Map<string, WorkspacePackage[]>();
      for (const [id, packagePlan] of plan.packages) {
        const pkg = this.graph.get(id)!;
        if (!eager && packagePlan.publishResult!.type === "failed") return;

        const tag = packagePlan.git?.tag;
        if (!tag) continue;

        const group = groups.get(tag);
        if (group) group.push(pkg);
        else groups.set(tag, [pkg]);
      }

      await Promise.all(
        Array.from(groups, async ([tag, packages]) => {
          let hasFailed = false;
          let hasPublished = false;
          for (const member of packages) {
            const result = plan.packages.get(member.id)!.publishResult!;
            switch (result.type) {
              case "published":
                hasPublished = true;
                break;
              case "failed":
                hasFailed = true;
                break;
            }
          }

          if (hasFailed || !hasPublished) return;
          if (await releaseExistsByTag(repo, tag, token)) return;
          let release: ResolvedGithubRelease;

          if (packages.length > 1) {
            const overrides = (await createGrouped?.call(this, { tag, packages, plan })) ?? {};
            release = {
              title: overrides.title ?? tag,
              notes:
                overrides.notes ?? (await defaultGroupedNotes(getRenderer(this), plan, packages)),
              prerelease:
                overrides.prerelease ?? packages.some((pkg) => getPrerelease(pkg.version) !== null),
            };
          } else {
            const pkg = packages[0]!;
            const overrides = (await create?.call(this, { tag, pkg, plan })) ?? {};
            const packagePlan = plan.packages.get(pkg.id);

            release = {
              title:
                overrides.title ??
                formatPackageVersion(pkg.name, pkg.version, packagePlan?.npm?.distTag),
              notes: overrides.notes ?? (await defaultNotes(getRenderer(this), pkg, packagePlan)),
              prerelease: overrides.prerelease ?? getPrerelease(pkg.version) !== null,
            };
          }

          await createGitHubRelease(repo, {
            tag,
            title: release.title,
            notes: release.notes,
            prerelease: release.prerelease,
            token,
          });
        }),
      );
    },
    cli: {
      async init() {
        if (!isCI()) return;
        const { repo, token } = this.github ?? {};
        if (!token || !repo) return;

        const result = await x(
          "git",
          ["remote", "set-url", "origin", `https://x-access-token:${token}@github.com/${repo}.git`],
          { nodeOptions: { cwd: this.cwd } },
        );
        if (result.exitCode !== 0) {
          throw execFailure("Failed to configure git remote for GitHub Actions.", result);
        }
      },
      draftCreated() {
        for (const pkg of this.graph.getPackages()) {
          cliOriginalPackageVersions.set(pkg.id, pkg.version);
        }
      },
      async draftApplied(draft) {
        const { cwd } = this;
        const [enabled, config] = resolvePROptions();
        if (!enabled || !(await hasGitChanges(cwd))) return;

        const repo = this.github?.repo;
        const { branch = "tegami/version-packages", base = "main" } = config;

        const basePR = await config.create?.call(this, { draft });
        const pr: Required<VersionPullRequest> = {
          title: basePR?.title ?? "Version Packages",
          body: basePR?.body ?? defaultVersionPRBody(draft, this),
        };

        const gitOptions = { nodeOptions: { cwd } };

        let result = await x("git", ["checkout", "-B", branch], gitOptions);
        if (result.exitCode !== 0) {
          throw execFailure("Failed to create the version pull request branch.", result);
        }

        result = await x("git", ["add", "-A"], gitOptions);
        if (result.exitCode !== 0) {
          throw execFailure("Failed to stage version changes.", result);
        }

        result = await x("git", ["commit", "-m", pr.title], gitOptions);
        if (result.exitCode !== 0) {
          throw execFailure("Failed to commit version changes.", result);
        }

        const pushArgs = ["push", "--force", "-u", "origin", branch];
        result = await x("git", pushArgs, gitOptions);
        if (result.exitCode !== 0) {
          throw execFailure(
            "Failed to push the version branch to origin. Ensure `origin` is configured and you have push access.",
            result,
          );
        }

        const token = this.github?.token;
        if (!repo) return;

        const openPr = await findOpenPullRequest(repo, branch, token);

        if (openPr !== undefined) {
          await updatePullRequest(repo, openPr, {
            title: pr.title,
            body: pr.body,
            token,
          });
          return;
        }

        await createPullRequest(repo, {
          title: pr.title,
          body: pr.body,
          head: branch,
          base,
          token,
        });
      },
    },
  };

  return [git(options), plugin];
}

async function hasGitChanges(cwd: string): Promise<boolean> {
  const result = await x("git", ["status", "--porcelain"], {
    nodeOptions: {
      cwd,
    },
  });

  return result.stdout.trim().length > 0;
}

type ChangelogRenderer = (entry: ChangelogEntry) => Promise<string>;

function createChangelogRenderer(context: TegamiContext): ChangelogRenderer {
  const cache = new Map<string, Promise<string | undefined>>();

  async function resolveFileCommit(filename: string): Promise<string | undefined> {
    const relativePath = relative(context.cwd, join(context.changelogDir, filename));
    const result = await x(
      "git",
      ["log", "--diff-filter=A", "-1", "--format=%H", "--", relativePath],
      {
        nodeOptions: { cwd: context.cwd },
      },
    );

    if (result.exitCode !== 0) return;
    return result.stdout.trim() || undefined;
  }

  function formatCommitLink(commit: string): string {
    const short = commit.slice(0, 7);
    const repo = context.github?.repo;
    if (!repo) return `\`${short}\``;

    return `[${short}](https://github.com/${repo}/commit/${commit})`;
  }

  return async (entry) => {
    let commitPromise = cache.get(entry.filename);
    if (!commitPromise) {
      commitPromise = resolveFileCommit(entry.filename);
      cache.set(entry.filename, commitPromise);
    }

    const commit = await commitPromise;
    const commitSuffix = commit ? ` (${formatCommitLink(commit)})` : "";
    const lines: string[] = [];

    for (const section of entry.sections) {
      lines.push(`### ${section.title}${commitSuffix}`, "");
      if (section.content) lines.push(section.content, "");
    }

    return lines.join("\n").trim();
  };
}

async function defaultNotes(
  renderer: ChangelogRenderer,
  pkg: WorkspacePackage,
  packagePlan?: PackagePublishPlan,
): Promise<string> {
  if (packagePlan && packagePlan.changelogs.length > 0) {
    const notes = await Promise.all(packagePlan.changelogs.map(renderer));

    return notes.join("\n\n");
  }

  return `Published ${formatPackageVersion(pkg.name, pkg.version, packagePlan?.npm?.distTag)}.`;
}

async function defaultGroupedNotes(
  renderer: ChangelogRenderer,
  plan: PublishPlan,
  packages: WorkspacePackage[],
): Promise<string> {
  const changelogs = new Map<string, ChangelogEntry>();

  for (const pkg of packages) {
    const packagePlan = plan.packages.get(pkg.id);
    if (!packagePlan) continue;

    for (const entry of packagePlan.changelogs) changelogs.set(entry.id, entry);
  }

  const sections = [
    packages
      .map((pkg) => {
        const packagePlan = plan.packages.get(pkg.id);

        return `- ${formatPackageVersion(pkg.name, pkg.version, packagePlan?.npm?.distTag)}`;
      })
      .join("\n"),
  ];

  if (changelogs.size > 0) {
    const notes = await Promise.all(Array.from(changelogs.values(), renderer));

    sections.push("", notes.join("\n\n"));
  }

  return sections.join("\n");
}
