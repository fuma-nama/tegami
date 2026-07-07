import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { ChangelogEntry } from "../changelog/parse";
import type { Awaitable, TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { git, type GitPluginOptions } from "./git";
import { cached, isCI, joinPath } from "../utils/common";
import { PublishPlan } from "../plans/publish";
import { WorkspacePackage } from "../graph";
import {
  createAutoRelease,
  versionRequestPlugin,
  resolveFileCommit,
  VersionRequestOptions,
} from "../utils/version-request";
import {
  createMergeRequest,
  createRelease as createGitLabRelease,
  findOpenMergeRequest,
  listMergeRequestsForCommit,
  releaseExistsByTag,
  updateMergeRequest,
  type GitLabToken,
  type MergeRequestSummary,
  type GitLabRequestOptions,
} from "./gitlab/api";
import { registerMrCli } from "./gitlab/cli";

interface GitlabRelease {
  /** Release title */
  title: string;
  /** Release notes */
  notes: string;
}

/** Options for creating GitLab releases after a successful publish. */
export interface GitLabPluginOptions extends GitPluginOptions {
  /** GitLab repository. */
  repo?: string;
  /** Optional GitLab token for Git & GitLab operations. */
  token?: string;
  /** GitLab API URL. Defaults to `https://gitlab.com/api/v4`. */
  apiUrl?: string;
  /** GitLab web URL. Defaults to `https://gitlab.com`. */
  webUrl?: string;

  /**
   * Create GitLab release for published packages.
   *
   * @default true
   */
  release?:
    | boolean
    | {
        /**
         * Create GitLab release immediately after successful publish, without waiting for others.
         *
         * @default false
         */
        eager?: boolean;

        /** Override release details for a single package. */
        create?: (
          this: TegamiContext,
          opts: { tag: string; pkg: WorkspacePackage; plan: PublishPlan },
        ) => Awaitable<Partial<GitlabRelease>>;
        /** Override release details when multiple packages share a git tag. */
        createGrouped?: (
          this: TegamiContext,
          opts: { tag: string; packages: WorkspacePackage[]; plan: PublishPlan },
        ) => Awaitable<Partial<GitlabRelease>>;
      };

  /**
   * (CLI only) Open a version merge request after versioning.
   *
   * Defaults to enabled in CI and disabled locally.
   */
  versionMr?: VersionRequestOptions | false;
}

/** Create GitLab releases for successfully published packages after the whole plan succeeds. */
export function gitlab(options: GitLabPluginOptions = {}): TegamiPlugin[] {
  const { release: releaseOptions = true } = options;

  let autoRelease: ReturnType<typeof createAutoRelease<GitlabRelease>> | undefined;

  const plugin: TegamiPlugin = {
    name: "gitlab",
    init() {
      const { repo, token, webUrl } = (this.gitlab = {
        repo: options.repo ?? process.env.GITLAB_REPOSITORY ?? process.env.CI_PROJECT_PATH,
        token: resolveGitLabToken(options.token),
        apiUrl:
          options.apiUrl ??
          process.env.GITLAB_API_URL ??
          process.env.CI_API_V4_URL ??
          "https://gitlab.com/api/v4",
        webUrl:
          options.webUrl ??
          process.env.GITLAB_SERVER_URL ??
          process.env.CI_SERVER_URL ??
          "https://gitlab.com",
      });

      if (repo && token && releaseOptions !== false) {
        const {
          eager = false,
          create,
          createGrouped,
        } = releaseOptions === true ? {} : releaseOptions;

        const api = gitLabApiOptions(this.gitlab);
        const resolveEntryMeta = cached(
          (entry: ChangelogEntry) => entry.id,
          async (entry) => {
            const commit = await resolveFileCommit(this, entry.filename);
            if (!commit || !repo) return { commit, mergeRequests: [] as MergeRequestSummary[] };

            return {
              commit,
              mergeRequests: await listMergeRequestsForCommit(repo, commit, api).catch(() => []),
            };
          },
        );

        autoRelease = createAutoRelease({
          eager,
          override: create,
          overrideGroup: createGrouped,
          async formatChangelog(entry) {
            const meta = await resolveEntryMeta(entry);
            const commitSuffix = meta.commit
              ? ` ([${meta.commit.slice(0, 7)}](${joinPath(webUrl, repo, "-/commit", meta.commit)}))`
              : "";
            const lines: string[] = [];

            for (const section of entry.sections) {
              lines.push(`### ${section.title}${commitSuffix}`, "");
              if (section.content) lines.push(section.content, "");
            }

            if (meta.mergeRequests.length > 0) {
              lines.push("<details>", "<summary>Merge request & contributors</summary>", "");

              for (const mr of meta.mergeRequests) {
                let line = `- [!${mr.number} ${mr.title}](${joinPath(webUrl, repo, "-/merge_requests", String(mr.number))})`;
                if (mr.user) line += ` by @${mr.user.login}`;
                lines.push(line);
              }

              lines.push("", "</details>");
            }

            return lines.join("\n").trim();
          },
          create({ input, tag }) {
            return createGitLabRelease(repo, {
              tag,
              title: input.title,
              notes: input.notes,
              ...api,
            });
          },
          releaseExistsByTag(tag) {
            return releaseExistsByTag(repo, tag, api);
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
      registerMrCli(cli);
      if (!isCI()) return;
      const { repo, token, webUrl } = this.gitlab!;
      if (!token || !repo) return;

      const origin = gitlabRemoteUrl(repo, token, webUrl);
      const result = await x("git", ["remote", "set-url", "origin", origin], {
        nodeOptions: { cwd: this.cwd },
      });
      if (result.exitCode !== 0) {
        throw execFailure("Failed to configure git remote for GitLab CI.", result);
      }
    },
  };

  return [
    git(options),
    plugin,
    versionRequestPlugin({
      name: "gitlab",
      options: options.versionMr,
      canCreate(context) {
        const { repo, token } = context.gitlab ?? {};
        return Boolean(repo && token);
      },
      async upsert(context, request, update) {
        const repo = context.gitlab!.repo!;
        const api = gitLabApiOptions(context.gitlab);
        const openMr = await findOpenMergeRequest(repo, {
          head: request.head,
          base: request.base,
          ...api,
        });

        if (openMr === undefined) {
          await createMergeRequest(repo, {
            title: request.title,
            body: request.body,
            head: request.head,
            base: request.base,
            ...api,
          });
        } else if (update) {
          await updateMergeRequest(repo, openMr, {
            title: request.title,
            body: request.body,
            base: request.base,
            ...api,
          });
        }
      },
    }),
  ];
}

function gitLabApiOptions(gitlab: TegamiContext["gitlab"]): GitLabRequestOptions {
  const options: GitLabRequestOptions = {};
  if (gitlab?.apiUrl) options.apiUrl = gitlab.apiUrl;
  if (gitlab?.token) options.token = gitlab.token;
  return options;
}

function resolveGitLabToken(optionToken?: string): GitLabToken | undefined {
  if (optionToken) return { value: optionToken, type: "private-token" };
  if (process.env.GITLAB_TOKEN) {
    return { value: process.env.GITLAB_TOKEN, type: "private-token" };
  }
  if (process.env.GL_TOKEN) {
    return { value: process.env.GL_TOKEN, type: "private-token" };
  }
  if (process.env.CI_JOB_TOKEN) {
    return { value: process.env.CI_JOB_TOKEN, type: "job-token" };
  }
}

function gitlabRemoteUrl(repo: string, token: GitLabToken, webUrl: string): string {
  const username = token.type === "job-token" ? "gitlab-ci-token" : "oauth2";
  const authenticatedUrl = webUrl.replace(/^https?:\/\//, `https://${username}:${token.value}@`);

  return joinPath(authenticatedUrl, `${repo}.git`);
}
