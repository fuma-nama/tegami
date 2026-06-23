import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { DraftPlan } from "../plans/draft";
import { changelogFilename } from "../utils/changelog";
import { execFailure } from "../utils/error";
import { formatRunScriptCommand } from "../utils/package-manager";
import { formatNpmDistTag } from "../utils/semver";

export const TEGAMI_DOCS_URL = "https://tegami.fuma-nama.dev";
export const CHANGELOG_DOCS_URL = `${TEGAMI_DOCS_URL}/changelog`;
const COMMENT_MARKER = "<!-- tegami -->";

export interface PrPreviewOptions {
  number?: number;
}

interface PullRequestRef {
  repo: string;
  headRepo: string;
  headRef: string;
  baseSha: string;
  headSha: string;
}

export async function buildPrPreview(
  context: TegamiContext,
  draft: DraftPlan,
  options: PrPreviewOptions = {},
): Promise<string> {
  const pullRequest = await resolvePullRequest(context, options);
  const tegamiCommand = await formatRunScriptCommand(
    context.cwd,
    "tegami",
    context.options.npm?.client,
  );
  const prChangelogFiles = await listPullRequestChangelogFiles(
    context,
    pullRequest.baseSha,
    pullRequest.headSha,
  );

  const createLink = createChangelogUrl(
    context,
    pullRequest.headRepo,
    pullRequest.headRef,
    changelogFilename(),
  );

  const lines = [
    "### Tegami",
    "",
    `This repository uses [Tegami](${TEGAMI_DOCS_URL}) to manage releases. When your changes affect published packages, add a changelog file under \`.tegami/\` before merging.`,
    "",
    `[**Create a changelog →**](${createLink}) · [Changelog format](${CHANGELOG_DOCS_URL})`,
    "",
  ];

  const pendingPackages: {
    name: string;
    type: string;
    from: string;
    to: string;
    distTag?: string;
    publish: boolean;
  }[] = [];

  for (const pkg of context.graph.getPackages()) {
    const plan = draft.getPackagePlan(pkg.id);
    if (!plan || plan.bumpVersion(pkg) === pkg.version) continue;

    pendingPackages.push({
      name: pkg.name,
      type: plan.type ?? "—",
      from: pkg.version,
      to: plan.bumpVersion(pkg),
      distTag: plan.npm?.distTag,
      publish: plan.publish ?? false,
    });
  }

  const prChangelogs = draft
    .getChangelogs()
    .filter((entry) => prChangelogFiles.has(entry.filename));

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
  } else if (prChangelogFiles.size === 0) {
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

export async function postPrComment(body: string): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error("GITHUB_REPOSITORY is required.");
  }

  const number = await readPullRequestNumberFromWorkflowRunEvent();
  const markedBody = `${COMMENT_MARKER}\n${body}`;
  const listResult = await x("gh", [
    "api",
    `repos/${repo}/issues/${number}/comments`,
    "--paginate",
    "--jq",
    `[.[] | select(.body | startswith("${COMMENT_MARKER}")) | .id][0] // empty`,
  ]);

  if (listResult.exitCode !== 0) {
    throw execFailure("Failed to list pull request comments.", listResult);
  }

  const existingId = listResult.stdout.trim();

  if (existingId) {
    const dir = await mkdtemp(join(tmpdir(), "tegami-pr-comment-"));
    const inputPath = join(dir, "body.json");

    try {
      await writeFile(inputPath, JSON.stringify({ body: markedBody }));
      const updateResult = await x("gh", [
        "api",
        "-X",
        "PATCH",
        `repos/${repo}/issues/comments/${existingId}`,
        "--input",
        inputPath,
      ]);

      if (updateResult.exitCode !== 0) {
        throw execFailure("Failed to update pull request comment.", updateResult);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    return;
  }

  const createResult = await x("gh", [
    "pr",
    "comment",
    String(number),
    "--body",
    markedBody,
    "--repo",
    repo,
  ]);

  if (createResult.exitCode !== 0) {
    throw execFailure("Failed to create pull request comment.", createResult);
  }
}

async function readPullRequestNumberFromWorkflowRunEvent(): Promise<number> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required.");
  }

  let event: {
    workflow_run?: {
      event: string;
      conclusion: string;
      pull_requests?: { number: number }[];
    };
  };

  try {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  } catch {
    throw new Error("Failed to read workflow_run event.");
  }

  const workflowRun = event.workflow_run;
  if (!workflowRun) {
    throw new Error("A workflow_run event is required.");
  }

  if (workflowRun.event !== "pull_request") {
    throw new Error("The preview workflow was not triggered by a pull request.");
  }

  if (workflowRun.conclusion !== "success") {
    throw new Error("The preview workflow did not complete successfully.");
  }

  const number = workflowRun.pull_requests?.[0]?.number;
  if (!Number.isInteger(number) || !number || number <= 0) {
    throw new Error("The preview workflow is not associated with a pull request.");
  }

  return number;
}

async function resolvePullRequest(
  context: TegamiContext,
  options: PrPreviewOptions,
): Promise<PullRequestRef> {
  const repo = context.github?.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error("GITHUB_REPOSITORY is required.");
  }

  if (options.number !== undefined) {
    if (!Number.isInteger(options.number) || options.number <= 0) {
      throw new Error("--number must be a positive integer.");
    }
    return readPullRequestFromGh(repo, options.number);
  }

  const event = await readPullRequestEvent();
  if (event) {
    return { repo, ...event };
  }

  throw new Error("A pull request event or --number is required.");
}

async function readPullRequestFromGh(repo: string, number: number): Promise<PullRequestRef> {
  const result = await x("gh", [
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "headRefName,baseRefOid,headRefOid,headRepository",
  ]);

  if (result.exitCode !== 0) {
    throw execFailure(`Failed to resolve pull request #${number}.`, result);
  }

  const data = JSON.parse(result.stdout) as {
    headRefName: string;
    baseRefOid: string;
    headRefOid: string;
    headRepository?: {
      name: string;
      owner: { login: string };
    } | null;
  };

  return {
    repo,
    headRepo: data.headRepository
      ? `${data.headRepository.owner.login}/${data.headRepository.name}`
      : repo,
    headRef: data.headRefName,
    baseSha: data.baseRefOid,
    headSha: data.headRefOid,
  };
}

async function readPullRequestEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return;

  let event: {
    pull_request?: {
      head: {
        ref: string;
        sha: string;
        repo: { full_name: string };
      };
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
    headRepo: pullRequest.head.repo.full_name,
    headRef: pullRequest.head.ref,
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
  };
}

async function listPullRequestChangelogFiles(
  context: TegamiContext,
  baseSha: string,
  headSha: string,
): Promise<Set<string>> {
  const dir = relative(context.cwd, context.changelogDir);
  const result = await x(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMRD", `${baseSha}...${headSha}`, "--", `${dir}/`],
    {
      nodeOptions: { cwd: context.cwd },
    },
  );

  if (result.exitCode !== 0) {
    throw execFailure("Failed to list pull request changelog files.", result);
  }

  const files = new Set<string>();

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.endsWith(".md")) {
      files.add(basename(trimmed));
    }
  }

  return files;
}

function createChangelogUrl(
  context: TegamiContext,
  repo: string,
  branch: string,
  filename: string,
): string {
  const filePath = join(relative(context.cwd, context.changelogDir), filename).replaceAll(
    "\\",
    "/",
  );
  const branchPath = branch.split("/").map(encodeURIComponent).join("/");
  const params = new URLSearchParams({ filename: filePath });

  return `https://github.com/${repo}/new/${branchPath}?${params}`;
}
