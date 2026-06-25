import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { Draft } from "../plans/draft";
import { execFailure } from "../utils/error";
import { formatNpmDistTag } from "../utils/semver";
import { resolveCommand } from "package-manager-detector";
import { changelogFilename } from "../changelog/generate";
import { outro } from "@clack/prompts";
import z from "zod";

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
  draft: Draft,
  options: PrPreviewOptions = {},
): Promise<string> {
  const pullRequest = await resolvePullRequest(context, options);
  const tegamiCommandRaw = resolveCommand(context.npm?.client ?? "npm", "run", ["tegami"])!;
  const tegamiCommand = [tegamiCommandRaw.command, ...tegamiCommandRaw.args].join(" ");
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
  }[] = [];

  for (const pkg of context.graph.getPackages()) {
    const plan = draft.getPackageDraft(pkg.id);
    if (!plan || plan.bumpVersion(pkg) === pkg.version) continue;

    pendingPackages.push({
      name: pkg.name,
      type: plan.type ?? "—",
      from: pkg.version,
      to: plan.bumpVersion(pkg),
      distTag: plan.npm?.distTag,
    });
  }

  const prChangelogs = draft
    .getChangelogs()
    .filter((entry) => prChangelogFiles.has(entry.filename));

  if (pendingPackages.length > 0) {
    lines.push("#### Release preview", "", "| Package | Bump | Version |", "| --- | --- | --- |");

    for (const { name, type, from, to, distTag } of pendingPackages) {
      lines.push(`| \`${name}\` | ${type} | \`${from}\` → \`${to}\`${formatNpmDistTag(distTag)} |`);
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
    outro("GITHUB_REPOSITORY is required.");
    return;
  }

  const pr = await readPullRequestFromWorkflowRunEvent();
  if (!pr.found) {
    outro(pr.reason);
    return;
  }

  const markedBody = `${COMMENT_MARKER}\n${body}`;
  const listResult = await x("gh", [
    "api",
    `repos/${repo}/issues/${pr.number}/comments`,
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
    String(pr.number),
    "--body",
    markedBody,
    "--repo",
    repo,
  ]);

  if (createResult.exitCode !== 0) {
    throw execFailure("Failed to create pull request comment.", createResult);
  }
}

const eventSchema = z.looseObject({
  workflow_run: z.looseObject(
    {
      event: z.literal("pull_request", {
        error: "The preview workflow was not triggered by a pull request.",
      }),
      conclusion: z.literal("success", {
        error: "The preview workflow did not complete successfully.",
      }),
      pull_requests: z
        .array(z.looseObject({ number: z.int() }), {
          error: "The preview workflow is not associated with a pull request.",
        })
        .min(1),
    },
    {
      error: "A workflow_run event is required.",
    },
  ),
});

async function readPullRequestFromWorkflowRunEvent(): Promise<
  | {
      found: true;
      number: number;
    }
  | {
      found: false;
      reason: string;
    }
> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return { found: false, reason: "GITHUB_EVENT_PATH is required." };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(eventPath, "utf8"));
  } catch {
    return { found: false, reason: "Failed to read workflow_run event." };
  }

  const { error, data } = eventSchema.safeParse(raw);
  if (error) {
    return { found: false, reason: z.prettifyError(error) };
  }

  return { found: true, number: data.workflow_run.pull_requests[0]!.number };
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
