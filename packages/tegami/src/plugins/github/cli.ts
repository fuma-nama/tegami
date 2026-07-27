import { readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { note, outro } from "@clack/prompts";
import { x } from "tinyexec";
import { changelogFilename } from "../../changelog/generate";
import { readChangelogEntries } from "../../changelog/parse";
import type { TegamiContext } from "../../context";
import type { TegamiCliRegistry } from "../../cli/core";
import { createDraft, type Draft } from "../../plans/draft";
import { isCI } from "../../utils/common";
import { execFailure } from "../../utils/error";
import {
  createIssueComment,
  findIssueCommentByPrefix,
  getPullRequest,
  listPullRequestsForCommit,
  updateIssueComment,
} from "./api";
import { formatPreview } from "../../utils/version-request";

const COMMENT_MARKER = "<!-- tegami -->";

interface PrPreviewOptions {
  number?: number;
}

interface PullRequestRef {
  headRepo: string;
  headRef: string;
  baseSha: string;
  headSha: string;
}

export function registerPrCli(cli: TegamiCliRegistry): void {
  cli
    .command("pr preview", {
      description: "show a pull request release preview and changelog guidance",
    })
    .option("artifact", {
      type: "string",
      description: "write preview markdown to a file",
    })
    .option("number", {
      type: "string",
      description: "pull request number",
    })
    .action(async ({ context, values }) => {
      const number = values.number ? parsePositiveInt(values.number, "--number") : undefined;
      const artifact = values.artifact;
      const draft = await createDraft(await readChangelogEntries(context), context);
      const body = await buildPrPreview(context, draft, { number });

      if (artifact) {
        const artifactPath = resolve(context.cwd, artifact);
        await writeFile(artifactPath, body);
        if (!isCI()) {
          note(relative(context.cwd, artifactPath) || artifact, "Release preview");
          outro("Release preview ready.");
        }
        return;
      }

      if (isCI()) {
        process.stdout.write(`${body}\n`);
        return;
      }

      note(body, "Release preview");
      outro("Release preview ready.");
    });

  cli
    .command("pr comment", {
      description: "post the pull request release preview as a comment",
    })
    .positional("artifact")
    .action(async ({ context, positionals }) => {
      const posted = await postPrComment(context, await readFile(positionals.artifact, "utf8"));
      if (posted) outro("Pull request comment updated.");
    });
}

export async function buildPrPreview(
  context: TegamiContext,
  draft: Draft,
  options: PrPreviewOptions = {},
): Promise<string> {
  const pullRequest = await resolvePullRequest(context, options);
  const changelogFiles = await listPullRequestChangelogFiles(
    context,
    pullRequest.baseSha,
    pullRequest.headSha,
  );

  return formatPreview(context, draft, changelogFiles, {
    "create-a-changelog-href": createChangelogUrl(
      context,
      pullRequest.headRepo,
      pullRequest.headRef,
      changelogFilename(),
    ),
    pr: "PR",
  });
}

export async function postPrComment(context: TegamiContext, body: string): Promise<boolean> {
  const { repo, token } = context.github ?? {};
  if (!repo) {
    outro("GitHub plugin context is required.");
    return false;
  }

  const pr = await readPullRequestFromWorkflowRunEvent(repo, token);
  if (!pr.found) {
    outro(pr.reason);
    return false;
  }

  const markedBody = `${COMMENT_MARKER}\n${body}`;
  const existingId = await findIssueCommentByPrefix(repo, pr.number, COMMENT_MARKER, token);

  if (existingId) {
    await updateIssueComment(repo, existingId, markedBody, token);
    return true;
  }

  await createIssueComment(repo, pr.number, markedBody, token);
  return true;
}

async function resolvePullRequest(
  context: TegamiContext,
  options: PrPreviewOptions,
): Promise<PullRequestRef> {
  const { repo, token } = context.github ?? {};
  if (!repo) {
    throw new Error("GitHub plugin context is required.");
  }

  if (options.number !== undefined) {
    const data = await getPullRequest(repo, options.number, token);

    return {
      headRepo: data.headRepository
        ? `${data.headRepository.owner.login}/${data.headRepository.name}`
        : repo,
      headRef: data.headRefName,
      baseSha: data.baseRefOid,
      headSha: data.headRefOid,
    };
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event = JSON.parse(await readFile(eventPath, "utf8")) as {
        pull_request?: {
          head: { ref: string; sha: string; repo: { full_name: string } };
          base: { sha: string };
        };
      };
      const pullRequest = event.pull_request;
      if (pullRequest) {
        return {
          headRepo: pullRequest.head.repo.full_name,
          headRef: pullRequest.head.ref,
          baseSha: pullRequest.base.sha,
          headSha: pullRequest.head.sha,
        };
      }
    } catch {
      // fall through
    }
  }

  throw new Error("A pull request event or --number is required.");
}

function parseWorkflowRunEvent(
  raw: unknown,
): { ok: true; number?: number; headSha?: string } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null || !("workflow_run" in raw)) {
    return { ok: false, reason: "A workflow_run event is required." };
  }

  const workflowRun = (raw as { workflow_run: unknown }).workflow_run;
  if (typeof workflowRun !== "object" || workflowRun === null) {
    return { ok: false, reason: "A workflow_run event is required." };
  }

  const event = (workflowRun as { event?: unknown }).event;
  if (event !== "pull_request") {
    return { ok: false, reason: "The preview workflow was not triggered by a pull request." };
  }

  const conclusion = (workflowRun as { conclusion?: unknown }).conclusion;
  if (conclusion !== "success") {
    return { ok: false, reason: "The preview workflow did not complete successfully." };
  }

  const pullRequests = (workflowRun as { pull_requests?: unknown }).pull_requests;
  const number = Array.isArray(pullRequests)
    ? (pullRequests[0] as { number?: unknown } | undefined)?.number
    : undefined;
  const headSha = (workflowRun as { head_sha?: unknown }).head_sha;

  return {
    ok: true,
    number: typeof number === "number" && Number.isInteger(number) ? number : undefined,
    headSha: typeof headSha === "string" && headSha.length > 0 ? headSha : undefined,
  };
}

async function readPullRequestFromWorkflowRunEvent(
  repo: string,
  token: string | undefined,
): Promise<
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

  const parsed = parseWorkflowRunEvent(raw);
  if (!parsed.ok) {
    return { found: false, reason: parsed.reason };
  }
  if (parsed.number !== undefined) {
    return { found: true, number: parsed.number };
  }

  // GitHub leaves `pull_requests` empty when the pull request comes from a fork,
  // look it up by the head commit of the preview workflow instead.
  if (!parsed.headSha) {
    return { found: false, reason: "The preview workflow is not associated with a pull request." };
  }

  // The commit can also match pull requests that merely contain it, prefer the one
  // it is the head of.
  const pullRequests = await listPullRequestsForCommit(repo, parsed.headSha, token);
  const pullRequest =
    pullRequests.find((pr) => pr.head?.sha === parsed.headSha) ??
    pullRequests.find((pr) => pr.state === "open") ??
    pullRequests[0];
  if (!pullRequest) {
    return {
      found: false,
      reason: `No pull request was found for commit ${parsed.headSha.slice(0, 7)}.`,
    };
  }

  return { found: true, number: pullRequest.number };
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
    if (trimmed.endsWith(".md")) files.add(basename(trimmed));
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

function parsePositiveInt(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return number;
}
