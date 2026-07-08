import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChangelogEntry } from "../src/changelog/parse";
import { Draft } from "../src/plans/draft";
import type { PackagePublishPlan, PackagePublishResult, PublishPlan } from "../src/plans/publish";
import { PublishLock } from "../src/plans/lock";
import * as gitlabClient from "../src/plugins/gitlab/api";
import { tegami } from "../src";
import { gitlab } from "../src/plugins/gitlab";
import type { TegamiContext } from "../src/context";
import type { PublishPreflight, TegamiPlugin } from "../src/types";
import { PackageGraph, WorkspacePackage } from "../src/graph";
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
const testGitLabApi = {
  apiUrl: "https://gitlab.com/api/v4",
  token: testToken,
};
const testGitlab = {
  repo: "acme/repo",
  ...testGitLabApi,
  webUrl: "https://gitlab.com",
} satisfies NonNullable<TegamiContext["gitlab"]>;
const releasePluginOptions = { repo: "acme/repo", token: "test-token" } as const;
const tempDirs: string[] = [];

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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("gitlab release plugin", () => {
  test("creates GitLab releases for successful published packages", async () => {
    const plugins = gitlabPlugin({
      ...releasePluginOptions,
      release: {
        create({ pkg }) {
          return {
            title: `Release ${pkg.version}`,
            notes: `Notes for ${pkg.name}`,
          };
        },
      },
    });

    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/no-tag")]);
    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [
        { npm: { distTag: "alpha" } },
        { name: "@acme/no-tag", git: undefined },
      ]),
    );

    expect(releaseExistsByTag).toHaveBeenCalledWith("acme/repo", "@acme/core@1.0.1", testGitLabApi);
    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "Release 1.0.1",
      notes: "Notes for @acme/core",
      apiUrl: "https://gitlab.com/api/v4",
      token: testToken,
    });
  });

  test("skips GitLab release creation when the release already exists", async () => {
    releaseExistsByTag.mockResolvedValue(true);

    const plugins = gitlabPlugin(releasePluginOptions);

    const context = {
      ...publishContext(),
      gitlab: testGitlab,
    };

    await runAfterPublishAll(plugins, context, releasePlan(context, [{}]));

    expect(releaseExistsByTag).toHaveBeenCalledWith("acme/repo", "@acme/core@1.0.1", testGitLabApi);
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

    const plugins = gitlabPlugin({ ...releasePluginOptions, createTags: false });
    const context = publishContext();

    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [
        {
          changelogs: [
            testChangelogEntry({
              sections: [{ title: "Add proxy server", content: "Some description.", depth: 2 }],
            }),
          ],
        },
      ]),
    );

    expect(createGitLabRelease).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  test("does not create releases when release is disabled", async () => {
    const plugins = gitlabPlugin({ ...releasePluginOptions, release: false });
    const context = publishContext();

    await runAfterPublishAll(plugins, context, releasePlan(context, [{}]));

    expect(releaseExistsByTag).not.toHaveBeenCalled();
    expect(createGitLabRelease).not.toHaveBeenCalled();
  });

  test("returns pending from resolvePlanStatus when a release is missing", async () => {
    releaseExistsByTag.mockResolvedValue(false);
    const plugins = gitlabPlugin(releasePluginOptions);
    const context = publishContext();

    await expect(resolvePlanStatus(plugins, context, releasePlan(context, [{}]))).resolves.toBe(
      "pending",
    );
  });

  test("ignores missing releases when npm preflight is complete", async () => {
    releaseExistsByTag.mockResolvedValue(false);
    const plugins = gitlabPlugin(releasePluginOptions);
    const context = publishContext();

    await expect(
      resolvePlanStatus(
        plugins,
        context,
        releasePlan(context, [{ preflight: { shouldPublish: false } }]),
      ),
    ).resolves.toBeUndefined();

    expect(releaseExistsByTag).not.toHaveBeenCalled();
  });

  test("creates releases eagerly when another package failed", async () => {
    const plugins = gitlabPlugin({
      ...releasePluginOptions,
      release: { eager: true },
    });
    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);

    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [
        {},
        { name: "@acme/ui", publishResult: { type: "failed", error: "publish failed" } },
      ]),
    );

    expect(createGitLabRelease).toHaveBeenCalledTimes(1);
  });

  test("does not create releases when any package failed", async () => {
    const plugins = gitlabPlugin(releasePluginOptions);
    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);

    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [
        {},
        { name: "@acme/ui", publishResult: { type: "failed", error: "publish failed" } },
      ]),
    );

    expect(releaseExistsByTag).not.toHaveBeenCalled();
    expect(createGitLabRelease).not.toHaveBeenCalled();
  });

  test("creates GitLab releases for skipped publish results", async () => {
    const plugins = gitlabPlugin(releasePluginOptions);
    const context = publishContext();

    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [{ publishResult: { type: "skipped" } }]),
    );

    expect(releaseExistsByTag).toHaveBeenCalledWith("acme/repo", "@acme/core@1.0.1", testGitLabApi);
    expect(createGitLabRelease).toHaveBeenCalledTimes(1);
  });

  test("uses changelog entries for default notes", async () => {
    const plugins = gitlabPlugin(releasePluginOptions);
    const context = publishContext();

    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [
        {
          changelogs: [
            testChangelogEntry({
              packages: new Map([["@acme/core", { type: "minor" }]]),
              sections: [{ title: "Add proxy server", content: "Some description.", depth: 2 }],
            }),
          ],
        },
      ]),
    );

    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "@acme/core@1.0.1",
      notes: "### Add proxy server\n\nSome description.",
      apiUrl: "https://gitlab.com/api/v4",
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

    const plugins = gitlabPlugin(releasePluginOptions);

    const context = {
      ...publishContext(),
      gitlab: testGitlab,
    };

    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [
        {
          changelogs: [
            testChangelogEntry({
              packages: new Map([["@acme/core", { type: "minor" }]]),
              sections: [{ title: "Add proxy server", content: "Some description.", depth: 2 }],
            }),
          ],
        },
      ]),
    );

    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "@acme/core@1.0.1",
      notes:
        "### Add proxy server ([abc1234](https://gitlab.com/acme/repo/-/commit/abc1234567890abcdef1234567890abcdef123456))\n\nSome description.",
      apiUrl: "https://gitlab.com/api/v4",
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

    const plugins = gitlabPlugin(releasePluginOptions);
    const context = {
      ...publishContext(),
      gitlab: testGitlab,
    };

    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [
        {
          changelogs: [
            testChangelogEntry({
              packages: new Map([["@acme/core", { type: "minor" }]]),
              sections: [{ title: "Add proxy server", content: "Some description.", depth: 2 }],
            }),
          ],
        },
      ]),
    );

    expect(listMergeRequestsForCommit).toHaveBeenCalledWith(
      "acme/repo",
      "abc1234567890abcdef1234567890abcdef123456",
      testGitLabApi,
    );
    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "@acme/core@1.0.1",
      notes:
        "### Add proxy server ([abc1234](https://gitlab.com/acme/repo/-/commit/abc1234567890abcdef1234567890abcdef123456))\n\nSome description.\n\n<details>\n<summary>Merge request & contributors</summary>\n\n- [!42 Add proxy server](https://gitlab.com/acme/repo/-/merge_requests/42) by @alice\n\n</details>",
      apiUrl: "https://gitlab.com/api/v4",
      token: testToken,
    });
  });

  test("creates GitLab releases for semver prerelease versions", async () => {
    const plugins = gitlabPlugin(releasePluginOptions);

    const context = publishContext();
    const pkg = context.graph.get("test:@acme/core") as TestPackage;
    pkg.setVersion("1.0.1-beta.0");

    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [
        {
          git: { tag: "@acme/core@1.0.1-beta.0" },
        },
      ]),
    );

    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1-beta.0",
      title: "@acme/core@1.0.1-beta.0",
      notes: "Published @acme/core@1.0.1-beta.0.",
      apiUrl: "https://gitlab.com/api/v4",
      token: testToken,
    });
  });

  test("summarizes all packages sharing a git tag in release notes", async () => {
    const plugins = gitlabPlugin(releasePluginOptions);

    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);
    const sharedChangelog = testChangelogEntry({
      packages: new Map([["group:acme", { type: "minor" }]]),
      sections: [{ title: "Add shared API", content: "Useful release note.", depth: 2 }],
    });

    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [
        { name: "@acme/core", git: { tag: "acme@1.0.1" }, changelogs: [sharedChangelog] },
        { name: "@acme/ui", git: { tag: "acme@1.0.1" }, changelogs: [sharedChangelog] },
      ]),
    );

    expect(releaseExistsByTag).toHaveBeenCalledTimes(1);
    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "acme@1.0.1",
      title: "acme@1.0.1",
      notes: "- @acme/core@1.0.1\n- @acme/ui@1.0.1\n\n### Add shared API\n\nUseful release note.",
      apiUrl: "https://gitlab.com/api/v4",
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

    const plugins = gitlabPlugin(releasePluginOptions);
    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);
    const sharedChangelog = testChangelogEntry({
      sections: [{ title: "Add shared API", content: "Useful release note.", depth: 2 }],
    });

    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [
        { name: "@acme/core", changelogs: [sharedChangelog] },
        { name: "@acme/ui", changelogs: [sharedChangelog] },
      ]),
    );

    expect(exec.mock.calls.filter(([, args]) => args?.at(0) === "log")).toHaveLength(1);
    expect(createGitLabRelease).toHaveBeenCalledTimes(2);
  });

  test("uses release.createGrouped for packages sharing a git tag", async () => {
    const plugins = gitlabPlugin({
      ...releasePluginOptions,
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

    await runAfterPublishAll(
      plugins,
      context,
      releasePlan(context, [
        { name: "@acme/core", git: { tag: "acme@1.0.1" } },
        { name: "@acme/ui", git: { tag: "acme@1.0.1" } },
      ]),
    );

    expect(createGitLabRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "acme@1.0.1",
      title: "Group release @acme/core",
      notes: "@acme/core, @acme/ui",
      apiUrl: "https://gitlab.com/api/v4",
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
      const plugins = gitlabPlugin(releasePluginOptions);
      const context = publishContext();
      exec.mockImplementation(() => commandResult());

      await runInitCli(plugins, context, createTegamiCliRegistry(tegami({ cwd: "/repo" })));

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
      const plugins = gitlabPlugin({ repo: "acme/repo" });
      const context = publishContext();
      exec.mockImplementation(() => commandResult());

      await runInitCli(plugins, context, createTegamiCliRegistry(tegami({ cwd: "/repo" })));

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
      const plugins = gitlabPlugin(releasePluginOptions);
      const context = publishContext([testPackage("@acme/core", "1.0.0")]);
      const draft = versionDraft(context);

      exec.mockImplementation((command, args = []) => {
        if (command !== "git") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);

        switch (args[0]) {
          case "status":
            return commandResult({ stdout: " M package.json\n" });
          case "show":
            return commandResult({ stdout: "base-commit\n2026-07-04T00:00:00+00:00\n" });
          case "hash-object":
            return commandResult({ stdout: "blob-sha\n" });
          case "write-tree":
            return commandResult({ stdout: "tree-sha\n" });
          case "commit-tree":
            return commandResult({ stdout: "commit-sha\n" });
          default:
            return commandResult();
        }
      });
      findOpenMergeRequest.mockResolvedValue(42);

      await runVersionMergeRequest(plugins, context, draft);

      expect(updateMergeRequest).toHaveBeenCalledWith("acme/repo", 42, {
        title: "Version Packages",
        body: expect.stringContaining("All bumped packages."),
        base: "main",
        apiUrl: "https://gitlab.com/api/v4",
        token: testToken,
      });
      expect(findOpenMergeRequest).toHaveBeenCalledWith("acme/repo", {
        head: "tegami/version-packages",
        base: "main",
        apiUrl: "https://gitlab.com/api/v4",
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
              "--detach",
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
      const plugins = gitlabPlugin(releasePluginOptions);
      const context = publishContext([testPackage("@acme/core", "1.0.0")]);
      const draft = versionDraft(context);

      exec.mockImplementation((command, args = []) => {
        if (command !== "git") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);

        switch (args[0]) {
          case "status":
            return commandResult({ stdout: " M package.json\n" });
          case "show":
            return commandResult({ stdout: "base-commit\n2026-07-04T00:00:00+00:00\n" });
          case "hash-object":
            return commandResult({ stdout: "blob-sha\n" });
          case "write-tree":
            return commandResult({ stdout: "tree-sha\n" });
          case "commit-tree":
            return commandResult({ stdout: "commit-sha\n" });
          default:
            return commandResult();
        }
      });

      await runVersionMergeRequest(plugins, context, draft);

      expect(createMergeRequest).toHaveBeenCalledWith("acme/repo", {
        title: "Version Packages",
        body: expect.stringContaining("| `@acme/core` | `1.0.0` | `1.1.0` |"),
        head: "tegami/version-packages",
        base: "main",
        apiUrl: "https://gitlab.com/api/v4",
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
              "--detach",
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

  test("creates one version merge request per publish group", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const cwd = await mkdtemp(join(tmpdir(), "tegami-gitlab-"));
      tempDirs.push(cwd);

      const plugins = gitlabPlugin({
        repo: "acme/repo",
        versionMr: {
          groups: ["group:test", ["@acme/ui", "@acme/docs"]],
        },
      });
      const context = {
        ...publishContext([
          testPackage("@acme/core", "1.0.0"),
          testPackage("@acme/ui", "1.0.0"),
          testPackage("@acme/docs", "1.0.0"),
          testPackage("@acme/cli", "1.0.0"),
        ]),
        cwd,
        changelogDir: join(cwd, ".tegami"),
        lockPath: join(cwd, ".tegami/publish-lock.yaml"),
      };
      context.graph.registerGroup("test", {});
      context.graph.addGroupMember("test", "test:@acme/core");
      // publish every updated package, so predicted publish plans appear in request bodies
      context.plugins = [
        {
          name: "test-provider",
          publishPreflight: () => ({ shouldPublish: true }),
        },
      ];

      const lock = new PublishLock();
      lock.write("core:packages", { id: "test:@acme/core", updated: true });
      lock.write("core:packages", { id: "test:@acme/ui", updated: true });
      lock.write("core:packages", { id: "test:@acme/docs", updated: true });
      lock.write("core:packages", { id: "test:@acme/cli", updated: true });
      await mkdir(context.changelogDir, { recursive: true });
      await writeFile(context.lockPath, lock.serialize());

      const draft = new Draft(context);
      draft.addChangelog(
        testChangelogEntry({
          packages: new Map([
            ["@acme/core", { type: "minor" }],
            ["@acme/ui", { type: "minor" }],
            ["@acme/docs", { type: "minor" }],
            ["@acme/cli", { type: "minor" }],
          ]),
        }),
      );

      const core = context.graph.get("test:@acme/core");
      const ui = context.graph.get("test:@acme/ui");
      const docs = context.graph.get("test:@acme/docs");
      const cli = context.graph.get("test:@acme/cli");
      if (
        !(core instanceof TestPackage) ||
        !(ui instanceof TestPackage) ||
        !(docs instanceof TestPackage) ||
        !(cli instanceof TestPackage)
      ) {
        throw new Error("missing packages");
      }

      exec.mockImplementation((command, args = []) => {
        if (command !== "git") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);

        switch (args[0]) {
          case "status":
            return commandResult({ stdout: " M package.json\n" });
          case "show":
            return commandResult({ stdout: "base-commit\n2026-07-04T00:00:00+00:00\n" });
          case "hash-object":
            return commandResult({ stdout: "blob-sha\n" });
          case "write-tree":
            return commandResult({ stdout: "tree-sha\n" });
          case "commit-tree":
            return commandResult({ stdout: "commit-sha\n" });
          default:
            return commandResult();
        }
      });

      for (const plugin of plugins) {
        await plugin.initCliDraft?.call(context, draft);
      }
      core.setVersion("1.1.0");
      ui.setVersion("1.1.0");
      docs.setVersion("1.1.0");
      cli.setVersion("1.1.0");
      for (const plugin of plugins) {
        await plugin.applyCliDraft?.call(context, draft);
      }

      expect(createMergeRequest).toHaveBeenCalledWith("acme/repo", {
        title: "Release @acme/core (test)",
        body: expect.stringContaining("| `@acme/core` | `1.0.0` | `1.1.0` |"),
        head: "tegami/version-packages/group-test",
        base: "main",
        apiUrl: "https://gitlab.com/api/v4",
        token: testToken,
      });
      expect(createMergeRequest).toHaveBeenCalledWith("acme/repo", {
        title: "Release @acme/ui (test), @acme/docs (test)",
        body: expect.stringContaining("| `@acme/docs` | `1.0.0` | `1.1.0` |"),
        head: "tegami/version-packages/acme-docs-acme-ui",
        base: "main",
        apiUrl: "https://gitlab.com/api/v4",
        token: testToken,
      });
      expect(createMergeRequest).toHaveBeenCalledWith("acme/repo", {
        title: "Release @acme/cli (test)",
        body: expect.stringContaining("| `@acme/cli` | `1.0.0` | `1.1.0` |"),
        head: "tegami/version-packages/unlisted",
        base: "main",
        apiUrl: "https://gitlab.com/api/v4",
        token: testToken,
      });

      // the predicted publish plan only covers the group members
      const groupBody = createMergeRequest.mock.calls.find(
        ([, request]) => request.head === "tegami/version-packages/group-test",
      )![1].body;
      const publishSection = groupBody.split("## Publish")[1] ?? "";
      expect(publishSection).toContain("The following packages will be published if merged:");
      expect(publishSection).toContain("| `@acme/core` | `1.1.0` | `test` |");
      expect(publishSection).not.toContain("| `@acme/ui`");

      // group branches are committed & pushed directly, the working tree stays on the version commit
      expect(await readFile(context.lockPath, "utf8")).not.toContain("gitlab:publish-group");
      expect(
        exec.mock.calls.filter(([, args]) => args?.[0] === "push").map(([, args]) => args),
      ).toEqual([
        ["push", "--force", "origin", "commit-sha:refs/heads/tegami/version-packages/group-test"],
        [
          "push",
          "--force",
          "origin",
          "commit-sha:refs/heads/tegami/version-packages/acme-docs-acme-ui",
        ],
        ["push", "--force", "origin", "commit-sha:refs/heads/tegami/version-packages/unlisted"],
      ]);
      expect(
        exec.mock.calls.filter(([, args]) => args?.[0] === "checkout").map(([, args]) => args),
      ).toEqual([["checkout", "--detach"]]);
      expect(exec.mock.calls.some(([, args]) => args?.includes("--amend"))).toBe(false);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("restores publish groups from the lock into the publish plan", async () => {
    const plugins = gitlabPlugin({ versionMr: { groups: ["group:test", "@acme/ui"] } });
    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);
    context.graph.registerGroup("test", {});
    context.graph.addGroupMember("test", "test:@acme/core");
    const plan = releasePlan(context, [{}]);
    const lock = new PublishLock();

    lock.write("gitlab:publish-group", {
      groups: { "group-test": "active", "acme-ui": "pending" },
    });
    await runInitPublishPlan(plugins, context, { lock, plan });

    // only active groups are published
    expect(plan.options.packages).toEqual(["group:test"]);
    // pending groups keep the plan (and the lock) pending
    expect(await resolvePlanStatus(plugins, context, plan)).toBe("pending");
  });

  test("re-syncs pending publish group merge requests before publishing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-gitlab-"));
    tempDirs.push(cwd);

    const plugins = gitlabPlugin({
      ...releasePluginOptions,
      versionMr: { groups: ["@acme/core", "@acme/ui"] },
    });
    const context = {
      ...publishContext([testPackage("@acme/core", "1.1.0"), testPackage("@acme/ui", "1.1.0")]),
      cwd,
      changelogDir: join(cwd, ".tegami"),
      lockPath: join(cwd, ".tegami/publish-lock.yaml"),
    };

    const lock = new PublishLock();
    lock.write("gitlab:publish-group", {
      groups: { "acme-core": "active", "acme-ui": "pending" },
    });
    const lockContent = lock.serialize();
    await mkdir(context.changelogDir, { recursive: true });
    await writeFile(context.lockPath, lockContent);

    exec.mockImplementation((command, args = []) => {
      if (command !== "git") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);

      switch (args[0]) {
        case "show":
          return commandResult({ stdout: "main-commit\n2026-07-04T00:00:00+00:00\n" });
        case "hash-object":
          return commandResult({ stdout: "blob-sha\n" });
        case "write-tree":
          return commandResult({ stdout: "tree-sha\n" });
        case "commit-tree":
          return commandResult({ stdout: "commit-sha\n" });
        case "ls-remote":
          return commandResult({ stdout: "" });
        default:
          return commandResult();
      }
    });

    const plan = releasePlan(context, [{ name: "@acme/core" }, { name: "@acme/ui" }]);
    await runInitPublishPlan(plugins, context, { lock, plan });
    await runBeforePublishAll(plugins, context, { plan });

    // re-syncs are push-only: the request tracks the branch, its body never changes
    expect(findOpenMergeRequest).not.toHaveBeenCalled();
    expect(createMergeRequest).not.toHaveBeenCalled();
    expect(updateMergeRequest).not.toHaveBeenCalled();

    // the lock commit activates the pending group without touching the working tree
    expect(await readFile(context.lockPath, "utf8")).toBe(lockContent);
    expect(exec.mock.calls.some(([, args]) => args?.[0] === "checkout")).toBe(false);
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["update-index", "--add", "--cacheinfo", "100644,blob-sha,.tegami/publish-lock.yaml"],
      expect.anything(),
    );
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "origin", "refs/heads/tegami/version-packages/acme-ui"],
      expect.anything(),
    );
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["push", "--force", "origin", "commit-sha:refs/heads/tegami/version-packages/acme-ui"],
      expect.anything(),
    );
  });

  test("skips pushing publish group branches that are already in sync", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-gitlab-"));
    tempDirs.push(cwd);

    const plugins = gitlabPlugin({ ...releasePluginOptions, versionMr: { groups: ["@acme/ui"] } });
    const context = {
      ...publishContext([testPackage("@acme/ui", "1.1.0")]),
      cwd,
      changelogDir: join(cwd, ".tegami"),
      lockPath: join(cwd, ".tegami/publish-lock.yaml"),
    };

    const lock = new PublishLock();
    lock.write("gitlab:publish-group", { groups: { "acme-ui": "pending" } });
    await mkdir(context.changelogDir, { recursive: true });
    await writeFile(context.lockPath, lock.serialize());

    exec.mockImplementation((command, args = []) => {
      if (command !== "git") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);

      switch (args[0]) {
        case "show":
          return commandResult({ stdout: "main-commit\n2026-07-04T00:00:00+00:00\n" });
        case "hash-object":
          return commandResult({ stdout: "blob-sha\n" });
        case "write-tree":
          return commandResult({ stdout: "tree-sha\n" });
        case "commit-tree":
          return commandResult({ stdout: "commit-sha\n" });
        case "ls-remote":
          return commandResult({
            stdout: "commit-sha\trefs/heads/tegami/version-packages/acme-ui\n",
          });
        default:
          return commandResult();
      }
    });
    findOpenMergeRequest.mockResolvedValue(42);

    const plan = releasePlan(context, [{ name: "@acme/ui" }]);
    await runInitPublishPlan(plugins, context, { lock, plan });
    await runBeforePublishAll(plugins, context, { plan });

    expect(exec.mock.calls.some(([, args]) => args?.[0] === "push")).toBe(false);
    expect(createMergeRequest).not.toHaveBeenCalled();
    expect(updateMergeRequest).not.toHaveBeenCalled();
  });

  test("skips version merge requests outside CI by default", async () => {
    const previousCi = process.env.CI;
    delete process.env.CI;

    try {
      const plugins = gitlabPlugin(releasePluginOptions);
      const context = publishContext();
      await runVersionMergeRequest(plugins, context, versionDraft(context));
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
      const plugins = gitlabPlugin({
        ...releasePluginOptions,
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

      await runVersionMergeRequest(plugins, context, versionDraft(context));

      expect(createMergeRequest).toHaveBeenCalled();
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });
});

function gitlabPlugin(options?: Parameters<typeof gitlab>[0]): TegamiPlugin[] {
  return gitlab(options);
}

async function initPlugins(plugins: TegamiPlugin[], context: TegamiContext) {
  for (const plugin of plugins) {
    await plugin.init?.call(context);
  }
}

async function runAfterPublishAll(
  plugins: TegamiPlugin[],
  context: TegamiContext,
  plan: PublishPlan,
) {
  await initPlugins(plugins, context);
  for (const plugin of plugins) {
    await plugin.afterPublishAll?.call(context, { plan });
  }
}

async function resolvePlanStatus(
  plugins: TegamiPlugin[],
  context: TegamiContext,
  plan: PublishPlan,
): Promise<"pending" | undefined> {
  await initPlugins(plugins, context);
  for (const plugin of plugins) {
    const status = await plugin.resolvePlanStatus?.call(context, { plan });
    if (status === "pending") return "pending";
  }
}

async function runInitPublishPlan(
  plugins: TegamiPlugin[],
  context: TegamiContext,
  opts: { lock: PublishLock; plan: PublishPlan },
) {
  await initPlugins(plugins, context);
  for (const plugin of plugins) {
    await plugin.initPublishPlan?.call(context, opts);
  }
}

async function runBeforePublishAll(
  plugins: TegamiPlugin[],
  context: TegamiContext,
  opts: { plan: PublishPlan },
) {
  for (const plugin of plugins) {
    await plugin.beforePublishAll?.call(context, opts);
  }
}

async function runInitCli(
  plugins: TegamiPlugin[],
  context: TegamiContext,
  cli: ReturnType<typeof createTegamiCliRegistry>,
) {
  await initPlugins(plugins, context);
  for (const plugin of plugins) {
    await plugin.initCli?.call(context, cli);
  }
}

function publishContext(packages: TestPackage[] = [testPackage()]): TegamiContext {
  return {
    cwd: "/repo",
    changelogDir: "/repo/.tegami",
    lockPath: "/repo/.tegami/publish-lock.yaml",
    options: {},
    plugins: [],
    graph: new PackageGraph(packages),
    gitlab: testGitlab,
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
  plugins: TegamiPlugin[],
  context: ReturnType<typeof publishContext>,
  draft: Draft,
) {
  const pkg = context.graph.get("test:@acme/core");
  if (!(pkg instanceof TestPackage)) throw new Error("missing package");

  await initPlugins(plugins, context);
  for (const plugin of plugins) {
    await plugin.initCliDraft?.call(context, draft);
  }
  pkg.setVersion("1.1.0");
  for (const plugin of plugins) {
    await plugin.applyCliDraft?.call(context, draft);
  }
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
