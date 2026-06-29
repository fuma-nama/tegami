import { x } from "tinyexec";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChangelogEntry } from "../src/changelog/parse";
import { Draft } from "../src/plans/draft";
import type { PackagePublishPlan, PackagePublishResult, PublishPlan } from "../src/plans/publish";
import * as gitlabClient from "../src/plugins/gitlab/api";
import { tegami } from "../src";
import { gitlab } from "../src/plugins/gitlab";
import type { TegamiContext } from "../src/context";
import type { PublishPreflight, TegamiPlugin } from "../src/types";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import { somePromise } from "../src/utils/common";
import { createTegamiCliRegistry } from "../src/cli/core";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

vi.mock("../src/plugins/gitlab/api", () => ({
  gitlabWebUrl: vi.fn((webUrl = "https://gitlab.com") => webUrl.replace(/\/+$/, "")),
  releaseExistsByTag: vi.fn(),
  createRelease: vi.fn(),
  findOpenMergeRequest: vi.fn(),
  updateMergeRequest: vi.fn(),
  createMergeRequest: vi.fn(),
  listMergeRequestsForCommit: vi.fn(),
}));

const exec = vi.mocked(x);
const releaseExistsByTag = vi.mocked(gitlabClient.releaseExistsByTag);
const createGitLabRelease = vi.mocked(gitlabClient.createRelease);
const findOpenMergeRequest = vi.mocked(gitlabClient.findOpenMergeRequest);
const updateMergeRequest = vi.mocked(gitlabClient.updateMergeRequest);
const createMergeRequest = vi.mocked(gitlabClient.createMergeRequest);
const listMergeRequestsForCommit = vi.mocked(gitlabClient.listMergeRequestsForCommit);
const testToken = { value: "test-token", type: "private-token" as const };

beforeEach(() => {
  exec.mockReset();
  exec.mockImplementation(() => commandResult());
  releaseExistsByTag.mockReset();
  releaseExistsByTag.mockResolvedValue(false);
  createGitLabRelease.mockReset();
  createGitLabRelease.mockResolvedValue(undefined);
  findOpenMergeRequest.mockReset();
  findOpenMergeRequest.mockResolvedValue(undefined);
  updateMergeRequest.mockReset();
  updateMergeRequest.mockResolvedValue(undefined);
  createMergeRequest.mockReset();
  createMergeRequest.mockResolvedValue(undefined);
  listMergeRequestsForCommit.mockReset();
  listMergeRequestsForCommit.mockResolvedValue([]);
});

describe("gitlab release plugin", () => {
  test("creates GitLab releases for successful published packages", async () => {
    const plugin = gitlabPlugin({
      repo: "acme/repo",
      release: {
        create({ pkg, plan }) {
          const packagePlan = plan.packages.get(pkg.id);
          return {
            title: `Release ${pkg.version}`,
            notes: `Notes for ${pkg.name}`,
          };
        },
      },
    });

    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/no-tag")]);
    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        { npm: { distTag: "alpha" } },
        { name: "@acme/no-tag", git: undefined },
      ]),
    });

    expect(releaseExistsByTag).toHaveBeenCalledWith("acme/repo", "@acme/core@1.0.1", {
      token: testToken,
    });
    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "Release 1.0.1",
      notes: "Notes for @acme/core",
      token: testToken,
    });
  });

  test("skips GitLab release creation when the release already exists", async () => {
    releaseExistsByTag.mockResolvedValue(true);

    const plugin = gitlabPlugin({ repo: "acme/repo" });

    const context = {
      ...publishContext(),
      gitlab: { repo: "acme/repo", token: testToken },
    };

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [{}]),
    });

    expect(releaseExistsByTag).toHaveBeenCalledWith("acme/repo", "@acme/core@1.0.1", {
      token: testToken,
    });
    expect(createGitLabRelease).not.toHaveBeenCalled();
  });

  test("skips default release note work when the release already exists", async () => {
    releaseExistsByTag.mockResolvedValue(true);
    exec.mockImplementation((command, args = []) => {
      if (command === "git" && args[0] === "log") {
        throw new Error("git log should not run for an existing release");
      }

      return commandResult();
    });

    const plugin = gitlabPlugin({ repo: "acme/repo" });
    const context = publishContext();

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        {
          changelogs: [
            testChangelogEntry({
              sections: [{ title: "Add proxy server", content: "Some description.", depth: 2 }],
            }),
          ],
        },
      ]),
    });

    expect(createGitLabRelease).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  test("does not create releases when release is disabled", async () => {
    const plugin = gitlabPlugin({ repo: "acme/repo", release: false });
    const context = publishContext();

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [{}]),
    });

    expect(releaseExistsByTag).not.toHaveBeenCalled();
    expect(createGitLabRelease).not.toHaveBeenCalled();
  });

  test("returns pending from resolvePlanStatus when a release is missing", async () => {
    releaseExistsByTag.mockResolvedValue(false);
    const plugin = gitlabPlugin({ repo: "acme/repo" });
    const context = publishContext();

    const status = await plugin.resolvePlanStatus?.call(context, {
      plan: releasePlan(context, [{}]),
    });

    expect(Array.isArray(status)).toBe(true);
    expect(
      await somePromise(status as Promise<"pending" | undefined>[], (v) => v === "pending"),
    ).toBe(true);
  });

  test("ignores missing releases when npm preflight is complete", async () => {
    releaseExistsByTag.mockResolvedValue(false);
    const plugin = gitlabPlugin({ repo: "acme/repo" });
    const context = publishContext();

    await expect(
      plugin.resolvePlanStatus?.call(context, {
        plan: releasePlan(context, [{ preflight: { shouldPublish: false } }]),
      }),
    ).resolves.toEqual([]);

    expect(releaseExistsByTag).not.toHaveBeenCalled();
  });

  test("creates releases eagerly when another package failed", async () => {
    const plugin = gitlabPlugin({
      repo: "acme/repo",
      release: { eager: true },
    });
    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        {},
        { name: "@acme/ui", publishResult: { type: "failed", error: "publish failed" } },
      ]),
    });

    expect(createGitLabRelease).toHaveBeenCalledTimes(1);
  });

  test("does not create releases when any package failed", async () => {
    const plugin = gitlabPlugin();

    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        {},
        { name: "@acme/ui", publishResult: { type: "failed", error: "publish failed" } },
      ]),
    });

    expect(releaseExistsByTag).not.toHaveBeenCalled();
    expect(createGitLabRelease).not.toHaveBeenCalled();
  });

  test("creates GitLab releases for skipped publish results", async () => {
    const plugin = gitlabPlugin({ repo: "acme/repo" });
    const context = publishContext();

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [{ publishResult: { type: "skipped" } }]),
    });

    expect(releaseExistsByTag).toHaveBeenCalledWith("acme/repo", "@acme/core@1.0.1", {
      token: testToken,
    });
    expect(createGitLabRelease).toHaveBeenCalledTimes(1);
  });

  test("uses changelog entries for default notes", async () => {
    const plugin = gitlabPlugin();

    const context = publishContext();
    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        {
          changelogs: [
            testChangelogEntry({
              packages: new Map([["@acme/core", { type: "minor" }]]),
              sections: [{ title: "Add proxy server", content: "Some description.", depth: 2 }],
            }),
          ],
        },
      ]),
    });

    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "@acme/core@1.0.1",
      notes: "### Add proxy server\n\nSome description.",
      token: testToken,
    });
  });

  test("links changelog entry commits in default release notes", async () => {
    exec.mockImplementation((command, args = []) => {
      if (command === "git" && args[0] === "log") {
        return commandResult({
          stdout: "abc1234567890abcdef1234567890abcdef123456\n",
        });
      }

      return commandResult();
    });

    const plugin = gitlabPlugin({ repo: "acme/repo" });

    const context = {
      ...publishContext(),
      gitlab: { repo: "acme/repo", token: testToken },
    };

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        {
          changelogs: [
            testChangelogEntry({
              packages: new Map([["@acme/core", { type: "minor" }]]),
              sections: [{ title: "Add proxy server", content: "Some description.", depth: 2 }],
            }),
          ],
        },
      ]),
    });

    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "@acme/core@1.0.1",
      notes:
        "### Add proxy server ([abc1234](https://gitlab.com/acme/repo/-/commit/abc1234567890abcdef1234567890abcdef123456))\n\nSome description.",
      token: testToken,
    });
  });

  test("shows related merge requests and contributors in release notes", async () => {
    exec.mockImplementation((command, args = []) => {
      if (command === "git" && args[0] === "log") {
        return commandResult({
          stdout: "abc1234567890abcdef1234567890abcdef123456\n",
        });
      }

      return commandResult();
    });
    listMergeRequestsForCommit.mockResolvedValue([
      { number: 42, title: "Add proxy server", user: { login: "alice" } },
    ]);

    const plugin = gitlabPlugin({ repo: "acme/repo" });
    const context = {
      ...publishContext(),
      gitlab: { repo: "acme/repo", token: testToken },
    };

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        {
          changelogs: [
            testChangelogEntry({
              packages: new Map([["@acme/core", { type: "minor" }]]),
              sections: [{ title: "Add proxy server", content: "Some description.", depth: 2 }],
            }),
          ],
        },
      ]),
    });

    expect(listMergeRequestsForCommit).toHaveBeenCalledWith(
      "acme/repo",
      "abc1234567890abcdef1234567890abcdef123456",
      { token: testToken },
    );
    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "@acme/core@1.0.1",
      notes:
        "### Add proxy server ([abc1234](https://gitlab.com/acme/repo/-/commit/abc1234567890abcdef1234567890abcdef123456))\n\nSome description.\n\n<details>\n<summary>Merge request & contributors</summary>\n\n- [!42 Add proxy server](https://gitlab.com/acme/repo/-/merge_requests/42) by @alice\n\n</details>",
      token: testToken,
    });
  });

  test("creates GitLab releases for semver prerelease versions", async () => {
    const plugin = gitlabPlugin({ repo: "acme/repo" });

    const context = publishContext();
    const pkg = context.graph.get("test:@acme/core") as TestPackage;
    pkg.setVersion("1.0.1-beta.0");

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        {
          git: { tag: "@acme/core@1.0.1-beta.0" },
        },
      ]),
    });

    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1-beta.0",
      title: "@acme/core@1.0.1-beta.0",
      notes: "Published @acme/core@1.0.1-beta.0.",
      token: testToken,
    });
  });

  test("summarizes all packages sharing a git tag in release notes", async () => {
    const plugin = gitlabPlugin({ repo: "acme/repo" });

    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);
    const sharedChangelog = testChangelogEntry({
      packages: new Map([["group:acme", { type: "minor" }]]),
      sections: [{ title: "Add shared API", content: "Useful release note.", depth: 2 }],
    });

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        { name: "@acme/core", git: { tag: "acme@1.0.1" }, changelogs: [sharedChangelog] },
        { name: "@acme/ui", git: { tag: "acme@1.0.1" }, changelogs: [sharedChangelog] },
      ]),
    });

    expect(releaseExistsByTag).toHaveBeenCalledTimes(1);
    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "acme@1.0.1",
      title: "acme@1.0.1",
      notes: "- @acme/core@1.0.1\n- @acme/ui@1.0.1\n\n### Add shared API\n\nUseful release note.",
      token: testToken,
    });
  });

  test("reuses changelog commit lookups across package releases", async () => {
    exec.mockImplementation((command, args = []) => {
      if (command === "git" && args[0] === "log") {
        return commandResult({
          stdout: "abc1234567890abcdef1234567890abcdef123456\n",
        });
      }

      return commandResult();
    });

    const plugin = gitlabPlugin({ repo: "acme/repo" });
    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);
    const sharedChangelog = testChangelogEntry({
      sections: [{ title: "Add shared API", content: "Useful release note.", depth: 2 }],
    });

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        { name: "@acme/core", changelogs: [sharedChangelog] },
        { name: "@acme/ui", changelogs: [sharedChangelog] },
      ]),
    });

    expect(exec.mock.calls.filter(([, args]) => args?.at(0) === "log")).toHaveLength(1);
    expect(createGitLabRelease).toHaveBeenCalledTimes(2);
  });

  test("uses release.createGrouped for packages sharing a git tag", async () => {
    const plugin = gitlabPlugin({
      repo: "acme/repo",
      release: {
        createGrouped({ packages }) {
          return {
            title: `Group release ${packages[0]!.name}`,
            notes: packages.map((pkg) => pkg.name).join(", "),
          };
        },
        create() {
          throw new Error("release.create should not be called for grouped releases");
        },
      },
    });

    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        { name: "@acme/core", git: { tag: "acme@1.0.1" } },
        { name: "@acme/ui", git: { tag: "acme@1.0.1" } },
      ]),
    });

    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "acme@1.0.1",
      title: "Group release @acme/core",
      notes: "@acme/core, @acme/ui",
      token: testToken,
    });
  });
});

describe("gitlab version merge request", () => {
  test("configures git remote during cli.init in CI", async () => {
    const previousCi = process.env.CI;
    const previousToken = process.env.GITLAB_TOKEN;
    process.env.CI = "true";
    process.env.GITLAB_TOKEN = "test-token";

    try {
      const plugin = gitlabPlugin({ repo: "acme/repo" });
      const context = publishContext();
      exec.mockImplementation(() => commandResult());

      await plugin.init?.call(context);
      await plugin.initCli?.call(context, createTegamiCliRegistry(tegami({ cwd: "/repo" })));

      expect(exec).toHaveBeenCalledWith(
        "git",
        ["remote", "set-url", "origin", "https://oauth2:test-token@gitlab.com/acme/repo.git"],
        { nodeOptions: { cwd: "/repo" } },
      );
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;

      if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = previousToken;
    }
  });

  test("uses GitLab CI job token credentials during cli.init in CI", async () => {
    const previousCi = process.env.CI;
    const previousGitLabToken = process.env.GITLAB_TOKEN;
    const previousGlToken = process.env.GL_TOKEN;
    const previousJobToken = process.env.CI_JOB_TOKEN;
    process.env.CI = "true";
    delete process.env.GITLAB_TOKEN;
    delete process.env.GL_TOKEN;
    process.env.CI_JOB_TOKEN = "job-token";

    try {
      const plugin = gitlabPlugin({ repo: "acme/repo" });
      const context = publishContext();
      exec.mockImplementation(() => commandResult());

      await plugin.init?.call(context);
      await plugin.initCli?.call(context, createTegamiCliRegistry(tegami({ cwd: "/repo" })));

      expect(context.gitlab?.token).toEqual({ value: "job-token", type: "job-token" });
      expect(exec).toHaveBeenCalledWith(
        "git",
        [
          "remote",
          "set-url",
          "origin",
          "https://gitlab-ci-token:job-token@gitlab.com/acme/repo.git",
        ],
        { nodeOptions: { cwd: "/repo" } },
      );
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;

      if (previousGitLabToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = previousGitLabToken;

      if (previousGlToken === undefined) delete process.env.GL_TOKEN;
      else process.env.GL_TOKEN = previousGlToken;

      if (previousJobToken === undefined) delete process.env.CI_JOB_TOKEN;
      else process.env.CI_JOB_TOKEN = previousJobToken;
    }
  });

  test("updates an existing version merge request in CI", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = gitlabPlugin({ repo: "acme/repo" });
      const context = publishContext([testPackage("@acme/core", "1.0.0")]);
      const draft = versionDraft(context);

      exec.mockImplementation((command, args = []) => {
        if (command === "git" && args[0] === "status") {
          return commandResult({ stdout: " M package.json\n" });
        }

        if (command === "git") {
          return commandResult();
        }

        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      });
      findOpenMergeRequest.mockResolvedValue(42);

      await runVersionMergeRequest(plugin, context, draft);

      expect(updateMergeRequest).toHaveBeenCalledWith("acme/repo", 42, {
        title: "Version Packages",
        body: expect.stringContaining("Merge this MR to publish the versioned packages."),
        base: "main",
        token: testToken,
      });
      expect(findOpenMergeRequest).toHaveBeenCalledWith("acme/repo", {
        head: "tegami/version-packages",
        base: "main",
        token: testToken,
      });
      expect(createMergeRequest).not.toHaveBeenCalled();
      expect(exec.mock.calls.map(normalizeExecCall)).toMatchInlineSnapshot(`
        [
          {
            "args": [
              "status",
              "--porcelain",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
          {
            "args": [
              "checkout",
              "-B",
              "tegami/version-packages",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
          {
            "args": [
              "add",
              "-A",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
          {
            "args": [
              "commit",
              "-m",
              "Version Packages",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
          {
            "args": [
              "push",
              "--force",
              "-u",
              "origin",
              "tegami/version-packages",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
        ]
      `);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("creates a version merge request in CI when there are changes", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = gitlabPlugin({ repo: "acme/repo" });
      const context = publishContext([testPackage("@acme/core", "1.0.0")]);
      const draft = versionDraft(context);

      exec.mockImplementation((command, args = []) => {
        if (command === "git" && args[0] === "status") {
          return commandResult({ stdout: " M package.json\n" });
        }

        if (command === "git") {
          return commandResult();
        }

        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      });

      await runVersionMergeRequest(plugin, context, draft);

      expect(createMergeRequest).toHaveBeenCalledWith("acme/repo", {
        title: "Version Packages",
        body: expect.stringContaining("| `@acme/core` | `1.0.0` | `1.1.0` |"),
        head: "tegami/version-packages",
        base: "main",
        token: testToken,
      });
      expect(exec.mock.calls.map(normalizeExecCall)).toMatchInlineSnapshot(`
        [
          {
            "args": [
              "status",
              "--porcelain",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
          {
            "args": [
              "checkout",
              "-B",
              "tegami/version-packages",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
          {
            "args": [
              "add",
              "-A",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
          {
            "args": [
              "commit",
              "-m",
              "Version Packages",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
          {
            "args": [
              "push",
              "--force",
              "-u",
              "origin",
              "tegami/version-packages",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
        ]
      `);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("skips version merge requests outside CI by default", async () => {
    const previousCi = process.env.CI;
    delete process.env.CI;

    try {
      const plugin = gitlabPlugin();
      const context = publishContext();
      await runVersionMergeRequest(plugin, context, versionDraft(context));
      expect(exec).not.toHaveBeenCalled();
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("creates a version merge request outside CI when enabled explicitly", async () => {
    const previousCi = process.env.CI;
    delete process.env.CI;

    try {
      const plugin = gitlabPlugin({
        repo: "acme/repo",
        versionMr: { forceCreate: true },
      });
      const context = publishContext();

      exec.mockImplementation((command, args = []) => {
        if (command === "git" && args[0] === "status") {
          return commandResult({ stdout: " M package.json\n" });
        }

        if (command === "git") {
          return commandResult();
        }

        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      });

      await runVersionMergeRequest(plugin, context, versionDraft(context));

      expect(createMergeRequest).toHaveBeenCalled();
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });
});

function gitlabPlugin(options?: Parameters<typeof gitlab>[0]): TegamiPlugin {
  const plugin = gitlab(options).find((plugin) => plugin.name === "gitlab");
  if (!plugin) throw new Error("GitLab plugin not found.");
  return plugin;
}

function publishContext(packages: TestPackage[] = [testPackage()]): TegamiContext {
  return {
    cwd: "/repo",
    changelogDir: "/repo/.tegami",
    lockPath: "/repo/.tegami/publish-lock.yaml",
    options: {},
    plugins: [],
    graph: new PackageGraph(packages),
    gitlab: { repo: "acme/repo", token: testToken },
  };
}

function testPackage(name = "@acme/core", version = "1.0.1"): TestPackage {
  return new TestPackage(name, version);
}

class TestPackage extends WorkspacePackage {
  readonly path: string;
  readonly manager = "test";
  readonly publish = true;

  #version: string;

  constructor(
    readonly name: string,
    version = "1.0.1",
  ) {
    super();
    this.#version = version;
    this.path = `/repo/packages/${name.replace("@", "").replace("/", "-")}`;
  }

  get version() {
    return this.#version;
  }

  setVersion(version: string): void {
    this.#version = version;
  }

  async write(): Promise<void> {}
}

function versionDraft(context = publishContext([testPackage("@acme/core", "1.0.0")])): Draft {
  const draft = new Draft(context);
  draft.addChangelog(
    testChangelogEntry({
      packages: new Map([["@acme/core", { type: "minor" }]]),
      sections: [{ title: "Add feature", content: "Description.", depth: 2 }],
    }),
  );
  return draft;
}

async function runVersionMergeRequest(
  plugin: TegamiPlugin,
  context: ReturnType<typeof publishContext>,
  draft: Draft,
) {
  const pkg = context.graph.get("test:@acme/core");
  if (!(pkg instanceof TestPackage)) throw new Error("missing package");

  await plugin.initCliDraft?.call(context, draft);
  pkg.setVersion("1.1.0");
  await plugin.applyCliDraft?.call(context, draft);
}

function releasePlan(
  context: TegamiContext,
  entries: Array<{
    name?: string;
    npm?: { distTag?: string };
    git?: { tag: string };
    preflight?: PublishPreflight;
    publishResult?: PackagePublishResult;
    changelogs?: ChangelogEntry[];
  }>,
): PublishPlan {
  const packages = new Map<string, PackagePublishPlan>();

  for (const entry of entries) {
    const name = entry.name ?? "@acme/core";
    const id = `test:${name}`;
    const pkg = context.graph.get(id);
    if (!pkg) throw new Error(`missing package ${id}`);

    packages.set(id, {
      changelogs: entry.changelogs ?? [],
      updated: true,
      git: "git" in entry ? entry.git : { tag: `${name}@${pkg.version}` },
      npm: entry.npm ?? { distTag: "latest" },
      preflight: entry.preflight ?? { shouldPublish: true },
      publishResult: entry.publishResult ?? { type: "published" },
    });
  }

  return {
    options: {},
    changelogs: new Map(),
    packages,
  };
}

function testChangelogEntry(overrides: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    id: "change-1",
    filename: "change.md",
    packages: new Map(),
    sections: [],
    getRawContent: () => "",
    ...overrides,
  };
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

function normalizeExecCall([command, args, options]: Parameters<typeof x>) {
  return {
    command,
    args,
    cwd: typeof options?.nodeOptions?.cwd === "string" ? options.nodeOptions.cwd : undefined,
    throwOnError: options?.throwOnError,
  };
}
