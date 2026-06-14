import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { DraftPlan } from "../draft";
import type { PackagePublishResult } from "../publish";
import type { Awaitable, TegamiPlugin } from "../types";
import { execFailure } from "../utils/exec";
import { formatVersionBump, previousVersion } from "../utils/semver";
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

interface VersionPullRequestOptions {
  /** Pull request branch. */
  branch?: string;
  /** Pull request base branch. */
  base?: string;
  /** Pull request title. */
  title?: string;
  /** Pull request body. */
  body?: string;
}

/** Options for creating GitHub releases after a successful publish. */
export interface GitHubPluginOptions extends GitPluginOptions {
  /** GitHub repository. */
  repo?: string;

  /** override release details, return `false` to skip */
  onCreateRelease?: (result: PackagePublishResult) => Awaitable<GithubRelease | false>;

  cli?: {
    /**
     * Open a version pull request after versioning.
     * Defaults to enabled in CI and disabled locally.
     * Set to `true` to always create the pull request.
     */
    createVersionPR?: boolean | VersionPullRequestOptions;
  };
}

/** Create GitHub releases for successfully published packages after the whole plan succeeds. */
export function github(options: GitHubPluginOptions = {}): TegamiPlugin[] {
  async function createGithubRelease(pkg: PackagePublishResult): Promise<void> {
    if (!pkg.gitTag) return;
    const release = (await options.onCreateRelease?.(pkg)) ?? {};
    if (release === false) return;

    const args: string[] = [
      "release",
      "create",
      pkg.gitTag,
      "--title",
      release.title ?? `${pkg.name}@${pkg.version}`,
      "--notes",
      release.notes ?? defaultNotes(pkg),
    ];

    if (options.repo) {
      args.push("--repo", options.repo);
    }

    if (release.prerelease) {
      args.push("--prerelease");
    }

    const result = await x("gh", args);
    if (result.exitCode !== 0) {
      throw new Error(
        execFailure(`Failed to create GitHub release for ${pkg.name}@${pkg.version}.`, result),
      );
    }
  }

  function resolvePROptions(): [false] | [true, VersionPullRequestOptions] {
    const setting = options.cli?.createVersionPR ?? isCI();

    if (setting === false) {
      return [false];
    }

    return [true, typeof setting === "object" ? setting : {}];
  }

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
            throw new Error(
              execFailure("Failed to configure git remote for GitHub Actions.", result),
            );
          }
        },
        async afterVersion(draft) {
          const { cwd } = this;
          const [enabled, config] = resolvePROptions();
          if (!enabled || !(await hasGitChanges(cwd))) return;

          const {
            branch = "tegami/version-packages",
            base = "main",
            title = "Version Packages",
            body = defaultVersionPRBody(draft, this),
          } = config;

          const gitOptions = { nodeOptions: { cwd } };

          let result = await x("git", ["checkout", "-B", branch], gitOptions);
          if (result.exitCode !== 0) {
            throw new Error(
              execFailure("Failed to create the version pull request branch.", result),
            );
          }

          result = await x("git", ["add", "-A"], gitOptions);
          if (result.exitCode !== 0) {
            throw new Error(execFailure("Failed to stage version changes.", result));
          }

          result = await x("git", ["commit", "-m", title], gitOptions);
          if (result.exitCode !== 0) {
            throw new Error(execFailure("Failed to commit version changes.", result));
          }

          const pushArgs = ["push", "--force", "-u", "origin", branch];
          result = await x("git", pushArgs, gitOptions);
          if (result.exitCode !== 0) {
            throw new Error(
              execFailure(
                "Failed to push the version branch to origin. Ensure `origin` is configured and you have push access.",
                result,
              ),
            );
          }

          if (await hasOpenPullRequest(branch, options.repo)) return;

          const args = [
            "pr",
            "create",
            "--title",
            title,
            "--body",
            body,
            "--head",
            branch,
            "--base",
            base,
          ];
          if (options.repo) args.push("--repo", options.repo);

          const prResult = await x("gh", args);
          if (prResult.exitCode !== 0) {
            throw new Error(execFailure("Failed to create the version pull request.", prResult));
          }
        },
      },
      async afterPublish(result) {
        if (result.state !== "created") return;

        await Promise.all(result.packages.map(createGithubRelease));
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
    throw new Error(execFailure("Failed to check for an existing version pull request.", result));
  }

  return result.stdout.trim() !== "[]";
}

function defaultVersionPRBody(draft: DraftPlan, context: TegamiContext): string {
  const packageLines: string[] = [];

  for (const id of draft.getPackageIds()) {
    const packagePlan = draft.getPackage(id);
    if (!packagePlan) continue;

    const pkg = context.graph.get(id);
    if (!pkg) continue;

    const publish = packagePlan.publish ? "" : " (no publish)";
    const previous = previousVersion(pkg.version, packagePlan.type);
    packageLines.push(
      `- ${formatVersionBump(pkg.name, previous, pkg.version, packagePlan.distTag)}${publish}`,
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

function defaultNotes(pkg: PackagePublishResult): string {
  const entries = pkg.changelogs;
  if (entries.length > 0) {
    return entries
      .map((entry) => [`### ${entry.title}`, entry.content].filter(Boolean).join("\n\n"))
      .join("\n\n");
  }

  return [`Published ${pkg.name}@${pkg.version}.`, "", `npm dist-tag: ${pkg.distTag}`].join("\n");
}
