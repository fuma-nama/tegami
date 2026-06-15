import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { parseChangelogFile } from "../src/changelog/parse";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("markdown changelog parsing", () => {
  test("parses yaml frontmatter and release headings", () => {
    const entries = parseChangelogFile(
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

    expect(entries.map(normalizeEntry)).toMatchInlineSnapshot(`
      [
        {
          "content": "\`\`\`ts
      import { ui } from "openapi";
      \`\`\`",
          "filename": "change.md",
          "id": "change.md:0",
          "packages": [
            "core",
            "ui",
          ],
          "subject": "OpenAPI v11",
          "title": "Breaking export path",
          "type": "major",
        },
        {
          "content": "Some description.",
          "filename": "change.md",
          "id": "change.md:1",
          "packages": [
            "core",
            "ui",
          ],
          "subject": "OpenAPI v11",
          "title": "Add proxy server",
          "type": "minor",
        },
        {
          "content": "- Handles relative paths.",
          "filename": "change.md",
          "id": "change.md:2",
          "packages": [
            "core",
            "ui",
          ],
          "subject": "OpenAPI v11",
          "title": "Fix path resolution",
          "type": "patch",
        },
      ]
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

  test("parses empty crlf frontmatter", () => {
    const entries = parseChangelogFile(
      "/repo/.tegami/change.md",
      "---\r\n---\r\n\r\n### Patch release\r\n",
    );

    expect(entries.map(normalizeEntry)).toMatchInlineSnapshot(`
      [
        {
          "content": "",
          "filename": "change.md",
          "id": "change.md:0",
          "packages": [],
          "subject": undefined,
          "title": "Patch release",
          "type": "patch",
        },
      ]
    `);
  });
});

function normalizeEntry(entry: ReturnType<typeof parseChangelogFile>[number]) {
  return {
    ...entry,
    packages: Array.from(entry.packages),
  };
}
