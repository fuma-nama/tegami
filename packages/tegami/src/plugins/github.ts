import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { DraftPlan } from "../draft";
import type { PackagePublishResult } from "../publish";
import type { Awaitable, TegamiPlugin } from "../types";
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

    await x("gh", args, {
      throwOnError: true,
    });
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

          async function runGit(...args: string[]): Promise<void> {
            await x("git", args, {
              nodeOptions: {
                cwd,
              },
              throwOnError: true,
            });
          }

          await runGit("checkout", "-B", branch);
          await runGit("add", "-A");
          await runGit("commit", "-m", title);
          await runGit("push", "--force", "-u", "origin", branch);

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

          await x("gh", args, { throwOnError: true });
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

  const result = await x("gh", args, {
    throwOnError: true,
  });

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
    packageLines.push(`- ${pkg.name}: ${packagePlan.type} → \`${pkg.version}\`${publish}`);
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
