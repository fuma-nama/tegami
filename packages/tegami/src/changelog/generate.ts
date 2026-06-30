import { randomBytes } from "node:crypto";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import { bumpDepth, maxBump, type BumpType } from "../utils/semver";
import {
  conventionalCommitToBump,
  createConventionalCommitParser,
} from "../utils/conventional-commit";
import { execFailure } from "../utils/error";
import { type ChangelogPackageConfig, renderChangelog } from "./shared";

let changelogFilenameCounter = 0;

export interface GenerateFromCommitsOptions {
  /** Start revision. Defaults to the latest reachable git tag, or all history if none exists. */
  from?: string;
  /** End revision. Defaults to HEAD. */
  to?: string;
}

export interface CommitChangelog {
  filename: string;
  content: string;
  packages: Record<string, BumpType | ChangelogPackageConfig>;
  changes: CommitChange[];
}

interface CommitChange {
  hash: string;
  subject: string;
  body: string;
  packages: string[];
  type: BumpType;
  title: string;
}

export async function generateFromCommits(
  context: TegamiContext,
  { from, to }: GenerateFromCommitsOptions = {},
): Promise<CommitChangelog[]> {
  const commits = await readConventionalCommits(context, from, to);
  const groups = new Map<string, CommitChange[]>();

  for (const commit of commits) {
    const key = commit.packages.join("\0");
    const group = groups.get(key);
    if (group) group.push(commit);
    else groups.set(key, [commit]);
  }

  const changelogs = Array.from(groups, ([key, changes], index): CommitChangelog => {
    const packageNames = key ? key.split("\0") : [];
    let bumpType: BumpType = "patch";
    for (const change of changes) {
      bumpType = maxBump(change.type, bumpType);
    }

    const packageBumpMap = Object.fromEntries(packageNames.map((name) => [name, bumpType]));
    const content = renderChangelog(
      { packages: packageBumpMap },
      changes
        .map((change) => {
          const heading = "#".repeat(bumpDepth(change.type));
          if (!change.body) return `${heading} ${change.title}`;
          return `${heading} ${change.title}\n\n${change.body}`;
        })
        .join("\n\n"),
    );

    return {
      filename: changelogFilename(index),
      content,
      packages: packageBumpMap,
      changes,
    };
  });

  return changelogs;
}

async function readConventionalCommits(
  context: TegamiContext,
  from?: string,
  to?: string,
): Promise<CommitChange[]> {
  from ??= await latestTag(context.cwd);
  to ??= "HEAD";
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
      title: parsed.title.charAt(0).toUpperCase() + parsed.title.slice(1),
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

export function changelogFilename(disambiguator = 0): string {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const counter = changelogFilenameCounter++;
  const hash = `${(Date.now() + disambiguator).toString(36)}-${counter.toString(36)}-${randomBytes(4).toString("hex")}`;

  return `${yyyy}-${mm}-${dd}-${hash}.md`;
}
