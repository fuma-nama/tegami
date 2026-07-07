import typia, { tags } from "typia";
import { stringify } from "yaml";
import type { BumpType } from "../utils/semver";
import type { PackageGraph, WorkspacePackage } from "../graph";
import type { ChangelogEntry } from "./parse";

export interface ChangelogPackageConfig {
  type?: BumpType;
  replay?: (string & tags.MinLength<1>)[];
}

export interface ChangelogFrontmatter {
  subject?: string;
  packages?: string[] | Record<string, BumpType | null | ChangelogPackageConfig>;
}

export const validateChangelogFrontmatter: (
  input: unknown,
) => typia.IValidation<ChangelogFrontmatter> = typia.createValidate<ChangelogFrontmatter>();

export function renderChangelog(frontmatter: ChangelogFrontmatter, body: string): string {
  return ["---", stringify(frontmatter, { lineWidth: 0 }).trim(), "---", "", body.trim(), ""].join(
    "\n",
  );
}

export function getPackageBumps(graph: PackageGraph, entry: ChangelogEntry) {
  const packageBumps = new Map<WorkspacePackage, BumpType>();

  for (const [name, config] of entry.packages) {
    if (!config.type) continue;
    for (const pkg of graph.getByName(name)) packageBumps.set(pkg, config.type);
  }

  return packageBumps;
}
