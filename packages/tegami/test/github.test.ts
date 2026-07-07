import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChangelogEntry } from "../src/changelog/parse";
import { Draft } from "../src/plans/draft";
import type { PackagePublishPlan, PackagePublishResult, PublishPlan } from "../src/plans/publish";
import { PublishLock } from "../src/plans/lock";
import * as githubClient from "../src/plugins/github/api";
import { tegami } from "../src";
import { github } from "../src/plugins/github";
import type { TegamiContext } from "../src/context";
import type { PublishPreflight, TegamiPlugin } from "../src/types";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import { somePromise } from "../src/utils/common";
import { createTegamiCliRegistry } from "../src/cli/core";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

vi.mock("../src/plugins/github/api", () => ({
  releaseExistsByTag: vi.fn(),
  createRelease: vi.fn(),
  findOpenPullRequest: vi.fn(),
  updatePullRequest: vi.fn(),
  createPullRequest: vi.fn(),
  listPullRequestsForCommit: vi.fn(),
}));

const exec = vi.mocked(x);
const releaseExistsByTag = vi.mocked(githubClient.releaseExistsByTag);
const createGitHubRelease = vi.mocked(githubClient.createRelease);
const findOpenPullRequest = vi.mocked(githubClient.findOpenPullRequest);
const updatePullRequest = vi.mocked(githubClient.updatePullRequest);
const createPullRequest = vi.mocked(githubClient.createPullRequest);
const listPullRequestsForCommit = vi.mocked(githubClient.listPullRequestsForCommit);
const tempDirs: string[] = [];

beforeEach(() => {
  exec.mockReset();
  exec.mockImplementation(() => commandResult());
  releaseExistsByTag.mockReset();
  releaseExistsByTag.mockResolvedValue(false);
  createGitHubRelease.mockReset();
  createGitHubRelease.mockResolvedValue(undefined);
  findOpenPullRequest.mockReset();
  findOpenPullRequest.mockResolvedValue(undefined);
  updatePullRequest.mockReset();
  updatePullRequest.mockResolvedValue(undefined);
  createPullRequest.mockReset();
  createPullRequest.mockResolvedValue(undefined);
  listPullRequestsForCommit.mockReset();
  listPullRequestsForCommit.mockResolvedValue([]);
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("github release plugin", () => {
  test("creates GitHub releases for successful published packages", async () => {
    const plugin = githubPlugin({
      repo: "acme/repo",
      release: {
        create({ pkg, plan }) {
          const packagePlan = plan.packages.get(pkg.id);
          return {
            prerelease: packagePlan?.npm?.distTag !== "latest",
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

    expect(releaseExistsByTag).toHaveBeenCalledWith("acme/repo", "@acme/core@1.0.1", "test-token");
    expect(createGitHubRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "Release 1.0.1",
      notes: "Notes for @acme/core",
      prerelease: true,
      token: "test-token",
    });
  });

  test("skips GitHub release creation when the release already exists", async () => {
    releaseExistsByTag.mockResolvedValue(true);

    const plugin = githubPlugin({ repo: "acme/repo" });

    const context = {
      ...publishContext(),
      github: { repo: "acme/repo", token: "test-token" },
    };

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [{}]),
    });

    expect(releaseExistsByTag).toHaveBeenCalledWith("acme/repo", "@acme/core@1.0.1", "test-token");
    expect(createGitHubRelease).not.toHaveBeenCalled();
  });

  test("skips default release note work when the release already exists", async () => {
    releaseExistsByTag.mockResolvedValue(true);
    exec.mockImplementation((command, args = []) => {
      if (command === "git" && args[0] === "log") {
        throw new Error("git log should not run for an existing release");
      }

      return commandResult();
    });

    const plugin = githubPlugin({ repo: "acme/repo" });
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

    expect(createGitHubRelease).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  test("does not create releases when release is disabled", async () => {
    const plugin = githubPlugin({ repo: "acme/repo", release: false });
    const context = publishContext();

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [{}]),
    });

    expect(releaseExistsByTag).not.toHaveBeenCalled();
    expect(createGitHubRelease).not.toHaveBeenCalled();
  });

  test("returns pending from resolvePlanStatus when a release is missing", async () => {
    releaseExistsByTag.mockResolvedValue(false);
    const plugin = githubPlugin({ repo: "acme/repo" });
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
    const plugin = githubPlugin({ repo: "acme/repo" });
    const context = publishContext();

    await expect(
      plugin.resolvePlanStatus?.call(context, {
        plan: releasePlan(context, [{ preflight: { shouldPublish: false } }]),
      }),
    ).resolves.toEqual([]);

    expect(releaseExistsByTag).not.toHaveBeenCalled();
  });

  test("creates releases eagerly when another package failed", async () => {
    const plugin = githubPlugin({
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

    expect(createGitHubRelease).toHaveBeenCalledTimes(1);
  });

  test("does not create releases when any package failed", async () => {
    const plugin = githubPlugin();

    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [
        {},
        { name: "@acme/ui", publishResult: { type: "failed", error: "publish failed" } },
      ]),
    });

    expect(releaseExistsByTag).not.toHaveBeenCalled();
    expect(createGitHubRelease).not.toHaveBeenCalled();
  });

  test("creates GitHub releases for skipped publish results", async () => {
    const plugin = githubPlugin({ repo: "acme/repo" });
    const context = publishContext();

    await plugin.afterPublishAll?.call(context, {
      plan: releasePlan(context, [{ publishResult: { type: "skipped" } }]),
    });

    expect(releaseExistsByTag).toHaveBeenCalledWith("acme/repo", "@acme/core@1.0.1", "test-token");
    expect(createGitHubRelease).toHaveBeenCalledTimes(1);
  });

  test("uses changelog entries for default notes", async () => {
    const plugin = githubPlugin();

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

    expect(createGitHubRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "@acme/core@1.0.1",
      notes: "### Add proxy server\n\nSome description.",
      prerelease: false,
      token: "test-token",
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

    const plugin = githubPlugin({ repo: "acme/repo" });

    const context = {
      ...publishContext(),
      github: { repo: "acme/repo", token: "test-token" },
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

    expect(createGitHubRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "@acme/core@1.0.1",
      notes:
        "### Add proxy server ([abc1234](https://github.com/acme/repo/commit/abc1234567890abcdef1234567890abcdef123456))\n\nSome description.",
      prerelease: false,
      token: "test-token",
    });
  });

  test("shows related pull requests and contributors in release notes", async () => {
    exec.mockImplementation((command, args = []) => {
      if (command === "git" && args[0] === "log") {
        return commandResult({
          stdout: "abc1234567890abcdef1234567890abcdef123456\n",
        });
      }

      return commandResult();
    });
    listPullRequestsForCommit.mockResolvedValue([
      { number: 42, title: "Add proxy server", user: { login: "alice" } },
    ]);

    const plugin = githubPlugin({ repo: "acme/repo" });
    const context = {
      ...publishContext(),
      github: { repo: "acme/repo", token: "test-token" },
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

    expect(listPullRequestsForCommit).toHaveBeenCalledWith(
      "acme/repo",
      "abc1234567890abcdef1234567890abcdef123456",
      "test-token",
    );
    expect(createGitHubRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1",
      title: "@acme/core@1.0.1",
      notes:
        "### Add proxy server ([abc1234](https://github.com/acme/repo/commit/abc1234567890abcdef1234567890abcdef123456))\n\nSome description.\n\n<details>\n<summary>Pull request & contributors</summary>\n\n- [#42 Add proxy server](https://github.com/acme/repo/pull/42) by @alice\n\n</details>",
      prerelease: false,
      token: "test-token",
    });
  });

  test("marks semver prerelease versions as GitHub prerelease by default", async () => {
    const plugin = githubPlugin({ repo: "acme/repo" });

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

    expect(createGitHubRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "@acme/core@1.0.1-beta.0",
      title: "@acme/core@1.0.1-beta.0",
      notes: "Published @acme/core@1.0.1-beta.0.",
      prerelease: true,
      token: "test-token",
    });
  });

  test("summarizes all packages sharing a git tag in release notes", async () => {
    const plugin = githubPlugin({ repo: "acme/repo" });

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
    expect(createGitHubRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "acme@1.0.1",
      title: "acme@1.0.1",
      notes: "- @acme/core@1.0.1\n- @acme/ui@1.0.1\n\n### Add shared API\n\nUseful release note.",
      prerelease: false,
      token: "test-token",
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

    const plugin = githubPlugin({ repo: "acme/repo" });
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
    expect(createGitHubRelease).toHaveBeenCalledTimes(2);
  });

  test("uses release.createGrouped for packages sharing a git tag", async () => {
    const plugin = githubPlugin({
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

    expect(createGitHubRelease).toHaveBeenCalledWith("acme/repo", {
      tag: "acme@1.0.1",
      title: "Group release @acme/core",
      notes: "@acme/core, @acme/ui",
      prerelease: false,
      token: "test-token",
    });
  });
});

describe("github version pull request", () => {
  test("configures git remote during cli.init in CI", async () => {
    const previousCi = process.env.CI;
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.CI = "true";
    process.env.GITHUB_TOKEN = "test-token";

    try {
      const plugin = githubPlugin({ repo: "acme/repo" });
      const context = publishContext();
      exec.mockImplementation(() => commandResult());

      await plugin.init?.call(context);
      await plugin.initCli?.call(context, createTegamiCliRegistry(tegami({ cwd: "/repo" })));

      expect(exec).toHaveBeenCalledWith(
        "git",
        [
          "remote",
          "set-url",
          "origin",
          "https://x-access-token:test-token@github.com/acme/repo.git",
        ],
        { nodeOptions: { cwd: "/repo" } },
      );
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;

      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    }
  });

  test("updates an existing version pull request in CI", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = githubPlugin({ repo: "acme/repo" });
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
      findOpenPullRequest.mockResolvedValue(42);

      await runVersionPullRequest(plugin, context, draft);

      expect(updatePullRequest).toHaveBeenCalledWith("acme/repo", 42, {
        title: "Version Packages",
        body: expect.stringContaining("All bumped packages."),
        token: "test-token",
      });
      expect(createPullRequest).not.toHaveBeenCalled();
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

  test("creates a version pull request in CI when there are changes", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = githubPlugin({ repo: "acme/repo" });
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

      await runVersionPullRequest(plugin, context, draft);

      expect(createPullRequest).toHaveBeenCalledWith("acme/repo", {
        title: "Version Packages",
        body: expect.stringContaining("| `@acme/core` | `1.0.0` | `1.1.0` |"),
        head: "tegami/version-packages",
        base: "main",
        token: "test-token",
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

  test("uses versionPr.commit for version commits", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const commit = vi.fn(async function (this: TegamiContext) {
        return {
          title: `chore: release v${this.graph.get("test:@acme/core")?.version}`,
          body: "Release notes",
        };
      });
      const plugin = githubPlugin({
        repo: "acme/repo",
        versionPr: { commit },
      });
      const context = publishContext([testPackage("@acme/core", "1.0.0")]);
      const draft = versionDraft(context);

      exec.mockImplementation((command, args = []) => {
        if (command !== "git") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);

        switch (args[0]) {
          case "status":
            return commandResult({ stdout: " M package.json\n" });
          default:
            return commandResult();
        }
      });

      await runVersionPullRequest(plugin, context, draft);

      expect(commit).toHaveBeenCalledWith({ type: "version-packages" });
      expect(exec.mock.calls.find(([, args]) => args?.[0] === "commit")?.[1]).toEqual([
        "commit",
        "-m",
        "chore: release v1.1.0",
        "-m",
        "Release notes",
      ]);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("uses versionPr.commit for lock update commits", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const commit = vi.fn(async (opts: { type: string }) => {
        if (opts.type === "update-lock") return { title: "custom group commit" };
      });
      const plugin = githubPlugin({
        repo: "acme/repo",
        versionPr: {
          groups: ["group:test"],
          commit,
        },
      });
      const cwd = await mkdtemp(join(tmpdir(), "tegami-github-"));
      tempDirs.push(cwd);
      const context = {
        ...publishContext([testPackage("@acme/core", "1.0.0"), testPackage("@acme/ui", "1.0.0")]),
        cwd,
        changelogDir: join(cwd, ".tegami"),
        lockPath: join(cwd, ".tegami/publish-lock.yaml"),
      };
      context.graph.registerGroup("test", {});
      context.graph.addGroupMember("test", "test:@acme/core");
      context.plugins = [
        {
          name: "test-provider",
          publishPreflight: () => ({ shouldPublish: true }),
        },
      ];

      const lock = new PublishLock();
      lock.write("core:packages", { id: "test:@acme/core", updated: true });
      lock.write("core:packages", { id: "test:@acme/ui", updated: true });
      await mkdir(context.changelogDir, { recursive: true });
      await writeFile(context.lockPath, lock.serialize());

      const draft = new Draft(context);
      draft.addChangelog(
        testChangelogEntry({
          packages: new Map([
            ["@acme/core", { type: "minor" }],
            ["@acme/ui", { type: "minor" }],
          ]),
        }),
      );

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

      await plugin.initCliDraft?.call(context, draft);
      const core = context.graph.get("test:@acme/core");
      const ui = context.graph.get("test:@acme/ui");
      if (!(core instanceof TestPackage) || !(ui instanceof TestPackage)) {
        throw new Error("missing packages");
      }
      core.setVersion("1.1.0");
      ui.setVersion("1.1.0");
      await plugin.applyCliDraft?.call(context, draft);

      expect(commit).toHaveBeenCalledWith({ type: "version-packages" });
      expect(commit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "update-lock",
          store: { groups: { "group-test": "active", unlisted: "pending" } },
        }),
      );
      expect(commit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "update-lock",
          store: { groups: { "group-test": "pending", unlisted: "active" } },
        }),
      );
      expect(
        exec.mock.calls.filter(([, args]) => args?.[0] === "commit").map(([, args]) => args),
      ).toEqual([["commit", "-m", "Version Packages"]]);
      expect(
        exec.mock.calls.filter(([, args]) => args?.[0] === "commit-tree").map(([, args]) => args),
      ).toEqual([
        ["commit-tree", "tree-sha", "-p", "base-commit", "-m", "custom group commit"],
        ["commit-tree", "tree-sha", "-p", "base-commit", "-m", "custom group commit"],
      ]);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("creates one version pull request per publish group", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const cwd = await mkdtemp(join(tmpdir(), "tegami-github-"));
      tempDirs.push(cwd);

      const plugin = githubPlugin({
        repo: "acme/repo",
        versionPr: {
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

      await plugin.initCliDraft?.call(context, draft);
      core.setVersion("1.1.0");
      ui.setVersion("1.1.0");
      docs.setVersion("1.1.0");
      cli.setVersion("1.1.0");
      await plugin.applyCliDraft?.call(context, draft);

      expect(createPullRequest).toHaveBeenCalledWith("acme/repo", {
        title: "Release @acme/core (test)",
        body: expect.stringContaining("| `@acme/core` | `1.0.0` | `1.1.0` |"),
        head: "tegami/version-packages/group-test",
        base: "main",
        token: "test-token",
      });
      expect(createPullRequest).toHaveBeenCalledWith("acme/repo", {
        title: "Release @acme/ui (test), @acme/docs (test)",
        body: expect.stringContaining("| `@acme/docs` | `1.0.0` | `1.1.0` |"),
        head: "tegami/version-packages/acme-docs-acme-ui",
        base: "main",
        token: "test-token",
      });
      expect(createPullRequest).toHaveBeenCalledWith("acme/repo", {
        title: "Release @acme/cli (test)",
        body: expect.stringContaining("| `@acme/cli` | `1.0.0` | `1.1.0` |"),
        head: "tegami/version-packages/unlisted",
        base: "main",
        token: "test-token",
      });

      // the predicted publish plan only covers the group members
      const groupBody = createPullRequest.mock.calls.find(
        ([, request]) => request.head === "tegami/version-packages/group-test",
      )![1].body;
      expect(groupBody).toMatchInlineSnapshot(`
        "## Summary

        All bumped packages.

        | Package | From | To |
        | --- | --- | --- |
        | \`@acme/core\` | \`1.0.0\` | \`1.1.0\` |
        | \`@acme/ui\` | \`1.0.0\` | \`1.1.0\` |
        | \`@acme/docs\` | \`1.0.0\` | \`1.1.0\` |
        | \`@acme/cli\` | \`1.0.0\` | \`1.1.0\` |

        ## Changelogs
        ### \`change.md\`

        <details>
        <summary>Show Bumped Packages (4)</summary>

        | Package | Bump |
        | --- | --- |
        | \`test:@acme/core\` | minor |
        | \`test:@acme/ui\` | minor |
        | \`test:@acme/docs\` | minor |
        | \`test:@acme/cli\` | minor |

        </details>


        ## Publish

        The following packages will be published if merged:

        | Package | Version | Registry |
        | --- | --- | --- |
        | \`@acme/core\` | \`1.1.0\` | \`test\` |
        "
      `);

      // group branches are committed & pushed directly, the working tree stays on the version commit
      expect(await readFile(context.lockPath, "utf8")).not.toContain("github:publish-group");
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
    const plugin = githubPlugin({ versionPr: { groups: ["group:test", "@acme/ui"] } });
    const context = publishContext([testPackage("@acme/core"), testPackage("@acme/ui")]);
    context.graph.registerGroup("test", {});
    context.graph.addGroupMember("test", "test:@acme/core");
    const plan = releasePlan(context, [{}]);
    const lock = new PublishLock();

    lock.write("github:publish-group", {
      groups: { "group-test": "active", "acme-ui": "pending" },
    });
    await plugin.initPublishPlan?.call(context, { lock, plan });

    // only active groups are published
    expect(plan.options.packages).toEqual(["group:test"]);
    // pending groups keep the plan (and the lock) pending
    expect(await plugin.resolvePlanStatus?.call(context, { plan })).toBe("pending");
  });

  test("re-syncs pending publish group pull requests before publishing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-github-"));
    tempDirs.push(cwd);

    const plugin = githubPlugin({
      repo: "acme/repo",
      versionPr: { groups: ["@acme/core", "@acme/ui"] },
    });
    const context = {
      ...publishContext([testPackage("@acme/core", "1.1.0"), testPackage("@acme/ui", "1.1.0")]),
      cwd,
      changelogDir: join(cwd, ".tegami"),
      lockPath: join(cwd, ".tegami/publish-lock.yaml"),
    };

    const lock = new PublishLock();
    lock.write("github:publish-group", {
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
    await plugin.initPublishPlan?.call(context, { lock, plan });
    await plugin.beforePublishAll?.call(context, { plan });

    // re-syncs are push-only: the request tracks the branch, its body never changes
    expect(findOpenPullRequest).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(updatePullRequest).not.toHaveBeenCalled();

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
    const cwd = await mkdtemp(join(tmpdir(), "tegami-github-"));
    tempDirs.push(cwd);

    const plugin = githubPlugin({ repo: "acme/repo", versionPr: { groups: ["@acme/ui"] } });
    const context = {
      ...publishContext([testPackage("@acme/ui", "1.1.0")]),
      cwd,
      changelogDir: join(cwd, ".tegami"),
      lockPath: join(cwd, ".tegami/publish-lock.yaml"),
    };

    const lock = new PublishLock();
    lock.write("github:publish-group", { groups: { "acme-ui": "pending" } });
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
    findOpenPullRequest.mockResolvedValue(42);

    const plan = releasePlan(context, [{ name: "@acme/ui" }]);
    await plugin.initPublishPlan?.call(context, { lock, plan });
    await plugin.beforePublishAll?.call(context, { plan });

    expect(exec.mock.calls.some(([, args]) => args?.[0] === "push")).toBe(false);
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(updatePullRequest).not.toHaveBeenCalled();
  });

  test("skips re-syncing publish group requests on dry-run", async () => {
    const plugin = githubPlugin({ repo: "acme/repo", versionPr: { groups: ["@acme/ui"] } });
    const context = publishContext([testPackage("@acme/ui", "1.1.0")]);
    const plan = releasePlan(context, [{ name: "@acme/ui" }]);
    plan.options.dryRun = true;

    const lock = new PublishLock();
    lock.write("github:publish-group", { groups: { "acme-ui": "pending" } });

    await plugin.initPublishPlan?.call(context, { lock, plan });
    await plugin.beforePublishAll?.call(context, { plan });

    expect(exec).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(updatePullRequest).not.toHaveBeenCalled();
  });

  test("skips version pull requests outside CI by default", async () => {
    const previousCi = process.env.CI;
    delete process.env.CI;

    try {
      const plugin = githubPlugin();
      const context = publishContext();
      await runVersionPullRequest(plugin, context, versionDraft(context));
      expect(exec).not.toHaveBeenCalled();
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("creates a version pull request outside CI when enabled explicitly", async () => {
    const previousCi = process.env.CI;
    delete process.env.CI;

    try {
      const plugin = githubPlugin({
        repo: "acme/repo",
        versionPr: { forceCreate: true },
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

      await runVersionPullRequest(plugin, context, versionDraft(context));

      expect(createPullRequest).toHaveBeenCalled();
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });
});

function githubPlugin(options?: Parameters<typeof github>[0]): TegamiPlugin {
  const plugin = github(options).find((plugin) => plugin.name === "github");
  if (!plugin) throw new Error("GitHub plugin not found.");
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
    github: { repo: "acme/repo", token: "test-token" },
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

async function runVersionPullRequest(
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
