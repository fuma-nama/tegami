import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Heading, Root, RootContent } from "mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { remark } from "remark";
import { type ChangelogEntry, changelogFrontmatterSchema } from "./schemas";
import { isNodeError } from "./utils/error";
import type { BumpType } from "./utils/semver";
import { frontmatter } from "./utils/frontmatter";

export async function readChangelogEntries(
  cwd: string,
  changelogDir: string,
): Promise<ChangelogEntry[]> {
  const directory = resolve(cwd, changelogDir);

  const files = await readdir(directory).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  });
  const entries: ChangelogEntry[] = [];

  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;

    const filePath = join(directory, file);
    const content = await readFile(filePath, "utf8");
    entries.push(...parseChangelogFile(filePath, content));
  }

  return entries;
}

/** Parse one changelog markdown file into release entries. */
export function parseChangelogFile(file: string, content: string): ChangelogEntry[] {
  const parsed = frontmatter(content);
  const data = changelogFrontmatterSchema.parse(parsed.data);
  const tree = remark().parse(parsed.content);
  const entries: ChangelogEntry[] = [];

  for (const section of getHeadingSections(tree)) {
    const type = headingToBump(section.heading.depth);
    if (!type) continue;

    entries.push({
      id: changelogId(file, entries.length),
      file,
      subject: data.subject,
      packages: data.packages,
      type,
      title: headingText(section.heading),
      content: sectionToMarkdown(section.children),
    });
  }

  return entries;
}

function changelogId(file: string, index: number): string {
  return createHash("sha256").update(`${file}\u0000${index}`).digest("hex").slice(0, 12);
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
