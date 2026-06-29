import { readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { note, outro } from "@clack/prompts";
import { resolveCommand } from "package-manager-detector";
import { x } from "tinyexec";
import { changelogFilename } from "../../changelog/generate";
import { readChangelogEntries } from "../../changelog/parse";
import type { TegamiCliRegistry } from "../../cli/core";
import type { TegamiContext } from "../../context";
import { createDraft, type Draft } from "../../plans/draft";
import { isCI } from "../../utils/common";
import { execFailure } from "../../utils/error";
import { formatNpmDistTag } from "../../utils/semver";
import {
  createMergeRequestComment,
  findMergeRequestCommentByPrefix,
  getMergeRequest,
  gitlabWebUrl,
  updateMergeRequestComment,
} from "./api";

const COMMENT_MARKER = "<!-- tegami -->";

interface MrPreviewOptions {
  number?: number;
}

interface MergeRequestRef {
  headRepo: string;
  headRef: string;
  baseSha: string;
  headSha: string;
}

export function registerMrCli(cli: TegamiCliRegistry): void {
  cli.command("mr", { description: "GitLab merge request commands" });

  cli
    .command("mr preview", {
      description: "show a merge request release preview and changelog guidance",
    })
    .option("artifact", {
      type: "string",
      description: "write preview markdown to a file",
    })
    .option("number", {
      type: "string",
      description: "merge request iid",
    })
    .action(async ({ context, values }) => {
      const number = values.number ? parsePositiveInt(values.number, "--number") : undefined;
      const artifact = values.artifact;
      const draft = await createDraft(await readChangelogEntries(context), context);
      const body = await buildMrPreview(context, draft, { number });

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
    .command("mr comment", {
      description: "post the merge request release preview as a comment",
    })
    .positional("artifact")
    .option("number", {
      type: "string",
      description: "merge request iid",
    })
    .action(async ({ context, values, positionals }) => {
      await postMrComment(context, await readFile(positionals.artifact, "utf8"), {
        number: values.number ? parsePositiveInt(values.number, "--number") : undefined,
      });
      outro("Merge request comment updated.");
    });
}

export async function buildMrPreview(
  context: TegamiContext,
  draft: Draft,
  options: MrPreviewOptions = {},
): Promise<string> {
  const mergeRequest = await resolveMergeRequest(context, options);
  const tegamiCommandRaw = resolveCommand(context.npm?.client ?? "npm", "run", ["tegami"])!;
  const tegamiCommand = [tegamiCommandRaw.command, ...tegamiCommandRaw.args].join(" ");
  const changelogFiles = await listMergeRequestChangelogFiles(
    context,
    mergeRequest.baseSha,
    mergeRequest.headSha,
  );
  const createLink = createChangelogUrl(
    context,
    mergeRequest.headRepo,
    mergeRequest.headRef,
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
      lines.push(
        `| \`${name}\` | ${type} | \`${from}\` → \`${to}\`${formatNpmDistTag(distTag)} |`,
      );
    }

    lines.push("");
  }

  if (requestChangelogs.length > 0) {
    lines.push("#### Changelogs in this MR", "", "| Changelog | Title |", "| --- | --- |");

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
      "This MR has no pending changelog files. If your changes require a release, add a changelog before merging.",
      "",
    );
  } else if (changelogFiles.size === 0) {
    lines.push(
      "This MR does not add changelog files. Pending changelogs from other branches are included in the preview above.",
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

export async function postMrComment(
  context: TegamiContext,
  body: string,
  options: MrPreviewOptions = {},
): Promise<void> {
  const { repo } = context.gitlab ?? {};
  if (!repo) {
    outro("GITLAB_REPOSITORY or CI_PROJECT_PATH is required.");
    return;
  }

  const number =
    options.number ??
    (process.env.CI_MERGE_REQUEST_IID
      ? parsePositiveInt(process.env.CI_MERGE_REQUEST_IID, "CI_MERGE_REQUEST_IID")
      : undefined);
  if (!number) {
    outro("CI_MERGE_REQUEST_IID or --number is required.");
    return;
  }

  const api = {
    apiUrl: context.gitlab?.apiUrl,
    token: context.gitlab?.token,
  };
  const markedBody = `${COMMENT_MARKER}\n${body}`;
  const existingId = await findMergeRequestCommentByPrefix(repo, number, COMMENT_MARKER, api);

  if (existingId) {
    await updateMergeRequestComment(repo, number, existingId, markedBody, api);
    return;
  }

  await createMergeRequestComment(repo, number, markedBody, api);
}

async function resolveMergeRequest(
  context: TegamiContext,
  options: MrPreviewOptions,
): Promise<MergeRequestRef> {
  const { repo } = context.gitlab ?? {};
  if (!repo) {
    throw new Error("GITLAB_REPOSITORY or CI_PROJECT_PATH is required.");
  }
  const api = {
    apiUrl: context.gitlab?.apiUrl,
    token: context.gitlab?.token,
  };

  if (options.number !== undefined) {
    const data = await getMergeRequest(repo, options.number, api);
    if (!data.baseSha || !data.headSha) {
      throw new Error(`Merge request !${options.number} does not include diff refs.`);
    }

    return {
      headRepo: data.sourceProjectPath ?? repo,
      headRef: data.sourceBranch,
      baseSha: data.baseSha,
      headSha: data.headSha,
    };
  }

  const headRef = process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
  const baseSha = process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
  const headSha = process.env.CI_COMMIT_SHA;
  if (headRef && baseSha && headSha) {
    return {
      headRepo: process.env.CI_MERGE_REQUEST_SOURCE_PROJECT_PATH ?? repo,
      headRef,
      baseSha,
      headSha,
    };
  }

  throw new Error("A merge request event or --number is required.");
}

async function listMergeRequestChangelogFiles(
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
    throw execFailure("Failed to list merge request changelog files.", result);
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
  const params = new URLSearchParams({ file_name: filePath });

  return `${gitlabWebUrl(context.gitlab?.webUrl)}/${repo}/-/new/${branchPath}?${params}`;
}

function parsePositiveInt(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return number;
}
