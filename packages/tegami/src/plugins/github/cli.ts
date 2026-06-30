import { readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { note, outro } from "@clack/prompts";
import { resolveCommand } from "package-manager-detector";
import { x } from "tinyexec";
import z from "zod";
import { changelogFilename } from "../../changelog/generate";
import { readChangelogEntries } from "../../changelog/parse";
import type { TegamiContext } from "../../context";
import type { TegamiCliRegistry } from "../../cli/core";
import { createDraft, type Draft } from "../../plans/draft";
import { isCI } from "../../utils/common";
import { execFailure } from "../../utils/error";
import { formatNpmDistTag } from "../../utils/semver";
import {
  createIssueComment,
  findIssueCommentByPrefix,
  getPullRequest,
  updateIssueComment,
} from "./api";

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
      await postPrComment(context, await readFile(positionals.artifact, "utf8"));
      outro("Pull request comment updated.");
    });
}

export async function buildPrPreview(
  context: TegamiContext,
  draft: Draft,
  options: PrPreviewOptions = {},
): Promise<string> {
  const pullRequest = await resolvePullRequest(context, options);
  const tegamiCommandRaw = resolveCommand(context.npm?.client ?? "npm", "run", ["tegami"])!;
  const tegamiCommand = [tegamiCommandRaw.command, ...tegamiCommandRaw.args].join(" ");
  const changelogFiles = await listPullRequestChangelogFiles(
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
  const pendingPackages: {
    name: string;
    type: string;
    from: string;
    to: string;
    distTag?: string;
  }[] = [];
  const lines = [
    "### Tegami",
    "",
    `This repository uses [Tegami](https://tegami.fuma-nama.dev) to manage releases. When your changes affect published packages, add a changelog file under \`.tegami/\` before merging.`,
    "",
    `[**Create a changelog →**](${createLink}) · [Changelog format](https://tegami.fuma-nama.dev/changelog)`,
    "",
  ];

  for (const pkg of context.graph.getPackages()) {
    const plan = draft.getPackageDraft(pkg.id);
    if (!plan) continue;
    const bumped = plan.bumpVersion(pkg);
    if (!bumped || !pkg.version || bumped === pkg.version) continue;

    pendingPackages.push({
      name: pkg.name,
      type: plan.type ?? "—",
      from: pkg.version,
      to: bumped,
      distTag: plan.npm?.distTag,
    });
  }

  const requestChangelogs = draft
    .getChangelogs()
    .filter((entry) => changelogFiles.has(entry.filename));

  if (pendingPackages.length > 0) {
    lines.push("#### Release preview", "", "| Package | Bump | Version |", "| --- | --- | --- |");

    for (const { name, type, from, to, distTag } of pendingPackages) {
      lines.push(`| \`${name}\` | ${type} | \`${from}\` → \`${to}\`${formatNpmDistTag(distTag)} |`);
    }

    lines.push("");
  }

  if (requestChangelogs.length > 0) {
    lines.push("#### Changelogs in this PR", "", "| Changelog | Title |", "| --- | --- |");

    for (const entry of requestChangelogs) {
      for (const section of entry.sections) {
        lines.push(`| \`${entry.filename}\` | ${section.title} |`);
      }
    }

    lines.push("");
  } else if (pendingPackages.length === 0) {
    lines.push(
      "#### No changelogs yet",
      "",
      "This PR has no pending changelog files. If your changes require a release, add a changelog before merging.",
      "",
    );
  } else if (changelogFiles.size === 0) {
    lines.push(
      "This PR does not add changelog files. Pending changelogs from other branches are included in the preview above.",
      "",
    );
  }

  lines.push(
    `Run \`${tegamiCommand}\` locally to create a changelog interactively.`,
    "",
    `<sub>Managed by [Tegami](https://tegami.fuma-nama.dev).</sub>`,
    "",
  );

  return lines.join("\n");
}

export async function postPrComment(context: TegamiContext, body: string): Promise<void> {
  const { repo, token } = context.github ?? {};
  if (!repo) {
    outro("GitHub plugin context is required.");
    return;
  }

  const pr = await readPullRequestFromWorkflowRunEvent();
  if (!pr.found) {
    outro(pr.reason);
    return;
  }

  const markedBody = `${COMMENT_MARKER}\n${body}`;
  const existingId = await findIssueCommentByPrefix(repo, pr.number, COMMENT_MARKER, token);

  if (existingId) {
    await updateIssueComment(repo, existingId, markedBody, token);
    return;
  }

  await createIssueComment(repo, pr.number, markedBody, token);
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
    parsePositiveInt(String(options.number), "--number");
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

const workflowRunEventSchema = z.object({
  workflow_run: z.object(
    {
      event: z.literal("pull_request", {
        error: "The preview workflow was not triggered by a pull request.",
      }),
      conclusion: z.literal("success", {
        error: "The preview workflow did not complete successfully.",
      }),
      pull_requests: z
        .array(z.object({ number: z.int() }), {
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

  const { error, data } = workflowRunEventSchema.safeParse(raw);
  if (error) {
    return { found: false, reason: z.prettifyError(error) };
  }

  return { found: true, number: data.workflow_run.pull_requests[0]!.number };
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
