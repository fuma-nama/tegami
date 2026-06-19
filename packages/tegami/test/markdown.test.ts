import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { parseChangelogFile } from "../src/changelog/parse";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("markdown changelog parsing", () => {
  test("parses yaml frontmatter and release headings", () => {
    const entry = parseChangelogFile(
      "/repo/.tegami/change.md",
      `---
subject: OpenAPI v11
packages: ["core", "ui"]
---

# Breaking export path

\`\`\`ts
import { ui } from "openapi";
\`\`\`

## Add proxy server

Some description.

### Fix path resolution

- Handles relative paths.

#### Notes

Ignored for release planning.
`,
    );

    expect(normalizeEntry(entry)).toMatchInlineSnapshot(`
      {
        "filename": "change.md",
        "id": "change.md",
        "packages": {
          "core": "major",
          "ui": "major",
        },
        "sections": [
          {
            "content": "\`\`\`ts
      import { ui } from "openapi";
      \`\`\`",
            "depth": 1,
            "title": "Breaking export path",
          },
          {
            "content": "Some description.",
            "depth": 2,
            "title": "Add proxy server",
          },
          {
            "content": "- Handles relative paths.",
            "depth": 3,
            "title": "Fix path resolution",
          },
          {
            "content": "Ignored for release planning.",
            "depth": 4,
            "title": "Notes",
          },
        ],
        "subject": "OpenAPI v11",
      }
    `);
  });

  test("throws when frontmatter has invalid package data", () => {
    expect(() =>
      parseChangelogFile(
        "/repo/.tegami/change.md",
        `---
packages: core
---

### Invalid
`,
      ),
    ).toThrow();
  });

  test("returns undefined when frontmatter has no packages", () => {
    expect(
      parseChangelogFile("/repo/.tegami/change.md", "---\r\n---\r\n\r\n### Patch release\r\n"),
    ).toBeUndefined();
  });
});

function normalizeEntry(entry: ReturnType<typeof parseChangelogFile>) {
  if (!entry) return entry;

  return {
    ...entry,
    packages: Object.fromEntries(entry.packages),
  };
}
