import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "package-manager-detector";
import { x } from "tinyexec";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import { createDraftPlan } from "../src/plans/draft";
import { parseChangelogFile } from "../src/changelog/parse";
import type { TegamiContext } from "../src/context";
import {
  CI_PR_MARKER,
  getPullRequestChangelogFiles,
  renderCiPrComment,
  resolvePullRequestEvent,
  runCiPr,
  upsertPullRequestComment,
} from "../src/cli/ci-pr";
import { formatRunScriptCommand } from "../src/utils/package-manager";

vi.mock("package-manager-detector", () => ({
  detect: vi.fn(),
  resolveCommand: vi.fn((agent: string, command: string, args: string[]) => {
    if (command !== "run") return null;
    if (agent === "pnpm") return { command: "pnpm", args: ["run", ...args] };
    return { command: "npm", args: ["run", ...args] };
  }),
}));
vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const detectPackageManager = vi.mocked(detect);
const exec = vi.mocked(x);
const tempDirs: string[] = [];

afterEach(async () => {
  detectPackageManager.mockReset();
  exec.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  delete process.env.GITHUB_EVENT_PATH;
  delete process.env.GITHUB_REPOSITORY;
});

describe("ci-pr", () => {
  test("renders release preview and PR changelogs", async () => {
    const context = createTestContext([
      testPackage("@acme/core", "1.0.0"),
      testPackage("@acme/ui", "2.0.0"),
    ]);
    const draft = await createDraftPlan(
      [
        parseChangelogFile(
          "2026-06-19-core.md",
          `---
packages: ["@acme/core"]
---

## Support auto changelogs
`,
        )!,
        parseChangelogFile(
          "2026-06-19-ui.md",
          `---
packages:
  "@acme/ui": patch
---

### Fix button hover state
`,
        )!,
      ],
      context,
    );

    const body = renderCiPrComment(context, draft, {
      repo: "acme/repo",
      branch: "feature/release",
      prChangelogFiles: ["2026-06-19-core.md"],
      tegamiCommand: "pnpm run tegami",
    });

    expect(body).toContain("### Tegami");
    expect(body).toContain(
      "[**Create a changelog →**](https://github.com/acme/repo/new/feature/release/.tegami/",
    );
    expect(body).toContain("| `@acme/core` | minor | `1.0.0` → `1.1.0` (no publish) |");
    expect(body).toContain("| `@acme/ui` | patch | `2.0.0` → `2.0.1` (no publish) |");
    expect(body).toContain("#### Changelogs in this PR");
    expect(body).toContain("- `2026-06-19-core.md` — Support auto changelogs");
    expect(body).not.toContain("2026-06-19-ui.md");
  });

  test("prompts contributors when no changelogs exist", async () => {
    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraftPlan([], context);

    const body = renderCiPrComment(context, draft, {
      repo: "acme/repo",
      branch: "main",
      prChangelogFiles: [],
      tegamiCommand: "npm run tegami",
    });

    expect(body).toContain("#### No changelogs yet");
    expect(body).toContain("Run `npm run tegami` locally");
    expect(body).not.toContain("Release preview");
  });

  test("reads pull request metadata from GITHUB_EVENT_PATH", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-ci-pr-event-"));
    tempDirs.push(cwd);
    const eventPath = join(cwd, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 42,
          head: { ref: "feature/test", sha: "head-sha" },
          base: { sha: "base-sha" },
        },
      }),
    );

    process.env.GITHUB_EVENT_PATH = eventPath;

    await expect(resolvePullRequestEvent()).resolves.toEqual({
      number: 42,
      headRef: "feature/test",
      baseSha: "base-sha",
      headSha: "head-sha",
    });
  });

  test("lists changelog files added in a pull request", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-ci-pr-git-"));
    tempDirs.push(cwd);
    const context = createTestContext([], cwd);

    exec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: ".tegami/2026-06-19-core.md\n",
      stderr: "",
    } as Awaited<ReturnType<typeof x>>);

    await expect(getPullRequestChangelogFiles(context, "base-sha", "head-sha")).resolves.toEqual([
      "2026-06-19-core.md",
    ]);

    expect(exec).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "--diff-filter=AM", "base-sha...head-sha", "--", ".tegami/"],
      expect.objectContaining({ nodeOptions: { cwd } }),
    );
  });

  test("creates and updates pull request comments", async () => {
    exec.mockImplementation((_command, args = []) => {
      if (args[0] === "api" && args[1]?.includes("/comments") && args[2] === "--paginate") {
        return commandResult({
          stdout: JSON.stringify([{ id: 99, body: `${CI_PR_MARKER}\nold` }]),
        });
      }

      return commandResult();
    });

    await expect(upsertPullRequestComment("acme/repo", 7, "Updated body")).resolves.toBe("updated");

    expect(exec.mock.calls.at(-1)).toEqual([
      "gh",
      [
        "api",
        "-X",
        "PATCH",
        "repos/acme/repo/issues/comments/99",
        "-f",
        `body=${CI_PR_MARKER}\nUpdated body\n`,
      ],
    ]);

    exec.mockReset();
    exec.mockImplementation((_command, args = []) => {
      if (args[0] === "api") {
        return commandResult({ stdout: "[]" });
      }

      return commandResult();
    });

    await expect(upsertPullRequestComment("acme/repo", 7, "New body")).resolves.toBe("created");

    expect(exec.mock.calls.at(-1)).toEqual([
      "gh",
      ["pr", "comment", "7", "--repo", "acme/repo", "--body", `${CI_PR_MARKER}\nNew body\n`],
    ]);
  });

  test("formats run script commands for the detected package manager", async () => {
    detectPackageManager.mockResolvedValue({ name: "pnpm", agent: "pnpm" });

    await expect(formatRunScriptCommand("/repo", "tegami")).resolves.toBe("pnpm run tegami");
    await expect(formatRunScriptCommand("/repo", "tegami", "npm")).resolves.toBe("npm run tegami");
  });

  test("prints comment body when posting is disabled", async () => {
    detectPackageManager.mockResolvedValue({ name: "npm", agent: "npm" });
    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraftPlan([], context);

    const result = await runCiPr(context, draft, { print: true });

    expect(result.posted).toBe(false);
    expect(result.body).toContain("No changelogs yet");
    expect(result.body).toContain("npm run tegami");
  });
});

function createTestContext(packages: WorkspacePackage[], cwd?: string): TegamiContext {
  const root = cwd ?? "/repo";

  return {
    cwd: root,
    changelogDir: join(root, ".tegami"),
    planPath: join(root, ".tegami", "publish-plan"),
    options: {},
    plugins: [],
    graph: new PackageGraph(packages),
    getRegistryClient() {
      throw new Error("not implemented");
    },
  };
}

function testPackage(name: string, version: string): WorkspacePackage {
  return new CiPrTestPackage(name, version);
}

class CiPrTestPackage extends WorkspacePackage {
  readonly manager = "npm";

  constructor(
    readonly name: string,
    readonly version: string,
  ) {
    super();
  }

  get path() {
    return `/repo/packages/${this.name}`;
  }
}

type ExecResult = Awaited<ReturnType<typeof x>>;

function commandResult(overrides: Partial<ExecResult> = {}): ReturnType<typeof x> {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  } as unknown as ReturnType<typeof x>;
}
