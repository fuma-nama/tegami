import z from "zod";
import { dump } from "js-yaml";

const bumpTypeSchema = z.enum(["major", "minor", "patch"]);

const changelogPackageConfigSchema = z.object({
  type: bumpTypeSchema.optional(),
  replay: z.array(z.string().min(1)).optional(),
});

export const changelogFrontmatterSchema = z.object({
  subject: z.string().optional(),
  packages: z
    .union([
      z.array(z.string()),
      z.record(z.string(), z.union([bumpTypeSchema, z.null(), changelogPackageConfigSchema])),
    ])
    .optional(),
});

export type ChangelogPackageConfig = z.output<typeof changelogPackageConfigSchema>;

export function renderChangelog(
  frontmatter: z.input<typeof changelogFrontmatterSchema>,
  body: string,
): string {
  return ["---", dump(frontmatter).trim(), "---", "", body.trim(), ""].join("\n");
}
