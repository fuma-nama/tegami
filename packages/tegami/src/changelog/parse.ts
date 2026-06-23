import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Heading, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { dump } from "js-yaml";
import { maxBump, type BumpType } from "../utils/semver";
import { frontmatter } from "../utils/frontmatter";
import type { TegamiContext } from "../context";
import z from "zod";
import { bumpTypeSchema } from "../schemas";

export interface ChangelogEntry {
  id: string;
  /** file name like `my-change.md` */
  filename: string;
  subject?: string;
  packages: Map<string, ChnagelogPackageConfig>;
  /** will not be empty */
  sections: {
    depth: number;
    title: string;
    content: string;
  }[];

  getRawContent: () => string;
}

export type ChnagelogPackageConfig = z.output<typeof changelogPackageConfigSchema>;

const changelogPackageConfigSchema = z.object({
  type: bumpTypeSchema.optional(),
  replay: z.array(z.string().min(1)).optional(),
});

const changelogFrontmatterSchema = z.object({
  subject: z.string().optional(),
  packages: z
    .union([
      z.array(z.string()),
      z.record(z.string(), z.union([bumpTypeSchema, z.null(), changelogPackageConfigSchema])),
    ])
    .optional(),
});

export async function getChangelogFiles(context: TegamiContext): Promise<string[]> {
  const files = await readdir(context.changelogDir).catch(() => []);

  return files.filter((file) => file.endsWith(".md"));
}

export async function readChangelogEntries(context: TegamiContext): Promise<ChangelogEntry[]> {
  const dir = context.changelogDir;

  const files = await getChangelogFiles(context);
  const entries = await Promise.all(
    files.map(async (file) => {
      const filePath = join(dir, file);
      const content = await readFile(filePath, "utf8");
      return parseChangelogFile(basename(filePath), content);
    }),
  );

  return entries.filter((v) => v !== undefined);
}

/** Parse one changelog markdown file into release entries. */
export function parseChangelogFile(filename: string, content: string): ChangelogEntry | undefined {
  const parsed = frontmatter(content);
  const { success, data } = changelogFrontmatterSchema.safeParse(parsed.data);
  if (!success || !data.packages) return;

  const tree = fromMarkdown(parsed.content);
  let headingBump: BumpType | undefined;
  const packages = new Map<string, ChnagelogPackageConfig>();
  const sections: ChangelogEntry["sections"] = [];

  for (const section of getHeadingSections(tree)) {
    const sectionBumpType = headingToBump(section.heading.depth);
    if (sectionBumpType) {
      headingBump = headingBump ? maxBump(headingBump, sectionBumpType) : sectionBumpType;
    }

    sections.push({
      depth: section.heading.depth,
      title: sectionToMarkdown(section.heading.children),
      content: sectionToMarkdown(section.children),
    });
  }

  if (sections.length === 0) return;

  if (Array.isArray(data.packages)) {
    if (!headingBump) return;
    for (const pkg of data.packages) {
      packages.set(pkg, { type: headingBump });
    }
  } else {
    for (const [k, v] of Object.entries(data.packages)) {
      let config: z.output<typeof changelogPackageConfigSchema>;
      if (typeof v === "string") config = { type: v };
      else if (v === null) config = { type: headingBump };
      else config = v;

      if (config.type || config.replay?.length) {
        packages.set(k, config);
      }
    }
  }

  if (packages.size === 0) return;
  const entry: ChangelogEntry & {
    _raw_body: string;
  } = {
    id: filename,
    filename,
    subject: data.subject,
    packages,
    sections,
    _raw_body: parsed.content,
    getRawContent() {
      const frontmatterData: z.input<typeof changelogFrontmatterSchema> = {
        subject: this.subject,
        packages: Object.fromEntries(this.packages.entries()),
      };
      return ["---", dump(frontmatterData).trim(), "---", "", entry._raw_body.trim(), ""].join(
        "\n",
      );
    },
  };

  return entry;
}

export interface ParsedReplayCondition {
  name: string;
  version: string;
}

/** Parse `name@version` replay conditions. Scoped names use the last `@`. */
export function parseReplayCondition(condition: string): ParsedReplayCondition | null {
  const idx = condition.lastIndexOf("@");
  if (idx <= 0) return null;

  return {
    name: condition.slice(0, idx),
    version: condition.slice(idx + 1),
  };
}

interface HeadingSection {
  heading: Heading;
  children: RootContent[];
}

function getHeadingSections(tree: Root): HeadingSection[] {
  const sections: HeadingSection[] = [];
  let current: HeadingSection | undefined;

  for (const child of tree.children) {
    if (child.type === "heading") {
      current = { heading: child, children: [] };
      sections.push(current);
      continue;
    }

    current?.children.push(child);
  }

  return sections;
}

function sectionToMarkdown(children: RootContent[]): string {
  if (children.length === 0) return "";

  return toMarkdown(
    {
      type: "root",
      children,
    },
    {
      bullet: "-",
      fence: "`",
    },
  ).trim();
}

function headingToBump(depth: number): BumpType | undefined {
  switch (depth) {
    case 1:
      return "major";
    case 2:
      return "minor";
    case 3:
      return "patch";
  }
}
