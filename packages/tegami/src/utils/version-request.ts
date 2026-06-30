import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import type { ChangelogEntry } from "../changelog/parse";
import type { Draft } from "../plans/draft";
import type { WorkspacePackage } from "../graph";
import { execFailure } from "./error";
import { formatNpmDistTag } from "./semver";

export async function hasGitChanges(cwd: string): Promise<boolean> {
  const result = await x("git", ["status", "--porcelain"], {
    nodeOptions: { cwd },
  });
  if (result.exitCode !== 0) {
    throw execFailure("Failed to check git status.", result);
  }

  return result.stdout.trim().length > 0;
}

export async function commitVersionBranchChanges(
  cwd: string,
  branch: string,
  title: string,
): Promise<void> {
  const gitOptions = { nodeOptions: { cwd } };

  let result = await x("git", ["checkout", "-B", branch], gitOptions);
  if (result.exitCode !== 0) {
    throw execFailure("Failed to create the version branch.", result);
  }

  result = await x("git", ["add", "-A"], gitOptions);
  if (result.exitCode !== 0) {
    throw execFailure("Failed to stage version changes.", result);
  }

  result = await x("git", ["commit", "-m", title], gitOptions);
  if (result.exitCode !== 0) {
    throw execFailure("Failed to commit version changes.", result);
  }

  result = await x("git", ["push", "--force", "-u", "origin", branch], gitOptions);
  if (result.exitCode !== 0) {
    throw execFailure(
      "Failed to push the version branch to origin. Ensure `origin` is configured and you have push access.",
      result,
    );
  }
}

/**
 * The single version every released package landed on, or `undefined` when the
 * release is empty or spans independent versions. Only packages whose version
 * changed count, matching the rows in {@link createVersionRequestBody}.
 */
function sharedReleaseVersion(
  draft: Draft,
  context: TegamiContext,
  snapshots: Map<string, string | undefined>,
): string | undefined {
  const versions = new Set<string>();

  for (const id of draft.getPackageDrafts().keys()) {
    const pkg = context.graph.get(id);
    if (!pkg?.version) continue;

    const originalVersion = snapshots.get(pkg.id);
    if (!originalVersion || originalVersion === pkg.version) continue;

    versions.add(pkg.version);
  }

  return versions.size === 1 ? versions.values().next().value : undefined;
}

/**
 * Resolve the Version Packages PR/MR title.
 *
 * - `template` set: its `{version}` token is replaced with the shared release
 *   version. Templates that reference `{version}` fall back to the default when
 *   the release has no single version; static templates are used verbatim.
 * - no `template`: `Version Packages v<version>` for a single shared version
 *   (single package or synced group), otherwise the bare `Version Packages`.
 */
export function resolveVersionRequestTitle(
  template: string | undefined,
  draft: Draft,
  context: TegamiContext,
  snapshots: Map<string, string | undefined>,
): string {
  const version = sharedReleaseVersion(draft, context, snapshots);

  if (template) {
    if (!template.includes("{version}")) return template;
    if (version) return template.replace(/\{version\}/g, version);
    return "Version Packages";
  }

  return version ? `Version Packages v${version}` : "Version Packages";
}

export function createVersionRequestBody(
  draft: Draft,
  context: TegamiContext,
  snapshots: Map<string, string | undefined>,
  summary: string,
): string {
  const packageLines: string[] = [];
  const changesets = new Map<ChangelogEntry, WorkspacePackage[]>();

  for (const [id, packageDraft] of draft.getPackageDrafts()) {
    const pkg = context.graph.get(id);
    if (!pkg) continue;

    for (const entry of packageDraft.changelogs ?? []) {
      const list = changesets.get(entry);
      if (list) list.push(pkg);
      else changesets.set(entry, [pkg]);
    }

    const originalVersion = snapshots.get(pkg.id);
    if (!originalVersion || originalVersion === pkg.version) continue;

    packageLines.push(
      `| \`${pkg.name}\` | \`${originalVersion}\` | \`${pkg.version}\`${formatNpmDistTag(packageDraft.npm?.distTag)} |`,
    );
  }

  const changelogLines: string[] = [];
  for (const [entry, linkedPackages] of changesets) {
    changelogLines.push(`### ${entry.subject ?? `\`${entry.filename}\``}`, "");

    changelogLines.push(
      "<details>",
      `<summary>Show Bumped Packages (${linkedPackages.length})</summary>`,
      "",
      ...linkedPackages.map((pkg) => `- \`${pkg.id}\``),
      "",
      "</details>",
      "",
    );

    for (const section of entry.sections) {
      changelogLines.push(`#### ${section.title}`, "");
      if (section.content) changelogLines.push(section.content);
    }
  }

  const sections = ["## Summary", "", summary, ""];

  if (packageLines.length > 0) {
    sections.push("| Package | From | To |", "| --- | --- | --- |", ...packageLines);
  }

  if (changelogLines.length > 0) {
    sections.push("", "## Changelogs", ...changelogLines);
  }

  sections.push("");

  return sections.join("\n");
}
