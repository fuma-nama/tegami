import { x } from "tinyexec";
import semver from "semver";
import type { TegamiContext } from "../context";
import type { ChangelogEntry } from "../changelog/parse";
import type { Awaitable, TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { git, type GitPluginOptions } from "./git";
import { cached, isCI } from "../utils/common";
import { PublishPlan } from "../plans/publish";
import { WorkspacePackage } from "../graph";
import {
  createAutoRelease,
  versionRequestPlugin,
  resolveFileCommit,
  VersionRequestOptions,
} from "../utils/version-request";
import {
  createPullRequest,
  createRelease as createGitHubRelease,
  findOpenPullRequest,
  listPullRequestsForCommit,
  releaseExistsByTag,
  updatePullRequest,
} from "./github/api";
import { registerPrCli } from "./github/cli";

interface GithubRelease {
  /** Release title */
  title: string;
  /** Release notes */
  notes: string;
  /** Whether to mark release as prerelease */
  prerelease: boolean;
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
        ) => Awaitable<Partial<GithubRelease>>;
        /** Override release details when multiple packages share a git tag. */
        createGrouped?: (
          this: TegamiContext,
          opts: { tag: string; packages: WorkspacePackage[]; plan: PublishPlan },
        ) => Awaitable<Partial<GithubRelease>>;
      };

  /**
   * (CLI only) Open a version pull request after versioning.
   *
   * Defaults to enabled in CI and disabled locally.
   */
  versionPr?: VersionRequestOptions | false;
}

/** Create GitHub releases for successfully published packages after the whole plan succeeds. */
export function github(options: GitHubPluginOptions = {}): TegamiPlugin[] {
  const { release: releaseOptions = true } = options;

  let autoRelease: ReturnType<typeof createAutoRelease<GithubRelease>> | undefined;
  const plugin: TegamiPlugin = {
    name: "github",
    init() {
      const { repo, token } = (this.github = {
        repo: options.repo ?? process.env.GITHUB_REPOSITORY,
        token: options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
      });

      if (repo && token && releaseOptions !== false) {
        const {
          eager = false,
          create,
          createGrouped,
        } = releaseOptions === true ? {} : releaseOptions;
        const resolveEntryMeta = cached(
          (entry: ChangelogEntry) => entry.id,
          async (entry) => {
            const commit = await resolveFileCommit(this, entry.filename);
            if (!commit) return { commit, pullRequests: [] };

            return {
              commit,
              pullRequests: await listPullRequestsForCommit(repo, commit, token).catch(() => []),
            };
          },
        );

        autoRelease = createAutoRelease({
          eager,
          override: create,
          overrideGroup: createGrouped,
          async formatChangelog(entry) {
            const meta = await resolveEntryMeta(entry);
            const lines: string[] = [];
            const commitSuffix = meta.commit
              ? ` ([${meta.commit.slice(0, 7)}](https://github.com/${repo}/commit/${meta.commit}))`
              : "";

            for (const section of entry.sections) {
              lines.push(`### ${section.title}${commitSuffix}`, "");
              if (section.content) lines.push(section.content, "");
            }

            if (meta.pullRequests.length > 0) {
              lines.push("<details>", "<summary>Pull request & contributors</summary>", "");

              for (const pr of meta.pullRequests) {
                let line = `- [#${pr.number} ${pr.title}](https://github.com/${repo}/pull/${pr.number})`;
                if (pr.user) line += ` by @${pr.user.login}`;
                lines.push(line);
              }

              lines.push("", "</details>");
            }

            return lines.join("\n").trim();
          },
          create({ input, packages, tag }) {
            return createGitHubRelease({
              ...input,
              repo,
              tag,
              token,
              prerelease:
                input.prerelease ??
                packages.some((pkg) => pkg.version && semver.prerelease(pkg.version)),
            });
          },
          releaseExistsByTag(tag) {
            return releaseExistsByTag(repo, tag, token);
          },
        });
      }
    },
    async resolvePlanStatus({ plan }) {
      if (await autoRelease?.hasPending.call(this, plan)) return "pending";
    },
    async afterPublishAll({ plan }) {
      await autoRelease?.create.call(this, plan);
    },
    async initCli(cli) {
      registerPrCli(cli);
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
  };

  return [
    git(options),
    plugin,
    versionRequestPlugin({
      name: "github",
      options: options.versionPr,
      canCreate(context) {
        const { repo, token } = context.github ?? {};
        return Boolean(repo && token);
      },
      async upsert(context, request, update) {
        const { repo, token } = context.github!;
        const openPr = await findOpenPullRequest(repo!, request.head, token);

        if (openPr === undefined) {
          await createPullRequest(repo!, {
            title: request.title,
            body: request.body,
            head: request.head,
            base: request.base,
            token,
          });
        } else if (update) {
          await updatePullRequest(repo!, openPr, {
            title: request.title,
            body: request.body,
            token,
          });
        }
      },
    }),
  ];
}
