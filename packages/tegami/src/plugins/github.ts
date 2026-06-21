import { x } from "tinyexec";
import { join, relative } from "node:path";
import { prerelease as getPrerelease } from "semver";
import type { TegamiContext } from "../context";
import type { ChangelogEntry } from "../changelog/parse";
import type { DraftPlan } from "../plans/draft";
import type { PackagePublishResult } from "../publish";
import type { Awaitable, TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { formatNpmDistTag, formatPackageVersion } from "../utils/semver";
import { git, type GitPluginOptions } from "./git";
import { isCI } from "../utils/constants";

interface GithubRelease {
  /** Release title */
  title?: string;
  /** Release notes */
  notes?: string;
  /** Whether to mark release as prerelease */
  prerelease?: boolean;
}

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
}

/** Options for creating GitHub releases after a successful publish. */
export interface GitHubPluginOptions extends GitPluginOptions {
  /** GitHub repository. */
  repo?: string;
  /** Optional GitHub token for Git & GitHub operations. */
  token?: string;

  /** Override release details for a single package, return `false` to skip. */
  onCreateRelease?: (
    this: TegamiContext,
    result: PackagePublishResult,
  ) => Awaitable<GithubRelease | false>;
  /** Override release details when multiple packages share a git tag, return `false` to skip. */
  onCreateGroupedRelease?: (
    this: TegamiContext,
    packages: PackagePublishResult[],
  ) => Awaitable<GithubRelease | false>;
  /** Override details for "Version Packages" PR. */
  onCreateVersionPullRequest?: (
    this: TegamiContext,
    publishPlan: DraftPlan,
  ) => Awaitable<VersionPullRequest | false>;

  cli?: {
    /**
     * Open a version pull request after versioning.
     * Defaults to enabled in CI and disabled locally.
     * Set to `true` to always create the pull request.
     */
    versionPr?: boolean | VersionPullRequestOptions;
  };
}

/** Create GitHub releases for successfully published packages after the whole plan succeeds. */
export function github(options: GitHubPluginOptions = {}): TegamiPlugin[] {
  async function runGithubRelease(
    gitTag: string,
    title: string,
    notes: string,
    prerelease: boolean,
  ): Promise<void> {
    const args: string[] = ["release", "create", gitTag, "--title", title, "--notes", notes];

    if (options.repo) {
      args.push("--repo", options.repo);
    }

    if (prerelease) {
      args.push("--prerelease");
    }

    const result = await x("gh", args);
    if (result.exitCode !== 0) {
      throw execFailure(`Failed to create GitHub release for ${gitTag}.`, result);
    }
  }

  async function createRelease(context: TegamiContext, pkg: PackagePublishResult): Promise<void> {
    if (!pkg.gitTag) return;

    const release = (await options.onCreateRelease?.call(context, pkg)) ?? {};
    if (release === false) return;

    await runGithubRelease(
      pkg.gitTag,
      release.title ?? defaultTitle(pkg),
      release.notes ?? (await defaultNotes(context, pkg)),
      release.prerelease ?? getPrerelease(pkg.version) !== null,
    );
  }

  async function createGroupedRelease(
    context: TegamiContext,
    packages: PackagePublishResult[],
  ): Promise<void> {
    const primary = packages[0];
    if (!primary?.gitTag) return;

    const release = (await options.onCreateGroupedRelease?.call(context, packages)) ?? {};
    if (release === false) return;

    await runGithubRelease(
      primary.gitTag,
      release.title ?? defaultGroupedTitle(packages),
      release.notes ?? (await defaultGroupedNotes(context, packages)),
      release.prerelease ?? packages.some((pkg) => getPrerelease(pkg.version) !== null),
    );
  }

  function resolvePROptions(): [false] | [true, VersionPullRequestOptions] {
    const setting = options.cli?.versionPr ?? isCI();

    if (setting === false) {
      return [false];
    }

    if (setting === true) {
      return [true, {}];
    }

    if (setting.forceCreate || isCI()) {
      return [true, setting];
    }

    return [false];
  }

  function defaultVersionPRBody(draft: DraftPlan, context: TegamiContext): string {
    const packageLines: string[] = [];

    for (const pkg of context.graph.getPackages()) {
      const packagePlan = draft.getPackagePlan(pkg.id);
      if (!packagePlan) continue;
      const originalVersion = cliOriginalPackageVersions.get(pkg.id) ?? pkg.version;
      if (originalVersion === pkg.version) continue;

      const publishTxt = packagePlan.publish ? "" : " (no publish)";
      const distTagTxt = formatNpmDistTag(packagePlan.npm?.distTag);
      packageLines.push(
        `- ${pkg.name}@${originalVersion} → ${pkg.name}@${pkg.version}${distTagTxt}${publishTxt}`,
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

    const sections = [
      "## Summary",
      "",
      "Merge this PR to publish the versioned packages.",
      "",
      ...packageLines,
    ];

    if (changelogLines.length > 0) {
      sections.push("", "## Changelogs", ...changelogLines);
    }

    sections.push("");

    return sections.join("\n");
  }

  const cliOriginalPackageVersions = new Map<string, string>();
  return [
    git(options),
    {
      name: "github",
      init() {
        const repository = options.repo ?? process.env.GITHUB_REPOSITORY;
        const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
        this.github = {
          repo: repository,
          token,
        };
      },
      cli: {
        async init() {
          if (!isCI()) return;

          const repository = this.github?.repo;
          const token = this.github?.token;
          if (!token || !repository) return;

          const result = await x(
            "git",
            [
              "remote",
              "set-url",
              "origin",
              `https://x-access-token:${token}@github.com/${repository}.git`,
            ],
            { nodeOptions: { cwd: this.cwd } },
          );
          if (result.exitCode !== 0) {
            throw execFailure("Failed to configure git remote for GitHub Actions.", result);
          }
        },
        publishPlanCreated() {
          for (const pkg of this.graph.getPackages()) {
            cliOriginalPackageVersions.set(pkg.id, pkg.version);
          }
        },
        async publishPlanApplied(draft) {
          const { cwd } = this;
          const [enabled, config] = resolvePROptions();
          if (!enabled || !(await hasGitChanges(cwd))) return;

          const { branch = "tegami/version-packages", base = "main" } = config;

          const basePR = await options.onCreateVersionPullRequest?.call(this, draft);
          if (basePR === false) return;
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

          const openPr = await findOpenPullRequest(branch, options.repo);

          if (openPr !== undefined) {
            const editArgs = ["pr", "edit", String(openPr), "--title", pr.title, "--body", pr.body];
            if (options.repo) editArgs.push("--repo", options.repo);

            const editResult = await x("gh", editArgs);
            if (editResult.exitCode !== 0) {
              throw execFailure("Failed to update the version pull request.", editResult);
            }
            return;
          }

          const args = [
            "pr",
            "create",
            "--title",
            pr.title,
            "--body",
            pr.body,
            "--head",
            branch,
            "--base",
            base,
          ];
          if (options.repo) args.push("--repo", options.repo);

          const prResult = await x("gh", args);
          if (prResult.exitCode !== 0) {
            throw execFailure("Failed to create the version pull request.", prResult);
          }
        },
      },
      async afterPublishAll(result) {
        if (result.state !== "created") return;

        for (const packages of groupPackagesByGitTag(result.packages).values()) {
          if (packages.length > 1) {
            await createGroupedRelease(this, packages);
          } else {
            await createRelease(this, packages[0]!);
          }
        }
      },
    },
  ];
}

async function hasGitChanges(cwd: string): Promise<boolean> {
  const result = await x("git", ["status", "--porcelain"], {
    nodeOptions: {
      cwd,
    },
  });

  return result.stdout.trim().length > 0;
}

async function findOpenPullRequest(
  branch: string,
  repo: string | undefined,
): Promise<number | undefined> {
  const args = ["pr", "list", "--head", branch, "--state", "open", "--json", "number"];
  if (repo) args.push("--repo", repo);

  const result = await x("gh", args);
  if (result.exitCode !== 0) {
    throw execFailure("Failed to check for an existing version pull request.", result);
  }

  const pullRequests = JSON.parse(result.stdout) as Array<{ number: number }>;
  return pullRequests[0]?.number;
}

function groupPackagesByGitTag(
  packages: PackagePublishResult[],
): Map<string, PackagePublishResult[]> {
  const groups = new Map<string, PackagePublishResult[]>();

  for (const pkg of packages) {
    if (!pkg.gitTag) continue;

    const group = groups.get(pkg.gitTag);
    if (group) group.push(pkg);
    else groups.set(pkg.gitTag, [pkg]);
  }

  return groups;
}

function defaultTitle(pkg: PackagePublishResult): string {
  return formatPackageVersion(pkg.name, pkg.version, pkg.npm?.distTag);
}

function defaultGroupedTitle(packages: PackagePublishResult[]): string {
  const primary = packages[0]!;
  const distTag = packages.every((pkg) => pkg.npm?.distTag === primary.npm?.distTag)
    ? primary.npm?.distTag
    : undefined;

  return formatPackageVersion(
    primary.gitTag!.slice(0, primary.gitTag!.lastIndexOf("@")),
    primary.version,
    distTag,
  );
}

function formatCommitLink(commit: string, repo?: string): string {
  const short = commit.slice(0, 7);
  if (!repo) return `\`${short}\``;

  return `[${short}](https://github.com/${repo}/commit/${commit})`;
}

async function resolveChangelogEntryCommit(
  context: TegamiContext,
  filename: string,
): Promise<string | undefined> {
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

async function renderChangelogEntryNotes(
  context: TegamiContext,
  entry: ChangelogEntry,
): Promise<string> {
  const repo = context.github?.repo;
  const commit = await resolveChangelogEntryCommit(context, entry.filename);
  const commitSuffix = commit ? ` (${formatCommitLink(commit, repo)})` : "";
  const lines: string[] = [];

  for (const section of entry.sections) {
    lines.push(`### ${section.title}${commitSuffix}`, "");
    if (section.content) lines.push(section.content, "");
  }

  return lines.join("\n").trim();
}

async function defaultNotes(context: TegamiContext, pkg: PackagePublishResult): Promise<string> {
  if (pkg.changelogs.length > 0) {
    const notes = await Promise.all(
      pkg.changelogs.map(async (entry) => renderChangelogEntryNotes(context, entry)),
    );

    return notes.join("\n\n");
  }

  return `Published ${formatPackageVersion(pkg.name, pkg.version, pkg.npm?.distTag)}.`;
}

async function defaultGroupedNotes(
  context: TegamiContext,
  packages: PackagePublishResult[],
): Promise<string> {
  const changelogs = new Map<string, ChangelogEntry>();

  for (const pkg of packages) {
    for (const entry of pkg.changelogs) changelogs.set(entry.id, entry);
  }

  const sections = [
    packages
      .map((pkg) => `- ${formatPackageVersion(pkg.name, pkg.version, pkg.npm?.distTag)}`)
      .join("\n"),
  ];

  if (changelogs.size > 0) {
    const notes = await Promise.all(
      Array.from(changelogs.values()).map((entry) => renderChangelogEntryNotes(context, entry)),
    );

    sections.push("", notes.join("\n\n"));
  } else {
    sections.push("", `Published ${packages[0]!.gitTag}.`);
  }

  return sections.join("\n");
}
