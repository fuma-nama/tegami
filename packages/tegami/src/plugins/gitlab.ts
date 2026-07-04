import { x } from "tinyexec";
import { join, relative } from "node:path";
import type { TegamiContext } from "../context";
import type { ChangelogEntry } from "../changelog/parse";
import type { Awaitable, TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { formatPackageVersion } from "../utils/semver";
import { git, type GitPluginOptions } from "./git";
import { cached, isCI, joinPath } from "../utils/common";
import { PackagePublishPlan, PublishPlan } from "../plans/publish";
import { WorkspacePackage } from "../graph";
import { onVersionRequest, VersionRequestOptions } from "../utils/version-request";
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
  title?: string;
  /** Release notes */
  notes?: string;
}

type ResolvedGitlabRelease = Required<GitlabRelease>;

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
        ) => Awaitable<GitlabRelease>;
        /** Override release details when multiple packages share a git tag. */
        createGrouped?: (
          this: TegamiContext,
          opts: { tag: string; packages: WorkspacePackage[]; plan: PublishPlan },
        ) => Awaitable<GitlabRelease>;
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

  let renderer: ChangelogRenderer | undefined;
  function getRenderer(context: TegamiContext): ChangelogRenderer {
    return (renderer ??= createChangelogRenderer(context));
  }

  const versionRequests = onVersionRequest({
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
  });

  const plugin: TegamiPlugin = {
    ...versionRequests,
    name: "gitlab",
    init() {
      this.gitlab = {
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
      };
    },
    async resolvePlanStatus({ plan }) {
      if (versionRequests.resolvePlanStatus.call(this, { plan }) === "pending") return "pending";

      const { repo, token } = this.gitlab!;
      if (!repo || !token || releaseOptions === false) return;
      const requiredTags = new Set<string>();
      const api = gitLabApiOptions(this.gitlab);

      for (const pkg of plan.packages.values()) {
        if (pkg.preflight!.shouldPublish && pkg.git?.tag) requiredTags.add(pkg.git.tag);
      }

      return Array.from(requiredTags, async (tag) => {
        if (!(await releaseExistsByTag(repo, tag, api))) return "pending";
      });
    },
    async afterPublishAll({ plan }) {
      const { repo, token } = this.gitlab!;
      if (!repo || !token || releaseOptions === false) return;
      const api = gitLabApiOptions(this.gitlab);
      const {
        eager = false,
        create,
        createGrouped,
      } = releaseOptions === true ? {} : releaseOptions;

      const groups = new Map<string, WorkspacePackage[]>();
      for (const [id, { preflight, publishResult, git }] of plan.packages) {
        if (!eager && publishResult!.type === "failed") return;

        const tag = git?.tag;
        if (!tag || !preflight!.shouldPublish) continue;

        const pkg = this.graph.get(id)!;
        const group = groups.get(tag);
        if (group) group.push(pkg);
        else groups.set(tag, [pkg]);
      }

      await Promise.all(
        Array.from(groups, async ([tag, packages]) => {
          for (const member of packages) {
            const result = plan.packages.get(member.id)!.publishResult!;
            if (result.type === "failed") return;
          }

          if (await releaseExistsByTag(repo, tag, api)) return;
          let release: ResolvedGitlabRelease;

          if (packages.length > 1) {
            const overrides = (await createGrouped?.call(this, { tag, packages, plan })) ?? {};
            release = {
              title: overrides.title ?? tag,
              notes:
                overrides.notes ?? (await defaultGroupedNotes(getRenderer(this), plan, packages)),
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
            };
          }

          await createGitLabRelease(repo, {
            tag,
            title: release.title,
            notes: release.notes,
            ...api,
          });
        }),
      );
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

  return [git(options), plugin];
}

type ChangelogRenderer = (entry: ChangelogEntry) => Promise<string>;

interface ChangelogEntryMeta {
  commit?: string;
  mergeRequests: MergeRequestSummary[];
}

function createChangelogRenderer(context: TegamiContext): ChangelogRenderer {
  const { repo, webUrl } = context.gitlab!;
  const api = gitLabApiOptions(context.gitlab);

  const resolveFileCommit = cached(
    (filename: string) => filename,
    async (filename): Promise<string | undefined> => {
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
    },
  );

  const resolveEntryMeta = cached(
    (entry: ChangelogEntry) => entry.id,
    async (entry): Promise<ChangelogEntryMeta> => {
      const commit = await resolveFileCommit(entry.filename);
      if (!commit || !repo) return { commit, mergeRequests: [] };

      return {
        commit,
        mergeRequests: await listMergeRequestsForCommit(repo, commit, api).catch(() => []),
      };
    },
  );

  function formatEntryDetails(meta: ChangelogEntryMeta): string | undefined {
    if (meta.mergeRequests.length === 0) return;

    const lines: string[] = [];
    for (const mr of meta.mergeRequests) {
      let line = repo
        ? `- [!${mr.number} ${mr.title}](${joinPath(webUrl, repo, "-/merge_requests", String(mr.number))})`
        : `- #${mr.number} ${mr.title}`;
      if (mr.user) line += ` by @${mr.user.login}`;
      lines.push(line);
    }

    return [
      "<details>",
      "<summary>Merge request & contributors</summary>",
      "",
      ...lines,
      "",
      "</details>",
    ].join("\n");
  }

  return async (entry) => {
    const meta = await resolveEntryMeta(entry);
    let commitSuffix = "";

    if (meta.commit) {
      const short = meta.commit.slice(0, 7);
      const link = repo
        ? `[${short}](${joinPath(webUrl, repo, "-/commit", meta.commit)})`
        : `\`${short}\``;
      commitSuffix += ` (${link})`;
    }

    const lines: string[] = [];

    for (const section of entry.sections) {
      lines.push(`### ${section.title}${commitSuffix}`, "");
      if (section.content) lines.push(section.content, "");
    }

    const details = formatEntryDetails(meta);
    if (details) lines.push(details);

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
