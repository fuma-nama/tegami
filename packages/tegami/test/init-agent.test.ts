import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type TegamiContext } from "../src/context";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import { initAgent, renderAgentsMd } from "../src/cli/init-agent";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("init-agent", () => {
  test("renders changelog instructions with repo packages", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-init-agent-"));
    tempDirs.push(cwd);

    const context = createTestContext(cwd, [
      testPackage("@acme/core", join(cwd, "packages/core")),
      testPackage("@acme/ui", join(cwd, "packages/ui")),
    ]);
    context.graph.registerGroup("acme", {});
    context.graph.addGroupMember("acme", "npm:@acme/core");
    context.graph.addGroupMember("acme", "npm:@acme/ui");

    expect(renderAgentsMd(context)).toMatchInlineSnapshot(`
      "# Release workflow

      This repository uses [Tegami](https://tegami.fuma-nama.dev) for versioning and publishing.

      ## Write changelog files

      Create pending changelog files under \`.tegami/\` as \`YYYY-MM-DD-{hash}.md\`.

      See the [changelog format docs](https://tegami.fuma-nama.dev/changelog) for details.

      ### Example

      \`\`\`md
      ---
      packages:
        "npm:@acme/ui": patch
      ---

      ### Fix button hover state

      The hover color now matches the design system.
      \`\`\`

      ### Package references

      Use package names, ids, or groups in frontmatter. For example:

      - \`"@acme/ui"\` — package name
      - \`"npm:@acme/ui"\` — package id
      - \`"group:acme"\` — every package in a group

      Rules:

      - Include YAML frontmatter with \`packages\`
      - Include at least one \`#\`, \`##\`, or \`###\` heading in the body
      - Write user-facing release notes under each heading
      - Do not edit \`.tegami/publish-plan\` or package \`CHANGELOG.md\` files directly
      "
    `);
  });

  test("writes AGENTS.md and appends to an existing file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-init-agent-"));
    tempDirs.push(cwd);

    const context = createTestContext(cwd, [testPackage("@acme/core", join(cwd, "packages/core"))]);

    const first = await initAgent(context);
    expect(first.created).toBe(true);

    await writeFile(first.path, "# Existing instructions\n");
    const second = await initAgent(context);
    expect(second.created).toBe(false);

    const content = await readFile(first.path, "utf8");
    expect(content).toMatchInlineSnapshot(`
      "# Existing instructions

      # Release workflow

      This repository uses [Tegami](https://tegami.fuma-nama.dev) for versioning and publishing.

      ## Write changelog files

      Create pending changelog files under \`.tegami/\` as \`YYYY-MM-DD-{hash}.md\`.

      See the [changelog format docs](https://tegami.fuma-nama.dev/changelog) for details.

      ### Example

      \`\`\`md
      ---
      packages:
        "npm:@acme/ui": patch
      ---

      ### Fix button hover state

      The hover color now matches the design system.
      \`\`\`

      ### Package references

      Use package names, ids, or groups in frontmatter. For example:

      - \`"@acme/ui"\` — package name
      - \`"npm:@acme/ui"\` — package id
      - \`"group:acme"\` — every package in a group

      Rules:

      - Include YAML frontmatter with \`packages\`
      - Include at least one \`#\`, \`##\`, or \`###\` heading in the body
      - Write user-facing release notes under each heading
      - Do not edit \`.tegami/publish-plan\` or package \`CHANGELOG.md\` files directly
      "
    `);
  });
});

function createTestContext(cwd: string, packages: WorkspacePackage[]): TegamiContext {
  const graph = new PackageGraph(packages);

  return {
    cwd,
    changelogDir: join(cwd, ".tegami"),
    planPath: join(cwd, ".tegami", "publish-plan"),
    options: {},
    plugins: [],
    graph,
    getRegistryClient() {
      throw new Error("not implemented");
    },
  };
}

function testPackage(name: string, path: string): WorkspacePackage {
  return new InitAgentTestPackage(name, path);
}

class InitAgentTestPackage extends WorkspacePackage {
  readonly manager = "npm";
  readonly version = "1.0.0";

  constructor(
    readonly name: string,
    readonly path: string,
  ) {
    super();
  }
}
