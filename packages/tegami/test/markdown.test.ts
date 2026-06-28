import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { parseChangelogFile, parseReplayCondition } from "../src/changelog/parse";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("markdown changelog parsing", () => {
  test("parses yaml frontmatter and release headings", () => {
    const entry = parseChangelogFile(
      "change.md",
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
          "core": {
            "type": "major",
          },
          "ui": {
            "type": "major",
          },
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

  test("returns undefined when frontmatter has invalid package data", () => {
    expect(
      parseChangelogFile(
        "change.md",
        `---
packages: core
---

### Invalid
`,
      ),
    ).toBeUndefined();
  });

  test("returns undefined when frontmatter has no packages", () => {
    expect(
      parseChangelogFile("change.md", "---\r\n---\r\n\r\n### Patch release\r\n"),
    ).toBeUndefined();
  });

  test("parses replay-only package config without bump headings", () => {
    const entry = parseChangelogFile(
      "replay.md",
      `---
packages:
  npm:tegami:
    replay: [tegami@1.1.0]
---

## Use preferred package manager

This ensures the pm-specific protocols like \`workspace:\` are respected.
`,
    );

    expect(normalizeEntry(entry)).toMatchInlineSnapshot(`
      {
        "filename": "replay.md",
        "id": "replay.md",
        "packages": {
          "npm:tegami": {
            "replay": [
              "tegami@1.1.0",
            ],
          },
        },
        "sections": [
          {
            "content": "This ensures the pm-specific protocols like \`workspace:\` are respected.",
            "depth": 2,
            "title": "Use preferred package manager",
          },
        ],
      }
    `);
  });

  test("parses explicit type and replay on the same package", () => {
    const entry = parseChangelogFile(
      "replay.md",
      `---
packages:
  npm:tegami:
    type: patch
    replay: [tegami@1.1.0]
---

## Use preferred package manager

Notes.
`,
    );

    expect(normalizeEntry(entry)?.packages).toEqual({
      "npm:tegami": {
        type: "patch",
        replay: ["tegami@1.1.0"],
      },
    });
  });

  test("ignores headings inside fenced code blocks", () => {
    const entry = parseChangelogFile(
      "change.md",
      `---
packages:
  npm:tegami: patch
---

### Add generated changelog examples

\`\`\`md
### Not a release section

This stays in the code block.
\`\`\`

Still the first section.
`,
    );

    expect(normalizeEntry(entry)?.sections).toEqual([
      {
        depth: 3,
        title: "Add generated changelog examples",
        content:
          "```md\n### Not a release section\n\nThis stays in the code block.\n```\n\nStill the first section.",
      },
    ]);
  });

  test("parses indented headings and strips closing hash sequences", () => {
    const entry = parseChangelogFile(
      "change.md",
      `---
packages:
  npm:tegami: null
---

   ## Add changelog parser ##

    # This is indented code, not a heading.
`,
    );

    expect(normalizeEntry(entry)?.packages).toEqual({
      "npm:tegami": {
        type: "minor",
      },
    });
    expect(normalizeEntry(entry)?.sections).toEqual([
      {
        depth: 2,
        title: "Add changelog parser",
        content: "# This is indented code, not a heading.",
      },
    ]);
  });
});

describe("parseReplayCondition", () => {
  test("parses package@version replay conditions", () => {
    expect(parseReplayCondition("tegami@1.1.0")).toEqual({
      type: "on-version",
      name: "tegami",
      version: "1.1.0",
    });
    expect(parseReplayCondition("@acme/core@2.0.0")).toEqual({
      type: "on-version",
      name: "@acme/core",
      version: "2.0.0",
    });
  });

  test("parses exit prerelease replay conditions", () => {
    expect(parseReplayCondition("exit prerelease: tegami")).toEqual({
      type: "on-exit-prerelease",
      name: "tegami",
    });
  });

  test("rejects malformed replay conditions", () => {
    expect(parseReplayCondition("tegami")).toBeNull();
    expect(parseReplayCondition("@1.0.0")).toBeNull();
  });
});

function normalizeEntry(entry: ReturnType<typeof parseChangelogFile>) {
  if (!entry) return entry;

  const normalized: Record<string, unknown> = {
    id: entry.id,
    filename: entry.filename,
    packages: Object.fromEntries(
      [...entry.packages.entries()].map(([key, config]) => {
        const value: Record<string, unknown> = {};
        if (config.type) value.type = config.type;
        if (config.replay?.length) value.replay = config.replay;
        return [key, value];
      }),
    ),
    sections: entry.sections,
  };
  if (entry.subject) normalized.subject = entry.subject;
  return normalized;
}
