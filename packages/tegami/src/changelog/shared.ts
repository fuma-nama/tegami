import typia, { tags } from "typia";
import { stringify } from "yaml";
import type { BumpType } from "../utils/semver";

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
