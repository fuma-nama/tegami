import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
            "changes-<stamp>-acme-core.md",
          ],
          "type": "minor",
        },
        "npm:@acme/ui": {
          "changelogIds": [
            "changes-<stamp>-acme-ui.md",
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
    content: file.content.replaceAll(/changes-[a-z0-9]+/g, "changes-<stamp>"),
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
            item.id.replaceAll(/changes-[a-z0-9]+/g, "changes-<stamp>"),
          ),
        },
      ];
    }),
  );
}
