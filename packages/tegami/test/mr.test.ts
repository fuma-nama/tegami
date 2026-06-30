import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x } from "tinyexec";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseChangelogFile } from "../src/changelog/parse";
import type { TegamiContext } from "../src/context";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import { buildMrPreview, postMrComment } from "../src/plugins/gitlab/cli";
import { createDraft } from "../src/plans/draft";
import * as gitlabClient from "../src/plugins/gitlab/api";

vi.mock("package-manager-detector", () => ({
  resolveCommand: vi.fn((agent: string, command: string, args: string[]) => {
    if (command !== "run") return null;
    if (agent === "pnpm") return { command: "pnpm", args: ["run", ...args] };
    return { command: "npm", args: ["run", ...args] };
  }),
}));
vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));
vi.mock("../src/plugins/gitlab/api", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getMergeRequest: vi.fn(),
  findMergeRequestCommentByPrefix: vi.fn(),
  updateMergeRequestComment: vi.fn(),
  createMergeRequestComment: vi.fn(),
}));

const exec = vi.mocked(x);
const getMergeRequest = vi.mocked(gitlabClient.getMergeRequest);
const findMergeRequestCommentByPrefix = vi.mocked(gitlabClient.findMergeRequestCommentByPrefix);
const updateMergeRequestComment = vi.mocked(gitlabClient.updateMergeRequestComment);
const createMergeRequestComment = vi.mocked(gitlabClient.createMergeRequestComment);
const tempDirs: string[] = [];

afterEach(async () => {
  exec.mockReset();
  getMergeRequest.mockReset();
  findMergeRequestCommentByPrefix.mockReset();
  updateMergeRequestComment.mockReset();
  createMergeRequestComment.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  delete process.env.CI_PROJECT_PATH;
  delete process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
  delete process.env.CI_MERGE_REQUEST_SOURCE_PROJECT_PATH;
  delete process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
  delete process.env.CI_MERGE_REQUEST_IID;
  delete process.env.CI_COMMIT_SHA;
});

const testGitLabApi = { apiUrl: "https://gitlab.com/api/v4" };

describe("mr", () => {
  test("renders release preview from GitLab merge request environment", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-mr-preview-"));
    tempDirs.push(cwd);
    process.env.CI_PROJECT_PATH = "acme/repo";
    process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = "feature/release";
    process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA = "base-sha";
    process.env.CI_COMMIT_SHA = "head-sha";

    exec.mockReturnValueOnce(commandResult({ stdout: ".tegami/2026-06-29-core.md\n" }));

    const context = createTestContext([testPackage("@acme/core", "1.0.0")], cwd);
    const draft = await createDraft(
      [
        parseChangelogFile(
          "2026-06-29-core.md",
          `---
packages: ["@acme/core"]
---

## Support release previews
`,
        )!,
      ],
      context,
    );

    const body = await buildMrPreview(context, draft);

    expect(body).toContain("### Tegami");
    expect(body).toContain(
      "[**Create a changelog →**](https://gitlab.com/acme/repo/-/new/feature/release?file_name=.tegami%2F",
    );
    expect(body).toContain("| `@acme/core` | minor | `1.0.0` → `1.1.0` |");
    expect(body).toContain("#### Changelogs in this MR");
    expect(body).toContain("| `2026-06-29-core.md` | Support release previews |");
  });

  test("resolves merge request metadata from number", async () => {
    process.env.CI_PROJECT_PATH = "acme/repo";
    getMergeRequest.mockResolvedValue({
      sourceBranch: "feature/test",
      sourceProjectPath: "fork/repo",
      baseSha: "base-sha",
      headSha: "head-sha",
    });
    exec.mockReturnValueOnce(commandResult());

    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraft([], context);
    const body = await buildMrPreview(context, draft, { number: 7 });

    expect(body).toContain(
      "[**Create a changelog →**](https://gitlab.com/fork/repo/-/new/feature/test?file_name=.tegami%2F",
    );
    expect(getMergeRequest).toHaveBeenCalledWith("acme/repo", 7, testGitLabApi);
  });

  test("requires merge request event or number", async () => {
    process.env.CI_PROJECT_PATH = "acme/repo";
    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraft([], context);

    await expect(buildMrPreview(context, draft)).rejects.toThrow(
      "A merge request event or --number is required.",
    );
  });

  test("lists changelog files added in a merge request", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-mr-git-"));
    tempDirs.push(cwd);
    process.env.CI_PROJECT_PATH = "acme/repo";
    process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = "feature/test";
    process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA = "base-sha";
    process.env.CI_COMMIT_SHA = "head-sha";

    exec.mockReturnValueOnce(commandResult({ stdout: ".tegami/2026-06-29-core.md\n" }));

    const context = createTestContext([], cwd);
    const draft = await createDraft(
      [
        parseChangelogFile(
          "2026-06-29-core.md",
          `---
packages: ["@acme/core"]
---

### Support release previews
`,
        )!,
      ],
      context,
    );

    const body = await buildMrPreview(context, draft);

    expect(body).toContain("#### Changelogs in this MR");
    expect(body).toContain("| `2026-06-29-core.md` | Support release previews |");
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMRD", "base-sha...head-sha", "--", ".tegami/"],
      expect.objectContaining({ nodeOptions: { cwd } }),
    );
  });

  test("fails when git cannot list merge request changelog files", async () => {
    process.env.CI_PROJECT_PATH = "acme/repo";
    process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = "main";
    process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA = "base-sha";
    process.env.CI_COMMIT_SHA = "head-sha";
    exec.mockReturnValueOnce(commandResult({ exitCode: 128, stderr: "fatal: bad revision" }));

    const context = createTestContext([testPackage("@acme/core", "1.0.0")]);
    const draft = await createDraft([], context);

    await expect(buildMrPreview(context, draft)).rejects.toThrow(
      "Failed to list merge request changelog files.",
    );
  });

  test("creates a merge request comment when none exists", async () => {
    process.env.CI_PROJECT_PATH = "acme/repo";
    process.env.CI_MERGE_REQUEST_IID = "42";
    findMergeRequestCommentByPrefix.mockResolvedValue(undefined);
    createMergeRequestComment.mockResolvedValue(undefined);

    await postMrComment(createTestContext([]), "### Tegami\n");

    expect(createMergeRequestComment).toHaveBeenCalledWith(
      "acme/repo",
      42,
      "<!-- tegami -->\n### Tegami\n",
      testGitLabApi,
    );
    expect(updateMergeRequestComment).not.toHaveBeenCalled();
  });

  test("updates the first existing merge request comment", async () => {
    process.env.CI_PROJECT_PATH = "acme/repo";
    process.env.CI_MERGE_REQUEST_IID = "42";
    findMergeRequestCommentByPrefix.mockResolvedValue(12345);
    updateMergeRequestComment.mockResolvedValue(undefined);

    await postMrComment(createTestContext([]), "### Tegami\n");

    expect(updateMergeRequestComment).toHaveBeenCalledWith(
      "acme/repo",
      42,
      12345,
      "<!-- tegami -->\n### Tegami\n",
      testGitLabApi,
    );
    expect(createMergeRequestComment).not.toHaveBeenCalled();
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

function createTestContext(packages: WorkspacePackage[], cwd?: string): TegamiContext {
  const root = cwd ?? "/repo";

  return {
    cwd: root,
    changelogDir: join(root, ".tegami"),
    lockPath: join(root, ".tegami", "publish-lock.yaml"),
    options: {},
    plugins: [],
    graph: new PackageGraph(packages),
    gitlab: {
      repo: process.env.CI_PROJECT_PATH,
      apiUrl: "https://gitlab.com/api/v4",
      webUrl: "https://gitlab.com",
    },
  };
}

function testPackage(name: string, version: string): WorkspacePackage {
  return new MrTestPackage(name, version);
}

class MrTestPackage extends WorkspacePackage {
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
