import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TegamiContext } from "../context";

const CHANGELOG_DOCS_URL = "https://tegami.fuma-nama.dev/changelog";

export interface InitAgentOptions {
  output?: string;
}

export interface InitAgentResult {
  path: string;
  created: boolean;
}

export async function initAgent(
  context: TegamiContext,
  options: InitAgentOptions = {},
): Promise<InitAgentResult> {
  const output = path.resolve(context.cwd, options.output ?? "AGENTS.md");
  const content = renderAgentsMd(context);

  try {
    const existing = await readFile(output, "utf8");
    await writeFile(output, existing.trimEnd() + "\n\n" + content);
    return { path: output, created: false };
  } catch {
    await writeFile(output, content);
    return { path: output, created: true };
  }
}

export function renderAgentsMd(context: TegamiContext): string {
  const changelogDir = path.relative(context.cwd, context.changelogDir) || "project root";
  const planPath = path.relative(context.cwd, context.planPath) || "project root";

  return [
    "# Release workflow",
    "",
    "This repository uses [Tegami](https://tegami.fuma-nama.dev) for versioning and publishing.",
    "",
    "## Write changelog files",
    "",
    `Create pending changelog files under \`${changelogDir}/\` as \`YYYY-MM-DD-{hash}.md\`.`,
    "",
    `See the [changelog format docs](${CHANGELOG_DOCS_URL}) for details.`,
    "",
    "### Example",
    "",
    "```md",
    "---",
    "packages:",
    `  "npm:@acme/ui": patch`,
    "---",
    "",
    "### Fix button hover state",
    "",
    "The hover color now matches the design system.",
    "```",
    "",
    "### Package references",
    "",
    "Use package names, ids, or groups in frontmatter. For example:",
    "",
    '- `"@acme/ui"` — package name',
    '- `"npm:@acme/ui"` — package id',
    '- `"group:acme"` — every package in a group',
    "",
    "Rules:",
    "",
    "- Include YAML frontmatter with `packages`",
    "- Include at least one `#`, `##`, or `###` heading in the body",
    "- Write user-facing release notes under each heading",
    `- Do not edit \`${planPath}\` or package \`CHANGELOG.md\` files directly`,
    "",
  ].join("\n");
}
