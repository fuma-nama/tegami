import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { BumpType } from "../utils/semver";

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

export async function createChangelog(
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

  const directory = context.changelogDir;
  await mkdir(directory, { recursive: true });

  const created: CreatedChangelog[] = [];
  const stamp = Date.now().toString(36);
  for (const [key, changes] of groups) {
    const packages = key ? key.split("\0") : [];
    const filename = `changes-${stamp}-${slugify(packages.join("-") || "workspace")}.md`;
    const path = join(directory, filename);
    await writeFile(path, renderChangelog(packages, changes));
    created.push({
      filename,
      path,
      packages,
      changes: changes.length,
    });
  }

  return created;
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
    throw new Error(`Unable to read git commits: ${commandOutput(result).trim()}`);
  }

  const changes: CommitChange[] = [];
  for (const record of result.stdout.split("\x1e")) {
    const [hash, subject, body = ""] = record.replace(/^\n+|\n+$/g, "").split("\x1f");
    if (!hash || !subject) continue;

    const change = parseConventionalCommit(context, hash, subject, body);
    if (change) changes.push(change);
  }

  return changes;
}

async function latestTag(cwd: string): Promise<string | undefined> {
  const result = await x("git", ["describe", "--tags", "--abbrev=0"], {
    nodeOptions: {
      cwd,
    },
  });

  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function parseConventionalCommit(
  context: TegamiContext,
  hash: string,
  subject: string,
  body: string,
): CommitChange | undefined {
  const match = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<title>.+)$/.exec(
    subject,
  );
  if (!match?.groups) return undefined;

  const type = match.groups.type!.toLowerCase();
  const breaking = Boolean(match.groups.breaking) || /^BREAKING(?:-| )CHANGE:/m.test(body);
  const bump = commitTypeToBump(type, breaking);
  if (!bump) return undefined;

  return {
    hash,
    subject,
    body: body.trim(),
    packages: resolvePackages(context, match.groups.scope),
    type: bump,
    title: titleCase(match.groups.title!),
  };
}

function commitTypeToBump(type: string, breaking: boolean): BumpType | undefined {
  if (breaking) return "major";
  if (type === "feat") return "minor";
  if (type === "fix" || type === "perf") return "patch";
  return undefined;
}

function resolvePackages(context: TegamiContext, scope: string | undefined): string[] {
  if (!scope) return [];

  const packages = new Set<string>();
  for (const item of scope.split(",")) {
    const name = item.trim();
    if (!name) continue;

    const direct = context.graph.getByName(name);
    if (direct.length > 0) {
      packages.add(name);
      continue;
    }

    const byShortName = context.graph
      .getPackages()
      .filter((pkg) => pkg.name.split("/").at(-1) === name);
    if (byShortName.length > 0) {
      for (const pkg of byShortName) packages.add(pkg.name);
      continue;
    }

    packages.add(name);
  }

  return Array.from(packages).sort();
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function commandOutput(result: Awaited<ReturnType<typeof x>>): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}
