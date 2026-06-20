import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { DraftPlan } from "../plans/draft";
import { changelogFilename } from "../utils/changelog";
import { execFailure } from "../utils/error";
import { formatRunScriptCommand } from "../utils/package-manager";
import { formatNpmDistTag } from "../utils/semver";

export const CI_PR_MARKER = "<!-- tegami-pr -->";
export const TEGAMI_DOCS_URL = "https://tegami.fuma-nama.dev";
export const CHANGELOG_DOCS_URL = `${TEGAMI_DOCS_URL}/changelog`;

export interface PullRequestEvent {
  number: number;
  headRef: string;
  baseSha: string;
  headSha: string;
}

export interface RenderCiPrCommentOptions {
  repo?: string;
  branch?: string;
  prChangelogFiles?: string[];
  tegamiCommand?: string;
}

export interface CiPrOptions {
  repo?: string;
  pr?: number;
  branch?: string;
  print?: boolean;
}

export interface CiPrResult {
  body: string;
  posted: boolean;
  action?: "created" | "updated";
}

export async function runCiPr(
  context: TegamiContext,
  draft: DraftPlan,
  options: CiPrOptions = {},
): Promise<CiPrResult> {
  const event = await resolvePullRequestEvent();
  const repo = options.repo ?? context.github?.repo ?? process.env.GITHUB_REPOSITORY;
  const pr = options.pr ?? event?.number;
  const branch = options.branch ?? event?.headRef;
  const prChangelogFiles =
    event && !options.branch
      ? await getPullRequestChangelogFiles(context, event.baseSha, event.headSha)
      : [];
  const tegamiCommand = await formatRunScriptCommand(
    context.cwd,
    "tegami",
    context.options.npm?.client,
  );

  const body = renderCiPrComment(context, draft, {
    repo,
    branch,
    prChangelogFiles,
    tegamiCommand,
  });

  if (options.print || !repo || !pr) {
    return { body, posted: false };
  }

  const action = await upsertPullRequestComment(repo, pr, body);
  return { body, posted: true, action };
}

export function renderCiPrComment(
  context: TegamiContext,
  draft: DraftPlan,
  options: RenderCiPrCommentOptions = {},
): string {
  const changelogDir = relative(context.cwd, context.changelogDir) || ".tegami";
  const tegamiCommand = options.tegamiCommand ?? "npm run tegami";
  const createLink =
    options.repo && options.branch
      ? createChangelogUrl(options.repo, options.branch, changelogDir, changelogFilename())
      : undefined;

  const lines = [
    "### Tegami",
    "",
    `This repository uses [Tegami](${TEGAMI_DOCS_URL}) to manage releases. When your changes affect published packages, add a changelog file under \`.tegami/\` before merging.`,
    "",
  ];

  if (createLink) {
    lines.push(
      `[**Create a changelog →**](${createLink}) · [Changelog format](${CHANGELOG_DOCS_URL})`,
      "",
    );
  } else {
    lines.push(
      `Run \`${tegamiCommand}\` locally or see the [changelog format](${CHANGELOG_DOCS_URL}).`,
      "",
    );
  }

  const pendingPackages = getPendingPackages(context, draft);
  const prChangelogs = filterChangelogsInPullRequest(draft, options.prChangelogFiles);

  if (pendingPackages.length > 0) {
    lines.push("#### Release preview", "", "| Package | Bump | Version |", "| --- | --- | --- |");

    for (const { name, type, from, to, distTag, publish } of pendingPackages) {
      const publishNote = publish ? "" : " (no publish)";
      lines.push(
        `| \`${name}\` | ${type} | \`${from}\` → \`${to}\`${formatNpmDistTag(distTag)}${publishNote} |`,
      );
    }

    lines.push("");
  }

  if (prChangelogs.length > 0) {
    lines.push("#### Changelogs in this PR", "");

    for (const entry of prChangelogs) {
      const title = entry.sections[0]?.title ?? entry.filename;
      lines.push(`- \`${entry.filename}\` — ${title}`);
    }

    lines.push("");
  } else if (pendingPackages.length === 0) {
    lines.push(
      "#### No changelogs yet",
      "",
      "This PR has no pending changelog files. If your changes require a release, add a changelog before merging.",
      "",
    );
  } else if (options.prChangelogFiles?.length === 0) {
    lines.push(
      "This PR does not add changelog files. Pending changelogs from other branches are included in the preview above.",
      "",
    );
  }

  lines.push(
    `Run \`${tegamiCommand}\` locally to create a changelog interactively.`,
    "",
    `<sub>Managed by [Tegami](${TEGAMI_DOCS_URL}).</sub>`,
    "",
  );

  return lines.join("\n");
}

export async function resolvePullRequestEvent(): Promise<PullRequestEvent | undefined> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return;

  let event: {
    pull_request?: {
      number: number;
      head: { ref: string; sha: string };
      base: { sha: string };
    };
  };

  try {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  } catch {
    return;
  }

  const pullRequest = event.pull_request;
  if (!pullRequest) return;

  return {
    number: pullRequest.number,
    headRef: pullRequest.head.ref,
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
  };
}

export async function getPullRequestChangelogFiles(
  context: TegamiContext,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const dir = relative(context.cwd, context.changelogDir);
  const result = await x(
    "git",
    ["diff", "--name-only", "--diff-filter=AM", `${baseSha}...${headSha}`, "--", `${dir}/`],
    {
      nodeOptions: { cwd: context.cwd },
    },
  );

  if (result.exitCode !== 0) return [];

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".md"))
    .map((line) => basename(line));
}

export async function upsertPullRequestComment(
  repo: string,
  pr: number,
  body: string,
): Promise<"created" | "updated"> {
  const marked = `${CI_PR_MARKER}\n${body.trim()}\n`;

  const listResult = await x("gh", ["api", `repos/${repo}/issues/${pr}/comments`, "--paginate"]);
  if (listResult.exitCode !== 0) {
    throw execFailure("Failed to list pull request comments.", listResult);
  }

  const comments = JSON.parse(listResult.stdout) as Array<{ id: number; body?: string }>;
  const existing = comments.find((comment) => comment.body?.includes(CI_PR_MARKER));

  if (existing) {
    const patchResult = await x("gh", [
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/issues/comments/${existing.id}`,
      "-f",
      `body=${marked}`,
    ]);

    if (patchResult.exitCode !== 0) {
      throw execFailure("Failed to update pull request comment.", patchResult);
    }

    return "updated";
  }

  const createResult = await x("gh", [
    "pr",
    "comment",
    String(pr),
    "--repo",
    repo,
    "--body",
    marked,
  ]);
  if (createResult.exitCode !== 0) {
    throw execFailure("Failed to create pull request comment.", createResult);
  }

  return "created";
}

function getPendingPackages(context: TegamiContext, draft: DraftPlan) {
  const packages: {
    name: string;
    type: string;
    from: string;
    to: string;
    distTag?: string;
    publish: boolean;
  }[] = [];

  for (const pkg of context.graph.getPackages()) {
    const plan = draft.getPackagePlan(pkg.id);
    if (!plan?.type) continue;

    packages.push({
      name: pkg.name,
      type: plan.type,
      from: pkg.version,
      to: plan.bumpVersion(pkg),
      distTag: plan.npm?.distTag,
      publish: plan.publish ?? false,
    });
  }

  return packages;
}

function filterChangelogsInPullRequest(draft: DraftPlan, filenames?: string[]) {
  if (!filenames) return draft.getChangelogs();

  const names = new Set(filenames);
  return draft.getChangelogs().filter((entry) => names.has(entry.filename));
}

function createChangelogUrl(
  repo: string,
  branch: string,
  changelogDir: string,
  filename: string,
): string {
  const segments = [...changelogDir.split("/").filter(Boolean), filename].map((part) =>
    encodeURIComponent(part),
  );

  return `https://github.com/${repo}/new/${branch.split("/").map(encodeURIComponent).join("/")}/${segments.join("/")}`;
}
