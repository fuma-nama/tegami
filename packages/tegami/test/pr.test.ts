import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "package-manager-detector";
import { x } from "tinyexec";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import { createDraftPlan } from "../src/plans/draft";
import { parseChangelogFile } from "../src/changelog/parse";
import type { TegamiContext } from "../src/context";
import { buildPrPreview, postPrComment } from "../src/cli/pr";
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

describe("pr", () => {
  test("renders release preview from pull request event", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pr-preview-"));
    tempDirs.push(cwd);
    process.env.GITHUB_REPOSITORY = "acme/repo";
    process.env.GITHUB_EVENT_PATH = join(cwd, "event.json");
    await writeFile(
      process.env.GITHUB_EVENT_PATH,
      JSON.stringify({
        pull_request: {
          number: 42,
          head: {
            ref: "feature/release",
            sha: "head-sha",
            repo: { full_name: "acme/repo" },
          },
          base: { sha: "base-sha" },
        },
      }),
    );

    exec.mockReturnValueOnce(commandResult({ stdout: ".tegami/2026-06-19-core.md\n" }));

    const context = createTestContext(
      [testPackage("@acme/core", "1.0.0"), testPackage("@acme/ui", "2.0.0")],
      cwd,
    );
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

    const body = await buildPrPreview(context, draft);

    expect(body).toContain("### Tegami");
    expect(body).toContain(
      "[**Create a changelog →**](https://github.com/acme/repo/new/feature/release?filename=.tegami%2F",
    );
    expect(body).toContain("| `@acme/core` | minor | `1.0.0` → `1.1.0` (no publish) |");
    expect(body).toContain("| `@acme/ui` | patch | `2.0.0` → `2.0.1` (no publish) |");
    expect(body).toContain("#### Changelogs in this PR");
    expect(body).toContain("- `2026-06-19-core.md` — Support auto changelogs");
    expect(body).not.toContain("2026-06-19-ui.md");
  });

  test("uses fork head repository for create changelog links", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pr-fork-"));
    tempDirs.push(cwd);
    process.env.GITHUB_REPOSITORY = "acme/repo";
    process.env.GITHUB_EVENT_PATH = join(cwd, "event.json");
    await writeFile(
      process.env.GITHUB_EVENT_PATH,
      JSON.stringify({
        pull_request: {
          number: 42,
          head: {
            ref: "feature/fork",
            sha: "head-sha",
            repo: { full_name: "fork-user/repo" },
          },
          base: { sha: "base-sha" },
        },
      }),
    );

    exec.mockReturnValueOnce(commandResult());

    detectPackageManager.mockResolvedValue({ name: "npm", agent: "npm" });
    const context = createTestContext([testPackage("@acme/core", "1.0.0")], cwd);
    const draft = await createDraftPlan([], context);
    const body = await buildPrPreview(context, draft);

    expect(body).toContain(
      "[**Create a changelog →**](https://github.com/fork-user/repo/new/feature/fork?filename=.tegami%2F",
    );
  });

  test("resolves branch from pull request number", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";

    exec.mockImplementation((command, args = []) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return commandResult({
          stdout: JSON.stringify({
            number: 7,
            headRefName: "feature/test",
            baseRefOid: "base-sha",
            headRefOid: "head-sha",
            headRepository: {
              name: "repo",
              owner: { login: "fork-user" },
            },
          }),
        });
      }

      if (command === "git") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    detectPackageManager.mockResolvedValue({ name: "npm", agent: "npm" });
    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraftPlan([], context);
    const body = await buildPrPreview(context, draft, { number: 7 });

    expect(body).toContain(
      "[**Create a changelog →**](https://github.com/fork-user/repo/new/feature/test?filename=.tegami%2F",
    );
    expect(exec).toHaveBeenCalledWith("gh", [
      "pr",
      "view",
      "7",
      "--repo",
      "acme/repo",
      "--json",
      "headRefName,baseRefOid,headRefOid,headRepository",
    ]);
  });

  test("prefers --number over pull request event metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pr-number-"));
    tempDirs.push(cwd);
    process.env.GITHUB_REPOSITORY = "acme/repo";
    process.env.GITHUB_EVENT_PATH = join(cwd, "event.json");
    await writeFile(
      process.env.GITHUB_EVENT_PATH,
      JSON.stringify({
        pull_request: {
          number: 42,
          head: {
            ref: "from-event",
            sha: "head-sha",
            repo: { full_name: "acme/repo" },
          },
          base: { sha: "base-sha" },
        },
      }),
    );

    exec.mockImplementation((command, args = []) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return commandResult({
          stdout: JSON.stringify({
            number: 7,
            headRefName: "from-gh",
            baseRefOid: "base-sha",
            headRefOid: "head-sha",
            headRepository: {
              name: "repo",
              owner: { login: "acme" },
            },
          }),
        });
      }

      if (command === "git") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    detectPackageManager.mockResolvedValue({ name: "npm", agent: "npm" });
    const context = createTestContext([testPackage("@acme/core", "1.0.0")], cwd);
    const draft = await createDraftPlan([], context);
    const body = await buildPrPreview(context, draft, { number: 7 });

    expect(body).toContain(
      "[**Create a changelog →**](https://github.com/acme/repo/new/from-gh?filename=.tegami%2F",
    );
    expect(exec).toHaveBeenCalledWith("gh", [
      "pr",
      "view",
      "7",
      "--repo",
      "acme/repo",
      "--json",
      expect.any(String),
    ]);
  });

  test("requires pull request event or number", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraftPlan([], context);

    await expect(buildPrPreview(context, draft)).rejects.toThrow(
      "A pull request event or --number is required.",
    );
  });

  test("rejects invalid pull request numbers", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraftPlan([], context);

    await expect(buildPrPreview(context, draft, { number: Number.NaN })).rejects.toThrow(
      "--number must be a positive integer.",
    );
  });

  test("lists changelog files added in a pull request", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pr-git-"));
    tempDirs.push(cwd);
    const context = createTestContext([], cwd);
    const eventPath = join(cwd, "event.json");

    await writeFile(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 42,
          head: {
            ref: "feature/test",
            sha: "head-sha",
            repo: { full_name: "acme/repo" },
          },
          base: { sha: "base-sha" },
        },
      }),
    );
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = "acme/repo";

    exec.mockReturnValueOnce(commandResult({ stdout: ".tegami/2026-06-19-core.md\n" }));

    const draft = await createDraftPlan(
      [
        parseChangelogFile(
          "2026-06-19-core.md",
          `---
packages: ["@acme/core"]
---

### Support auto changelogs
`,
        )!,
      ],
      context,
    );

    const body = await buildPrPreview(context, draft);

    expect(body).toContain("#### Changelogs in this PR");
    expect(body).toContain("- `2026-06-19-core.md` — Support auto changelogs");
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMRD", "base-sha...head-sha", "--", ".tegami/"],
      expect.objectContaining({ nodeOptions: { cwd } }),
    );
  });

  test("fails when git cannot list pull request changelog files", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    process.env.GITHUB_EVENT_PATH = join(tmpdir(), "tegami-pr-git-fail-event.json");
    await writeFile(
      process.env.GITHUB_EVENT_PATH,
      JSON.stringify({
        pull_request: {
          number: 1,
          head: {
            ref: "main",
            sha: "head-sha",
            repo: { full_name: "acme/repo" },
          },
          base: { sha: "base-sha" },
        },
      }),
    );

    exec.mockReturnValueOnce(commandResult({ exitCode: 128, stderr: "fatal: bad revision" }));

    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraftPlan([], context);

    await expect(buildPrPreview(context, draft)).rejects.toThrow(
      "Failed to list pull request changelog files: fatal: bad revision",
    );
  });

  test("formats run script commands for the detected package manager", async () => {
    detectPackageManager.mockResolvedValue({ name: "pnpm", agent: "pnpm" });

    await expect(formatRunScriptCommand("/repo", "tegami")).resolves.toBe("pnpm run tegami");
    await expect(formatRunScriptCommand("/repo", "tegami", "npm")).resolves.toBe("npm run tegami");
  });

  test("writes preview artifact markdown", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pr-artifact-"));
    tempDirs.push(cwd);
    const context = createTestContext([testPackage("@acme/core", "1.0.0")], cwd);
    const eventPath = join(cwd, "event.json");

    await writeFile(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 42,
          head: {
            ref: "main",
            sha: "head-sha",
            repo: { full_name: "acme/repo" },
          },
          base: { sha: "base-sha" },
        },
      }),
    );
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = "acme/repo";

    exec.mockReturnValueOnce(commandResult());

    detectPackageManager.mockResolvedValue({ name: "npm", agent: "npm" });
    const draft = await createDraftPlan([], context);
    const body = await buildPrPreview(context, draft);
    const path = join(cwd, "tegami-pr-preview.md");
    await writeFile(path, body);

    await expect(readFile(path, "utf8")).resolves.toBe(body);
  });

  test("builds preview markdown from pending changelogs", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    process.env.GITHUB_EVENT_PATH = join(tmpdir(), "tegami-pr-no-changelog-event.json");
    await writeFile(
      process.env.GITHUB_EVENT_PATH,
      JSON.stringify({
        pull_request: {
          number: 1,
          head: {
            ref: "main",
            sha: "head-sha",
            repo: { full_name: "acme/repo" },
          },
          base: { sha: "base-sha" },
        },
      }),
    );

    exec.mockReturnValueOnce(commandResult());

    detectPackageManager.mockResolvedValue({ name: "npm", agent: "npm" });
    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraftPlan([], context);

    const body = await buildPrPreview(context, draft);

    expect(body).toContain("No changelogs yet");
    expect(body).toContain("npm run tegami");
  });

  test("posts preview comment using workflow run event", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    await setWorkflowRunEvent({ pullRequestNumber: 42 });

    exec.mockImplementation((command, args = []) => {
      if (command === "gh" && args[0] === "api" && args[1]?.includes("/comments")) {
        return commandResult();
      }

      if (command === "gh" && args[0] === "pr" && args[1] === "comment") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    await postPrComment("### Tegami\n");

    expect(exec).toHaveBeenCalledWith("gh", [
      "api",
      "repos/acme/repo/issues/42/comments",
      "--paginate",
      "--jq",
      `[.[] | select(.body | startswith("<!-- tegami -->")) | .id][0] // empty`,
    ]);
    expect(exec).toHaveBeenCalledWith("gh", [
      "pr",
      "comment",
      "42",
      "--body",
      "<!-- tegami -->\n### Tegami\n",
      "--repo",
      "acme/repo",
    ]);
  });

  test("updates the first existing pull request comment", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    await setWorkflowRunEvent({ pullRequestNumber: 42 });

    exec.mockImplementation((command, args = []) => {
      if (command === "gh" && args[0] === "api" && args[1]?.includes("/comments")) {
        return commandResult({ stdout: "12345\n" });
      }

      if (command === "gh" && args[0] === "api" && args[1] === "-X") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    await postPrComment("### Tegami\n");

    expect(exec).toHaveBeenCalledWith("gh", [
      "api",
      "-X",
      "PATCH",
      "repos/acme/repo/issues/comments/12345",
      "--input",
      expect.stringMatching(/body\.json$/),
    ]);
  });

  test("updates comments with special characters using JSON input", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    await setWorkflowRunEvent({ pullRequestNumber: 42 });
    let patchInput = "";

    exec.mockImplementation((command, args = []) => {
      if (command === "gh" && args[0] === "api" && args[1]?.includes("/comments")) {
        return commandResult({ stdout: "12345\n" });
      }

      if (command === "gh" && args[0] === "api" && args[1] === "-X") {
        patchInput = readFileSync(args[5] as string, "utf8");
        return commandResult();
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    const preview = "### Tegami\n\n`code` and key=value\n";
    await postPrComment(preview);

    expect(patchInput).toBe(
      JSON.stringify({ body: "<!-- tegami -->\n### Tegami\n\n`code` and key=value\n" }),
    );
  });
});

type ExecResult = Awaited<ReturnType<typeof x>>;

function commandResult(overrides: Partial<ExecResult> = {}): ReturnType<typeof x> {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  } as unknown as ReturnType<typeof x>;
}

async function setWorkflowRunEvent(options: {
  pullRequestNumber?: number;
  conclusion?: string;
  event?: string;
}) {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-pr-comment-event-"));
  tempDirs.push(cwd);
  const eventPath = join(cwd, "event.json");
  process.env.GITHUB_EVENT_PATH = eventPath;
  await writeFile(
    eventPath,
    JSON.stringify({
      workflow_run: {
        event: options.event ?? "pull_request",
        conclusion: options.conclusion ?? "success",
        pull_requests: options.pullRequestNumber ? [{ number: options.pullRequestNumber }] : [],
      },
    }),
  );
}

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
  return new PrTestPackage(name, version);
}

class PrTestPackage extends WorkspacePackage {
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
