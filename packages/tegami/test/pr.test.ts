import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "package-manager-detector";
import { x } from "tinyexec";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import { createDraft } from "../src/plans/draft";
import { parseChangelogFile } from "../src/changelog/parse";
import type { TegamiContext } from "../src/context";
import type { PackageOptions } from "../src/types";
import * as githubClient from "../src/plugins/github/api";
import { buildPrPreview, postPrComment } from "../src/plugins/github/cli";

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
vi.mock("../src/plugins/github/api", () => ({
  getPullRequest: vi.fn(),
  findIssueCommentByPrefix: vi.fn(),
  updateIssueComment: vi.fn(),
  createIssueComment: vi.fn(),
}));

const detectPackageManager = vi.mocked(detect);
const exec = vi.mocked(x);
const getPullRequest = vi.mocked(githubClient.getPullRequest);
const findIssueCommentByPrefix = vi.mocked(githubClient.findIssueCommentByPrefix);
const updateIssueComment = vi.mocked(githubClient.updateIssueComment);
const createIssueComment = vi.mocked(githubClient.createIssueComment);
const tempDirs: string[] = [];

afterEach(async () => {
  detectPackageManager.mockReset();
  exec.mockReset();
  getPullRequest.mockReset();
  findIssueCommentByPrefix.mockReset();
  updateIssueComment.mockReset();
  createIssueComment.mockReset();
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
    const draft = await createDraft(
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
    expect(body).toContain("| `@acme/core` | minor | `1.0.0` → `1.1.0` |");
    expect(body).toContain("| `@acme/ui` | patch | `2.0.0` → `2.0.1` |");
    expect(body).toContain("#### Changelogs in this PR");
    expect(body).toContain("| `2026-06-19-core.md` | Support auto changelogs |");
    expect(body).not.toContain("2026-06-19-ui.md");
  });

  test("omits release preview when prerelease config matches current version", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pr-prerelease-"));
    tempDirs.push(cwd);
    process.env.GITHUB_REPOSITORY = "acme/repo";
    process.env.GITHUB_EVENT_PATH = join(cwd, "event.json");
    await writeFile(
      process.env.GITHUB_EVENT_PATH,
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

    exec.mockReturnValueOnce(commandResult());

    const context = createTestContext(
      [testPackage("tegami", "1.1.0-alpha.2", { prerelease: "alpha" })],
      cwd,
    );
    const draft = await createDraft([], context);
    const body = await buildPrPreview(context, draft);

    expect(draft.getPackageDraft("npm:tegami")?.type).toBeUndefined();
    expect(body).not.toContain("#### Release preview");
    expect(body).toContain("#### No changelogs yet");
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
    const draft = await createDraft([], context);
    const body = await buildPrPreview(context, draft);

    expect(body).toContain(
      "[**Create a changelog →**](https://github.com/fork-user/repo/new/feature/fork?filename=.tegami%2F",
    );
  });

  test("resolves branch from pull request number", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";

    getPullRequest.mockResolvedValue({
      headRefName: "feature/test",
      baseRefOid: "base-sha",
      headRefOid: "head-sha",
      headRepository: {
        name: "repo",
        owner: { login: "fork-user" },
      },
    });
    exec.mockImplementation(() => commandResult());

    detectPackageManager.mockResolvedValue({ name: "npm", agent: "npm" });
    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraft([], context);
    const body = await buildPrPreview(context, draft, { number: 7 });

    expect(body).toContain(
      "[**Create a changelog →**](https://github.com/fork-user/repo/new/feature/test?filename=.tegami%2F",
    );
    expect(getPullRequest).toHaveBeenCalledWith("acme/repo", 7, undefined);
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

    getPullRequest.mockResolvedValue({
      headRefName: "from-gh",
      baseRefOid: "base-sha",
      headRefOid: "head-sha",
      headRepository: {
        name: "repo",
        owner: { login: "acme" },
      },
    });
    exec.mockImplementation(() => commandResult());

    detectPackageManager.mockResolvedValue({ name: "npm", agent: "npm" });
    const context = createTestContext([testPackage("@acme/core", "1.0.0")], cwd);
    const draft = await createDraft([], context);
    const body = await buildPrPreview(context, draft, { number: 7 });

    expect(body).toContain(
      "[**Create a changelog →**](https://github.com/acme/repo/new/from-gh?filename=.tegami%2F",
    );
    expect(getPullRequest).toHaveBeenCalledWith("acme/repo", 7, undefined);
  });

  test("requires pull request event or number", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraft([], context);

    await expect(buildPrPreview(context, draft)).rejects.toThrow(
      "A pull request event or --number is required.",
    );
  });

  test("rejects invalid pull request numbers", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraft([], context);

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

    const draft = await createDraft(
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
    expect(body).toContain("| `2026-06-19-core.md` | Support auto changelogs |");
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
    const draft = await createDraft([], context);

    await expect(buildPrPreview(context, draft)).rejects.toThrow(
      "Failed to list pull request changelog files.",
    );
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
    const draft = await createDraft([], context);
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
    const draft = await createDraft([], context);

    const body = await buildPrPreview(context, draft);

    expect(body).toContain("No changelogs yet");
    expect(body).toContain("npm run tegami");
  });

  test("posts preview comment using workflow run event", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    await setWorkflowRunEvent({ pullRequestNumber: 42 });

    findIssueCommentByPrefix.mockResolvedValue(undefined);
    createIssueComment.mockResolvedValue(undefined);

    await postPrComment(createTestContext([]), "### Tegami\n");

    expect(findIssueCommentByPrefix).toHaveBeenCalledWith(
      "acme/repo",
      42,
      "<!-- tegami -->",
      undefined,
    );
    expect(createIssueComment).toHaveBeenCalledWith(
      "acme/repo",
      42,
      "<!-- tegami -->\n### Tegami\n",
      undefined,
    );
  });

  test("updates the first existing pull request comment", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    await setWorkflowRunEvent({ pullRequestNumber: 42 });

    findIssueCommentByPrefix.mockResolvedValue(12345);
    updateIssueComment.mockResolvedValue(undefined);

    await postPrComment(createTestContext([]), "### Tegami\n");

    expect(updateIssueComment).toHaveBeenCalledWith(
      "acme/repo",
      12345,
      "<!-- tegami -->\n### Tegami\n",
      undefined,
    );
    expect(createIssueComment).not.toHaveBeenCalled();
  });

  test("updates comments with special characters using JSON input", async () => {
    process.env.GITHUB_REPOSITORY = "acme/repo";
    await setWorkflowRunEvent({ pullRequestNumber: 42 });

    findIssueCommentByPrefix.mockResolvedValue(12345);
    updateIssueComment.mockResolvedValue(undefined);

    const preview = "### Tegami\n\n`code` and key=value\n";
    await postPrComment(createTestContext([]), preview);

    expect(updateIssueComment).toHaveBeenCalledWith(
      "acme/repo",
      12345,
      "<!-- tegami -->\n### Tegami\n\n`code` and key=value\n",
      undefined,
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
    lockPath: join(root, ".tegami", "publish-lock.yaml"),
    options: {},
    plugins: [],
    github: {
      repo: "acme/repo",
    },
    graph: new PackageGraph(packages),
  };
}

function testPackage(name: string, version: string, options?: PackageOptions): WorkspacePackage {
  return new PrTestPackage(name, version, options);
}

class PrTestPackage extends WorkspacePackage {
  readonly manager = "npm";

  constructor(
    readonly name: string,
    readonly version: string,
    options?: PackageOptions,
  ) {
    super();
    if (options) this.setPackageOptions(options);
  }

  get path() {
    return `/repo/packages/${this.name}`;
  }
}
