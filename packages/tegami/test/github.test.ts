import { x } from "tinyexec";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChangelogEntry } from "../src/changelog/parse";
import { Draft } from "../src/plans/draft";
import type { PackagePublishPlan, PackagePublishResult, PublishPlan } from "../src/plans/publish";
import * as githubClient from "../src/plugins/github/api";
import { github } from "../src/plugins/github";
import type { TegamiContext } from "../src/context";
import type { PublishPreflight, TegamiPlugin } from "../src/types";
import { PackageGraph, WorkspacePackage } from "../src/graph";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

vi.mock("../src/plugins/github/api", () => ({
  releaseExistsByTag: vi.fn(),
  createRelease: vi.fn(),
  findOpenPullRequest: vi.fn(),
  updatePullRequest: vi.fn(),
  createPullRequest: vi.fn(),
}));

const exec = vi.mocked(x);
const releaseExistsByTag = vi.mocked(githubClient.releaseExistsByTag);
const createGitHubRelease = vi.mocked(githubClient.createRelease);
const findOpenPullRequest = vi.mocked(githubClient.findOpenPullRequest);
const updatePullRequest = vi.mocked(githubClient.updatePullRequest);
const createPullRequest = vi.mocked(githubClient.createPullRequest);

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

    await expect(
      plugin.resolvePlanStatus?.call(context, {
        plan: releasePlan(context, [{}]),
      }),
    ).resolves.toBe("pending");
  });

  test("ignores missing releases when npm preflight is complete", async () => {
    releaseExistsByTag.mockResolvedValue(false);
    const plugin = githubPlugin({ repo: "acme/repo" });
    const context = publishContext();

    await expect(
      plugin.resolvePlanStatus?.call(context, {
        plan: releasePlan(context, [{ preflight: { publish: false } }]),
      }),
    ).resolves.toBeUndefined();

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
      await plugin.cli?.init?.call(context);

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
        if (command === "git" && args[0] === "status") {
          return commandResult({ stdout: " M package.json\n" });
        }

        if (command === "git") {
          return commandResult();
        }

        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      });
      findOpenPullRequest.mockResolvedValue(42);

      await runVersionPullRequest(plugin, context, draft);

      expect(updatePullRequest).toHaveBeenCalledWith("acme/repo", 42, {
        title: "Version Packages",
        body: expect.stringContaining("Merge this PR to publish the versioned packages."),
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

  test("creates a version pull request in CI when there are changes", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = githubPlugin({ repo: "acme/repo" });
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

  await plugin.cli?.draftCreated?.call(context, draft);
  pkg.setVersion("1.1.0");
  await plugin.cli?.draftApplied?.call(context, draft);
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
      preflight: entry.preflight ?? { publish: true },
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
