import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Heading, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { changelogFrontmatterSchema } from "../schemas";
import type { BumpType } from "../utils/semver";
import { frontmatter } from "../utils/frontmatter";
import type { TegamiContext } from "../context";

export interface ChangelogEntry {
  id: string;
  /** file name like `my-change.md` */
  filename: string;
  subject?: string;
  packages: Set<string>;
  type: BumpType;
  title: string;
  content: string;
}

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

  return entries.flat();
}

/** Parse one changelog markdown file into release entries. */
export function parseChangelogFile(file: string, content: string): ChangelogEntry[] {
  const parsed = frontmatter(content);
  const data = changelogFrontmatterSchema.parse(parsed.data);
  const tree = fromMarkdown(parsed.content);
  const entries: ChangelogEntry[] = [];

  for (const section of getHeadingSections(tree)) {
    const type = headingToBump(section.heading.depth);
    if (!type) continue;

    const filename = basename(file);
    entries.push({
      id: `${filename}:${entries.length}`,
      filename,
      subject: data.subject,
      packages: new Set(data.packages),
      type,
      title: headingText(section.heading),
      content: sectionToMarkdown(section.children),
    });
  }

  return entries;
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

function headingText(heading: Heading): string {
  return heading.children
    .map((child) => nodeText(child))
    .join("")
    .trim();
}

function nodeText(node: Heading["children"][number]): string {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }

  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map((child) => nodeText(child)).join("");
  }

  return "";
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
  if (depth === 1) return "major";
  if (depth === 2) return "minor";
  if (depth === 3) return "patch";
  return undefined;
}
