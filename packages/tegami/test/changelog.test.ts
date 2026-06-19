import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  conventionalCommitToBump,
  createConventionalCommitParser,
} from "../src/utils/conventional-commit";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import { tegami } from "../src";
import { getPendingPackageIds } from "./helpers/draft";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const tempDirs: string[] = [];
const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockReset();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("conventional commits", () => {
  const graph = new PackageGraph([
    testPackage("@acme/core", "/repo/packages/core"),
    testPackage("@acme/ui", "/repo/packages/ui"),
  ]);
  const parse = createConventionalCommitParser(graph);

  test("parses angular and semantic-release style headers", () => {
    expect(parse("feat(core): add widgets")).toEqual({
      type: "feat",
      packages: ["@acme/core"],
      breaking: false,
      title: "add widgets",
    });
    expect(parse("fix(@acme/ui): repair button state")).toEqual({
      type: "fix",
      packages: ["@acme/ui"],
      breaking: false,
      title: "repair button state",
    });
    expect(parse("feat!: drop legacy api")).toEqual({
      type: "feat",
      packages: [],
      breaking: true,
      title: "drop legacy api",
    });
    expect(parse("fix(scope)!: breaking patch")).toEqual({
      type: "fix",
      packages: ["scope"],
      breaking: true,
      title: "breaking patch",
    });
    expect(parse("revert: undo release")).toEqual({
      type: "revert",
      packages: [],
      breaking: false,
      title: "undo release",
    });
    expect(parse("fix(core): update api", "BREAKING CHANGE: removed old api")).toEqual({
      type: "fix",
      packages: ["@acme/core"],
      breaking: true,
      title: "update api",
    });
  });

  test("rejects non-conventional subjects", () => {
    expect(parse("chore:missing space")).toBeUndefined();
    expect(parse("feat: ")).toBeUndefined();
    expect(parse("not a commit")).toBeUndefined();
  });

  test("maps releasable types to semver bumps", () => {
    expect(conventionalCommitToBump("feat", false)).toBe("minor");
    expect(conventionalCommitToBump("fix", false)).toBe("patch");
    expect(conventionalCommitToBump("perf", false)).toBe("patch");
    expect(conventionalCommitToBump("revert", false)).toBe("patch");
    expect(conventionalCommitToBump("chore", false)).toBeUndefined();
    expect(conventionalCommitToBump("feat", true)).toBe("major");
  });

  test("resolves scopes with a cached short-name index", () => {
    expect(parse("fix(core): patch")).toEqual({
      type: "fix",
      packages: ["@acme/core"],
      breaking: false,
      title: "patch",
    });
    expect(parse("feat(@acme/ui,core): change")).toEqual({
      type: "feat",
      packages: ["@acme/ui", "@acme/core"],
      breaking: false,
      title: "change",
    });
  });
});

describe("createChangelog", () => {
  test("creates pending changelog files from conventional commits", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    exec.mockImplementation((_command, args = []) => {
      if (args[0] === "describe") {
        return Promise.resolve(result({ stdout: "v1.0.0\n" })) as unknown as ReturnType<typeof x>;
      }

      return Promise.resolve(
        result({
          stdout: [
            record("abc123", "feat(core): support auto changelogs", "Adds generated notes."),
            record("def456", "fix(@acme/ui): repair button state", ""),
            record("ghi789", "chore(core): update tooling", ""),
          ].join(""),
        }),
      ) as unknown as ReturnType<typeof x>;
    });

    const created = await tegami({ cwd }).generateChangelog();

    expect(exec.mock.calls.map((call) => call[1])).toEqual([
      ["describe", "--tags", "--abbrev=0"],
      ["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", "v1.0.0..HEAD"],
    ]);
    expect(created).toHaveLength(2);

    const files = await Promise.all(
      created.map(async (entry) => ({
        ...entry,
        content: await readFile(entry.path, "utf8"),
      })),
    );
    expect(files.map(normalizeFile)).toMatchInlineSnapshot(`
      [
        {
          "changes": 1,
          "content": "---
      packages: ["@acme/core"]
      ---

      ## Support auto changelogs

      Adds generated notes.
      ",
          "packages": [
            "@acme/core",
          ],
        },
        {
          "changes": 1,
          "content": "---
      packages: ["@acme/ui"]
      ---

      ### Repair button state
      ",
          "packages": [
            "@acme/ui",
          ],
        },
      ]
    `);

    const paper = tegami({ cwd });
    const draft = await paper.draft();
    expect(await normalizePlan(draft, cwd)).toMatchInlineSnapshot(`
      {
        "npm:@acme/core": {
          "changelogIds": [
            "<stamp>.md",
          ],
          "type": "minor",
        },
        "npm:@acme/ui": {
          "changelogIds": [
            "<stamp>.md",
          ],
          "type": "patch",
        },
      }
    `);
  });
});

async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-changelog-"));

  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await mkdir(join(cwd, "packages/ui"), { recursive: true });
  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeJson(join(cwd, "packages/core/package.json"), {
    name: "@acme/core",
    version: "1.0.0",
  });
  await writeJson(join(cwd, "packages/ui/package.json"), {
    name: "@acme/ui",
    version: "1.0.0",
  });

  return cwd;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function record(hash: string, subject: string, body: string): string {
  return `${hash}\x1f${subject}\x1f${body}\x1e`;
}

function result(overrides: Partial<Awaited<ReturnType<typeof x>>>): Awaited<ReturnType<typeof x>> {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  } as Awaited<ReturnType<typeof x>>;
}

function normalizeFile(file: { packages: string[]; changes: number; content: string }) {
  return {
    packages: file.packages,
    changes: file.changes,
    content: file.content.replaceAll(/\d{4}-\d{2}-\d{2}-[a-z0-9]+\.md/g, "<stamp>.md"),
  };
}

async function normalizePlan(
  draft: Awaited<ReturnType<ReturnType<typeof tegami>["draft"]>>,
  cwd: string,
) {
  const graph = await tegami({ cwd })._internal.graph();
  return Object.fromEntries(
    getPendingPackageIds(draft, graph).map((id) => {
      const plan = draft.getPackagePlan(id)!;
      return [
        id,
        {
          type: plan.type,
          changelogIds: (plan.changelogs ?? []).map((item) =>
            item.id.replaceAll(/\d{4}-\d{2}-\d{2}-[a-z0-9]+\.md/g, "<stamp>.md"),
          ),
        },
      ];
    }),
  );
}

function testPackage(name: string, path: string): WorkspacePackage {
  return new ChangelogTestPackage(name, path);
}

class ChangelogTestPackage extends WorkspacePackage {
  readonly manager = "npm";
  readonly version = "1.0.0";

  constructor(
    readonly name: string,
    readonly path: string,
  ) {
    super();
  }
}
