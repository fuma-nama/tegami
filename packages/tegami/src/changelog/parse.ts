import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Heading, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
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
  packages: Map<string, BumpType>;
  /** will not be empty */
  sections: {
    depth: number;
    title: string;
    content: string;
  }[];
}

const changelogFrontmatterSchema = z.object({
  subject: z.string().optional(),
  packages: z
    .union([z.array(z.string()), z.record(z.string(), bumpTypeSchema.or(z.null()))])
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
      return parseChangelogFile(filePath, content);
    }),
  );

  return entries.filter((v) => v !== undefined);
}

/** Parse one changelog markdown file into release entries. */
export function parseChangelogFile(file: string, content: string): ChangelogEntry | undefined {
  const parsed = frontmatter(content);
  const data = changelogFrontmatterSchema.parse(parsed.data);
  if (!data.packages) return;

  const tree = fromMarkdown(parsed.content);
  let bumpType: BumpType | undefined;
  const packages = new Map<string, BumpType>();
  const sections: ChangelogEntry["sections"] = [];
  const filename = basename(file);

  for (const section of getHeadingSections(tree)) {
    const sectionBumpType = headingToBump(section.heading.depth);
    if (sectionBumpType) {
      bumpType = bumpType ? maxBump(bumpType, sectionBumpType) : sectionBumpType;
    }

    sections.push({
      depth: section.heading.depth,
      title: sectionToMarkdown(section.heading.children),
      content: sectionToMarkdown(section.children),
    });
  }

  // no sections & no bumps
  if (!bumpType) return;

  if (Array.isArray(data.packages)) {
    for (const pkg of data.packages) {
      packages.set(pkg, bumpType);
    }
  } else {
    for (const [k, v] of Object.entries(data.packages)) {
      packages.set(k, v ?? bumpType);
    }
  }

  return {
    id: filename,
    filename,
    subject: data.subject,
    packages,
    sections,
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
