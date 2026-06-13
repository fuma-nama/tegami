import { x } from "tinyexec";
import type { PackagePublishResult } from "../publish";
import type { TegamiPlugin } from "../types";

type GithubReleaseValue<T> = T | ((pkg: PackagePublishResult) => T);

/** Options for creating GitHub releases after a successful publish. */
export interface GithubReleaseOptions {
  /** GitHub repository passed to `gh release create --repo`. */
  repo?: string;
  /** Release title, or a function that derives one from the published package. */
  title?: GithubReleaseValue<string>;
  /** Release notes, or a function that derives them from the published package. */
  notes?: GithubReleaseValue<string>;
  /** Whether to mark releases as prereleases. */
  prerelease?: GithubReleaseValue<boolean>;
}

/** Create GitHub releases for successfully published packages after the whole plan succeeds. */
export function githubRelease(options: GithubReleaseOptions = {}): TegamiPlugin {
  async function createGithubRelease(pkg: PackagePublishResult): Promise<void> {
    if (!pkg.gitTag) return;

    const args: string[] = [
      "release",
      "create",
      pkg.gitTag,
      "--title",
      resolveOption(options.title, pkg) ?? `${pkg.name}@${pkg.version}`,
      "--notes",
      resolveOption(options.notes, pkg) ?? defaultNotes(pkg),
    ];

    if (options.repo) {
      args.push("--repo", options.repo);
    }

    if (resolveOption(options.prerelease, pkg)) {
      args.push("--prerelease");
    }

    await x("gh", args, {
      throwOnError: true,
    });
  }

  return {
    name: "github-release",
    async afterPublish(result) {
      if (result.state !== "success") return;

      await Promise.all(result.packages.map(createGithubRelease));
    },
  };
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

function resolveOption<T>(
  value: GithubReleaseValue<T> | undefined,
  pkg: PackagePublishResult,
): T | undefined {
  return typeof value === "function" ? (value as (pkg: PackagePublishResult) => T)(pkg) : value;
}
