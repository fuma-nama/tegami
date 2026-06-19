import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { BumpType } from "../utils/semver";
import { changelogFilename } from "../utils/changelog";
import {
  conventionalCommitToBump,
  createConventionalCommitParser,
} from "../utils/conventional-commit";
import { execFailure } from "../utils/error";

export interface CreateChangelogOptions {
  /** Start revision. Defaults to the latest reachable git tag, or all history if none exists. */
  from?: string;
  /** End revision. Defaults to HEAD. */
  to?: string;
}

export interface CreatedChangelog {
  filename: string;
  path: string;
  packages: string[];
  changes: number;
}

interface CommitChange {
  hash: string;
  subject: string;
  body: string;
  packages: string[];
  type: BumpType;
  title: string;
}

export async function generateChangelog(
  context: TegamiContext,
  options: CreateChangelogOptions = {},
): Promise<CreatedChangelog[]> {
  const commits = await readConventionalCommits(context, options);
  const groups = new Map<string, CommitChange[]>();

  for (const commit of commits) {
    const key = commit.packages.join("\0");
    const group = groups.get(key);
    if (group) group.push(commit);
    else groups.set(key, [commit]);
  }

  await mkdir(context.changelogDir, { recursive: true });

  return Promise.all(
    Array.from(groups, async ([key, changes], index) => {
      const packages = key ? key.split("\0") : [];
      const filename = changelogFilename(index);
      const path = join(context.changelogDir, filename);
      await writeFile(path, renderChangelog(packages, changes));
      return {
        filename,
        path,
        packages,
        changes: changes.length,
      };
    }),
  );
}

async function readConventionalCommits(
  context: TegamiContext,
  options: CreateChangelogOptions,
): Promise<CommitChange[]> {
  const to = options.to ?? "HEAD";
  const from = options.from ?? (await latestTag(context.cwd));
  const args = ["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e"];

  if (from) args.push(`${from}..${to}`);
  else if (to !== "HEAD") args.push(to);

  const result = await x("git", args, {
    nodeOptions: {
      cwd: context.cwd,
    },
  });

  if (result.exitCode !== 0) {
    throw execFailure(`Unable to read git commits from ${from ?? "start"} to ${to}`, result);
  }

  const parseCommit = createConventionalCommitParser(context.graph);
  const changes: CommitChange[] = [];

  for (const record of result.stdout.split("\x1e")) {
    const [hash, subject, body = ""] = record.replace(/^\n+|\n+$/g, "").split("\x1f");
    if (!hash || !subject) continue;

    const parsed = parseCommit(subject, body);
    if (!parsed) continue;

    const bump = conventionalCommitToBump(parsed.type, parsed.breaking);
    if (!bump) continue;

    changes.push({
      hash,
      subject,
      body: body.trim(),
      packages: parsed.packages,
      type: bump,
      title: titleCase(parsed.title),
    });
  }

  return changes;
}

async function latestTag(cwd: string): Promise<string | undefined> {
  const result = await x("git", ["describe", "--tags", "--abbrev=0"], {
    nodeOptions: {
      cwd,
    },
  });

  if (result.exitCode !== 0) return;
  return result.stdout.trim() || undefined;
}

function renderChangelog(packages: string[], changes: CommitChange[]): string {
  return [
    "---",
    `packages: ${JSON.stringify(packages)}`,
    "---",
    "",
    changes.map(renderChange).join("\n\n"),
    "",
  ].join("\n");
}

function renderChange(change: CommitChange): string {
  const heading = "#".repeat(change.type === "major" ? 1 : change.type === "minor" ? 2 : 3);
  if (!change.body) return `${heading} ${change.title}`;

  return `${heading} ${change.title}\n\n${change.body}`;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
