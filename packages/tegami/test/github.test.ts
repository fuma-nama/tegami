import { x } from "tinyexec";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PackagePublishResult, PublishResult } from "../src/publish";
import type { ChangelogEntry } from "../src/changelog/parse";
import { DraftPlan } from "../src/plans/draft";
import { github } from "../src/plugins/github";
import type { TegamiPlugin } from "../src/types";
import { PackageGraph, WorkspacePackage } from "../src/graph";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockReset();
  exec.mockImplementation(() => commandResult());
});

describe("github release plugin", () => {
  test("creates GitHub releases for successful published packages", async () => {
    const plugin = githubPlugin({
      repo: "acme/repo",
      onCreateRelease(pkg) {
        return {
          prerelease: pkg.npm?.distTag !== "latest",
          title: `Release ${pkg.version}`,
          notes: `Notes for ${pkg.name}`,
        };
      },
    });

    await plugin.afterPublishAll?.call(
      publishContext(),
      publishResult({
        packages: [
          packageResult({
            npm: { distTag: "alpha" },
            gitTag: "@acme/core@1.0.1",
          }),
          packageResult({
            name: "@acme/no-tag",
            gitTag: undefined,
          }),
        ],
      }),
    );

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls).toMatchInlineSnapshot(`
      [
        [
          "gh",
          [
            "release",
            "create",
            "@acme/core@1.0.1",
            "--title",
            "Release 1.0.1",
            "--notes",
            "Notes for @acme/core",
            "--repo",
            "acme/repo",
            "--prerelease",
          ],
        ],
      ]
    `);
  });

  test("does not create releases when any package failed", async () => {
    const plugin = githubPlugin();

    await plugin.afterPublishAll?.call(
      publishContext(),
      publishResult({
        state: "failed",
        packages: [
          packageResult(),
          packageResult({
            name: "@acme/ui",
            state: "failed",
          }),
        ],
      }),
    );

    expect(exec).not.toHaveBeenCalled();
  });

  test("uses changelog entries for default notes", async () => {
    const plugin = githubPlugin();

    await plugin.afterPublishAll?.call(
      publishContext(),
      publishResult({
        packages: [
          packageResult({
            changelogs: [
              testChangelogEntry({
                packages: new Map([["@acme/core", { type: "minor" }]]),
                sections: [{ title: "Add proxy server", content: "Some description.", depth: 2 }],
              }),
            ],
          }),
        ],
      }),
    );

    expect(ghReleaseCall()).toMatchInlineSnapshot(`
      [
        "gh",
        [
          "release",
          "create",
          "@acme/core@1.0.1",
          "--title",
          "@acme/core@1.0.1",
          "--notes",
          "### Add proxy server

      Some description.",
        ],
      ]
    `);
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

    await plugin.afterPublishAll?.call(
      {
        ...publishContext(),
        github: { repo: "acme/repo" },
      },
      publishResult({
        packages: [
          packageResult({
            changelogs: [
              testChangelogEntry({
                packages: new Map([["@acme/core", { type: "minor" }]]),
                sections: [{ title: "Add proxy server", content: "Some description.", depth: 2 }],
              }),
            ],
          }),
        ],
      }),
    );

    expect(ghReleaseCall()?.[1]).toEqual([
      "release",
      "create",
      "@acme/core@1.0.1",
      "--title",
      "@acme/core@1.0.1",
      "--notes",
      "### Add proxy server ([abc1234](https://github.com/acme/repo/commit/abc1234567890abcdef1234567890abcdef123456))\n\nSome description.",
      "--repo",
      "acme/repo",
    ]);
  });

  test("marks semver prerelease versions as GitHub prerelease by default", async () => {
    const plugin = githubPlugin({ repo: "acme/repo" });

    await plugin.afterPublishAll?.call(
      publishContext(),
      publishResult({
        packages: [packageResult({ version: "1.0.1-beta.0", gitTag: "@acme/core@1.0.1-beta.0" })],
      }),
    );

    expect(exec.mock.calls[0]?.[1]).toEqual([
      "release",
      "create",
      "@acme/core@1.0.1-beta.0",
      "--title",
      "@acme/core@1.0.1-beta.0",
      "--notes",
      "Published @acme/core@1.0.1-beta.0.",
      "--repo",
      "acme/repo",
      "--prerelease",
    ]);
  });

  test("summarizes all packages sharing a git tag in release notes", async () => {
    const plugin = githubPlugin({ repo: "acme/repo" });

    await plugin.afterPublishAll?.call(
      publishContext(),
      publishResult({
        packages: [
          packageResult({
            name: "@acme/core",
            gitTag: "acme@1.0.1",
            changelogs: [
              testChangelogEntry({
                packages: new Map([["group:acme", { type: "minor" }]]),
                sections: [{ title: "Add shared API", content: "Useful release note.", depth: 2 }],
              }),
            ],
          }),
          packageResult({
            name: "@acme/ui",
            gitTag: "acme@1.0.1",
            changelogs: [
              testChangelogEntry({
                packages: new Map([["group:acme", { type: "minor" }]]),
                sections: [{ title: "Add shared API", content: "Useful release note.", depth: 2 }],
              }),
            ],
          }),
        ],
      }),
    );

    expect(exec).toHaveBeenCalledTimes(2);
    expect(ghReleaseCall()?.[1]).toEqual([
      "release",
      "create",
      "acme@1.0.1",
      "--title",
      "acme@1.0.1",
      "--notes",
      "- @acme/core@1.0.1\n- @acme/ui@1.0.1\n\n### Add shared API\n\nUseful release note.",
      "--repo",
      "acme/repo",
    ]);
  });

  test("uses onCreateGroupedRelease for packages sharing a git tag", async () => {
    const plugin = githubPlugin({
      repo: "acme/repo",
      onCreateGroupedRelease(packages) {
        return {
          title: `Group release ${packages[0]!.gitTag}`,
          notes: packages.map((pkg) => pkg.name).join(", "),
        };
      },
      onCreateRelease() {
        throw new Error("onCreateRelease should not be called for grouped releases");
      },
    });

    await plugin.afterPublishAll?.call(
      publishContext(),
      publishResult({
        packages: [
          packageResult({ name: "@acme/core", gitTag: "acme@1.0.1" }),
          packageResult({ name: "@acme/ui", gitTag: "acme@1.0.1" }),
        ],
      }),
    );

    expect(exec.mock.calls[0]?.[1]).toEqual([
      "release",
      "create",
      "acme@1.0.1",
      "--title",
      "Group release acme@1.0.1",
      "--notes",
      "@acme/core, @acme/ui",
      "--repo",
      "acme/repo",
    ]);
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
      const context = publishContext();
      const draft = versionDraft(context);

      exec.mockImplementation((command, args = []) => {
        if (command === "git" && args[0] === "status") {
          return commandResult({ stdout: " M package.json\n" });
        }

        if (command === "git") {
          return commandResult();
        }

        if (command === "gh" && args[0] === "pr" && args[1] === "list") {
          return commandResult({ stdout: '[{"number":42}]\n' });
        }

        if (command === "gh") {
          return commandResult();
        }

        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      });

      await runVersionPullRequest(plugin, context, draft);

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
          {
            "args": [
              "pr",
              "list",
              "--head",
              "tegami/version-packages",
              "--state",
              "open",
              "--json",
              "number",
              "--repo",
              "acme/repo",
            ],
            "command": "gh",
            "cwd": undefined,
            "throwOnError": undefined,
          },
          {
            "args": [
              "pr",
              "edit",
              "42",
              "--title",
              "Version Packages",
              "--body",
              "## Summary

        Merge this PR to publish the versioned packages.

        - @acme/core@1.0.0 → @acme/core@1.1.0

        ## Changelogs
        ### \`change.md\`

        #### Add feature

        Description.
        ",
              "--repo",
              "acme/repo",
            ],
            "command": "gh",
            "cwd": undefined,
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
      const context = publishContext();
      const draft = versionDraft(context);

      exec.mockImplementation((command, args = []) => {
        if (command === "git" && args[0] === "status") {
          return commandResult({ stdout: " M package.json\n" });
        }

        if (command === "git") {
          return commandResult();
        }

        if (command === "gh" && args[0] === "pr" && args[1] === "list") {
          return commandResult({ stdout: "[]\n" });
        }

        if (command === "gh") {
          return commandResult();
        }

        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      });

      await runVersionPullRequest(plugin, context, draft);

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
          {
            "args": [
              "pr",
              "list",
              "--head",
              "tegami/version-packages",
              "--state",
              "open",
              "--json",
              "number",
              "--repo",
              "acme/repo",
            ],
            "command": "gh",
            "cwd": undefined,
            "throwOnError": undefined,
          },
          {
            "args": [
              "pr",
              "create",
              "--title",
              "Version Packages",
              "--body",
              "## Summary

        Merge this PR to publish the versioned packages.

        - @acme/core@1.0.0 → @acme/core@1.1.0

        ## Changelogs
        ### \`change.md\`

        #### Add feature

        Description.
        ",
              "--head",
              "tegami/version-packages",
              "--base",
              "main",
              "--repo",
              "acme/repo",
            ],
            "command": "gh",
            "cwd": undefined,
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
        cli: {
          versionPr: true,
        },
      });
      const context = publishContext();

      exec.mockImplementation((command, args = []) => {
        if (command === "git" && args[0] === "status") {
          return commandResult({ stdout: " M package.json\n" });
        }

        if (command === "git" || command === "gh") {
          return commandResult(command === "gh" && args[1] === "list" ? { stdout: "[]\n" } : {});
        }

        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      });

      await runVersionPullRequest(plugin, context, versionDraft(context));

      expect(exec).toHaveBeenCalled();
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

function publishContext() {
  return {
    cwd: "/repo",
    changelogDir: "/repo/.tegami",
    planPath: "/repo/.tegami/publish-plan",
    options: {},
    plugins: [],
    publishOptions: {},
    graph: new PackageGraph([testPackage()]),
    getRegistryClient: registryClient,
  };
}

function testPackage(): TestPackage {
  return new TestPackage();
}

class TestPackage extends WorkspacePackage {
  readonly name = "@acme/core";
  readonly path = "/repo/packages/core";
  readonly manager = "test";
  readonly publish = true;

  #version = "1.0.0";

  get version() {
    return this.#version;
  }

  setVersion(version: string): void {
    this.#version = version;
  }

  initPlan() {
    const defaults = super.initPlan();
    defaults.publish = true;
    return defaults;
  }

  async write(): Promise<void> {}
}

function versionDraft(context = publishContext()): DraftPlan {
  const draft = new DraftPlan(context);
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
  draft: DraftPlan,
) {
  const pkg = context.graph.get("test:@acme/core");
  if (!(pkg instanceof TestPackage)) throw new Error("missing package");

  await plugin.cli?.publishPlanCreated?.call(context, draft);
  pkg.setVersion("1.1.0");
  await plugin.cli?.publishPlanApplied?.call(context, draft);
}

function registryClient() {
  return {
    id: "test",
    supports: () => true,
    async isPackagePublished() {
      return false;
    },
    async publish() {},
  };
}

function publishResult(overrides: Partial<PublishResult> = {}): PublishResult {
  return {
    _rawPlan: {
      version: "0.0.0",
      id: "tegami-test",
      createdAt: "2026-01-01T00:00:00.000Z",
      changelogs: {},
      packages: {},
    },
    state: "created",
    packages: [],
    ...overrides,
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

function packageResult(overrides: Partial<PackagePublishResult> = {}): PackagePublishResult {
  const name = overrides.name ?? "@acme/core";
  return {
    id: `test:${name}`,
    name,
    version: "1.0.1",
    npm: { distTag: "latest" },
    changelogs: [],
    gitTag: "@acme/core@1.0.1",
    state: "success",
    ...overrides,
  };
}

function ghReleaseCall() {
  return exec.mock.calls.find((call) => call[0] === "gh");
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
