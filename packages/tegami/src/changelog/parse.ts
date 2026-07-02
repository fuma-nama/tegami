import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { maxBump, type BumpType } from "../utils/semver";
import { frontmatter } from "../utils/frontmatter";
import type { TegamiContext } from "../context";
import {
  validateChangelogFrontmatter,
  renderChangelog,
  type ChangelogPackageConfig,
} from "./shared";

export interface ChangelogEntry {
  id: string;
  /** file name like `my-change.md` */
  filename: string;
  subject?: string;
  packages: Map<string, ChangelogPackageConfig>;
  /** will not be empty */
  sections: {
    depth: number;
    title: string;
    content: string;
  }[];

  /** Generated in memory and not yet written to `changelogDir`. */
  virtual?: boolean;

  getRawContent: () => string;
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
      return parseChangelogFile(basename(filePath), content);
    }),
  );

  return entries.filter((v) => v !== undefined);
}

/** Parse one changelog markdown file into release entries. */
export function parseChangelogFile(filename: string, content: string): ChangelogEntry | undefined {
  const parsed = frontmatter(content);
  const validated = validateChangelogFrontmatter(parsed.data);
  if (!validated.success) return;
  const { packages: packagesConfig } = validated.data;
  if (!packagesConfig) return;
  const data = validated.data;

  let headingBump: BumpType | undefined;
  const packages = new Map<string, ChangelogPackageConfig>();
  const sections: ChangelogEntry["sections"] = [];

  for (const section of parseMarkdownSections(parsed.content)) {
    const sectionBumpType = headingToBump(section.depth);
    if (sectionBumpType) {
      headingBump = headingBump ? maxBump(headingBump, sectionBumpType) : sectionBumpType;
    }

    sections.push({
      depth: section.depth,
      title: section.title,
      content: section.content,
    });
  }

  if (sections.length === 0) return;

  if (Array.isArray(packagesConfig)) {
    if (!headingBump) return;
    for (const pkg of packagesConfig) {
      packages.set(pkg, { type: headingBump });
    }
  } else {
    for (const [k, v] of Object.entries(packagesConfig)) {
      let config: ChangelogPackageConfig;
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
      return renderChangelog(
        {
          subject: this.subject,
          packages: Object.fromEntries(this.packages.entries()),
        },
        entry._raw_body,
      );
    },
  };

  return entry;
}

export type ReplayCondition =
  | {
      on: "version";
      name: string;
      version: string;
    }
  | {
      on: "exit-prerelease";
      name: string;
    }
  | {
      on: "enter-prerelease";
      name: string;
    };

export function formatReplayCondition(condition: ReplayCondition): string {
  switch (condition.on) {
    case "exit-prerelease":
      return `exit-prerelease(${condition.name})`;
    case "enter-prerelease":
      return `prerelease(${condition.name})`;
    case "version":
      return `${condition.name}@${condition.version}`;
  }
}

export function parseReplayCondition(condition: string): ReplayCondition | null {
  let match: RegExpExecArray | null;
  if ((match = /^exit-prerelease\((.+)\)$/.exec(condition))) {
    return {
      on: "exit-prerelease",
      name: match[1]!,
    };
  }

  if ((match = /^prerelease\((.+)\)$/.exec(condition))) {
    return {
      on: "enter-prerelease",
      name: match[1]!,
    };
  }

  // legacy syntax
  if ((match = /^exit prerelease:\s*(.+)$/.exec(condition))) {
    return {
      on: "exit-prerelease",
      name: match[1]!,
    };
  }

  if ((match = /^(.+)@([^@]+)$/.exec(condition))) {
    return {
      on: "version",
      name: match[1]!,
      version: match[2]!,
    };
  }

  return null;
}

interface RawMarkdownSection {
  depth: number;
  title: string;
  contentLines: string[];
}

interface MarkdownSection {
  depth: number;
  title: string;
  content: string;
}

function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const lines = markdown.split(/\r\n|\r|\n/);
  let current: RawMarkdownSection | undefined;
  let fence: string | undefined;

  for (const line of lines) {
    const fenceMarker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMarker) {
      const marker = fenceMarker[1]!;

      if (!fence) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
    }

    if (!fence) {
      const heading = parseHeading(line);
      if (heading) {
        if (current) sections.push(toMarkdownSection(current));
        current = { ...heading, contentLines: [] };
        continue;
      }
    }

    current?.contentLines.push(line);
  }

  if (current) sections.push(toMarkdownSection(current));
  return sections;
}

function parseHeading(line: string): Omit<MarkdownSection, "content"> | undefined {
  const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
  if (!match) return;

  return {
    depth: match[1]!.length,
    title: stripClosingHeadingSequence(match[2]!).trim(),
  };
}

function stripClosingHeadingSequence(value: string): string {
  return value.replace(/[ \t]+#{1,}[ \t]*$/, "");
}

function toMarkdownSection(section: RawMarkdownSection): MarkdownSection {
  return {
    depth: section.depth,
    title: section.title,
    content: section.contentLines.join("\n").trim(),
  };
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
