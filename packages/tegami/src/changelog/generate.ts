import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import { bumpDepth, maxBump, type BumpType } from "../utils/semver";
import { changelogFilename } from "../utils/changelog";
import {
  conventionalCommitToBump,
  createConventionalCommitParser,
} from "../utils/conventional-commit";
import { execFailure } from "../utils/error";
import { type ChangelogPackageConfig, renderChangelog } from "./shared";
import type { PackageGraph } from "../graph";
import * as semver from "semver";

export interface CreateChangelogOptions {
  /** Start revision. Defaults to the latest reachable git tag, or all history if none exists. */
  from?: string;
  /** End revision. Defaults to HEAD. */
  to?: string;
  /**
   * Write changelog files to disk.
   *
   * @default true
   */
  write?: boolean;
}

export interface CreatedChangelog {
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

export async function generateChangelog(
  context: TegamiContext,
  options: CreateChangelogOptions = {},
): Promise<CreatedChangelog[]> {
  const write = options.write ?? true;
  const commits = await readConventionalCommits(context, options);
  const groups = new Map<string, CommitChange[]>();

  for (const commit of commits) {
    const key = commit.packages.join("\0");
    const group = groups.get(key);
    if (group) group.push(commit);
    else groups.set(key, [commit]);
  }

  const changelogs = Array.from(groups, ([key, changes], index): CreatedChangelog => {
    const packageNames = key ? key.split("\0") : [];
    let bumpType: BumpType = "patch";
    for (const change of changes) {
      bumpType = maxBump(change.type, bumpType);
    }

    const packageBumpMap = Object.fromEntries(packageNames.map((name) => [name, bumpType]));
    const packages = generateReplays(context.graph, packageBumpMap);
    const content = renderChangelog(
      { packages },
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
      packages,
      changes,
    };
  });

  if (write && changelogs.length > 0) {
    await mkdir(context.changelogDir, { recursive: true });
    await Promise.all(
      changelogs.map((entry) =>
        writeFile(join(context.changelogDir, entry.filename), entry.content),
      ),
    );
  }

  return changelogs;
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

export function generateReplays(graph: PackageGraph, base: Record<string, BumpType>) {
  const packages: Record<string, ChangelogPackageConfig | BumpType> = {
    ...base,
  };

  for (const [ref, type] of Object.entries(base)) {
    const resolved = graph.getByName(ref);

    for (const pkg of resolved) {
      const plan = pkg.initPlan();
      pkg.configurePlan(plan);

      const prerelease = semver.prerelease(pkg.version)?.[0];
      const targetPrerelease = plan.prerelease ?? graph.getPackageGroup(pkg.id)?.options.prerelease;

      if (
        // entering prerelease
        (targetPrerelease && !prerelease) ||
        // during prerelease
        (targetPrerelease && prerelease && targetPrerelease === prerelease)
      ) {
        packages[pkg.id] = {
          type,
          replay: [`exit prerelease: ${pkg.name}`],
        };
      }
    }
  }

  return packages;
}
