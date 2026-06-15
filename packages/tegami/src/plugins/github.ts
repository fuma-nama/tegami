import { x } from "tinyexec";
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

  /** Override release details for a single package, return `false` to skip. */
  onCreateRelease?: (result: PackagePublishResult) => Awaitable<GithubRelease | false>;
  /** Override release details when multiple packages share a git tag, return `false` to skip. */
  onCreateGroupedRelease?: (packages: PackagePublishResult[]) => Awaitable<GithubRelease | false>;
  /** Override details for "Version Packages" PR. */
  onCreateVersionPullRequest?: (publishPlan: DraftPlan) => Awaitable<VersionPullRequest | false>;

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

  async function createRelease(pkg: PackagePublishResult): Promise<void> {
    if (!pkg.gitTag) return;

    const release = (await options.onCreateRelease?.(pkg)) ?? {};
    if (release === false) return;

    await runGithubRelease(
      pkg.gitTag,
      release.title ?? defaultTitle(pkg),
      release.notes ?? defaultNotes(pkg),
      release.prerelease ?? getPrerelease(pkg.version) !== null,
    );
  }

  async function createGroupedRelease(packages: PackagePublishResult[]): Promise<void> {
    const primary = packages[0];
    if (!primary?.gitTag) return;

    const release = (await options.onCreateGroupedRelease?.(packages)) ?? {};
    if (release === false) return;

    await runGithubRelease(
      primary.gitTag,
      release.title ?? defaultGroupedTitle(packages),
      release.notes ?? defaultGroupedNotes(packages),
      release.prerelease ?? packages.some((pkg) => getPrerelease(pkg.version) !== null),
    );
  }

  function resolvePROptions(): [false] | [true, VersionPullRequestOptions] {
    const setting = options.cli?.versionPr ?? isCI();

    if (setting === false) {
      return [false];
    }

    return [true, typeof setting === "object" ? setting : {}];
  }

  function defaultVersionPRBody(draft: DraftPlan, context: TegamiContext): string {
    const packageLines: string[] = [];

    for (const id of draft.getPackageIds()) {
      const packagePlan = draft.getPackage(id);
      if (!packagePlan) continue;

      const pkg = context.graph.get(id);
      if (!pkg) continue;

      const publishTxt = packagePlan.publish ? "" : " (no publish)";
      const distTagTxt = formatNpmDistTag(packagePlan.npm?.distTag);
      packageLines.push(
        `- ${pkg.name}@${cliOriginalPackageVersions.get(pkg.id) ?? pkg.version} → ${pkg.name}@${pkg.version}${distTagTxt}${publishTxt}`,
      );
    }

    const changelogLines = draft
      .getChangelogIds()
      .map((id) => draft.getChangelog(id))
      .filter((entry) => entry !== undefined)
      .map((entry) => `- ${entry.title}`);
    const sections = ["## Summary", ...packageLines];

    if (changelogLines.length > 0) {
      sections.push("", "## Changelogs", ...changelogLines);
    }

    sections.push("", "Merge this PR to publish the versioned packages.");

    return sections.join("\n");
  }

  const cliOriginalPackageVersions = new Map<string, string>();
  return [
    git(options),
    {
      name: "github",
      cli: {
        async init() {
          if (!isCI()) return;

          const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
          const repository = options.repo ?? process.env.GITHUB_REPOSITORY;
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

          const basePR = await options.onCreateVersionPullRequest?.(draft);
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

          if (await hasOpenPullRequest(branch, options.repo)) return;

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
      async afterPublish(result) {
        if (result.state !== "created") return;

        for (const packages of groupPackagesByGitTag(result.packages).values()) {
          if (packages.length > 1) {
            await createGroupedRelease(packages);
          } else {
            await createRelease(packages[0]!);
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

async function hasOpenPullRequest(branch: string, repo: string | undefined): Promise<boolean> {
  const args = ["pr", "list", "--head", branch, "--state", "open", "--json", "number"];
  if (repo) args.push("--repo", repo);

  const result = await x("gh", args);
  if (result.exitCode !== 0) {
    throw execFailure("Failed to check for an existing version pull request.", result);
  }

  return result.stdout.trim() !== "[]";
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

function defaultNotes(pkg: PackagePublishResult): string {
  if (pkg.changelogs.length > 0) {
    return pkg.changelogs
      .map((entry) => [`### ${entry.title}`, entry.content].filter(Boolean).join("\n\n"))
      .join("\n\n");
  }

  return `Published ${formatPackageVersion(pkg.name, pkg.version, pkg.npm?.distTag)}.`;
}

function defaultGroupedNotes(packages: PackagePublishResult[]): string {
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
    sections.push(
      "",
      Array.from(changelogs.values())
        .map((entry) => [`### ${entry.title}`, entry.content].filter(Boolean).join("\n\n"))
        .join("\n\n"),
    );
  } else {
    sections.push("", `Published ${packages[0]!.gitTag}.`);
  }

  return sections.join("\n");
}
