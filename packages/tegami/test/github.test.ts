import { x } from "tinyexec";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PackagePublishResult, PublishResult } from "../src";
import { DraftPlan, type PackagePlan } from "../src/draft";
import { github } from "../src/plugins/github";
import type { TegamiPlugin } from "../src/types";
import { PackageGraph, WorkspacePackage } from "../src/workspace";

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
          prerelease: pkg.distTag !== "latest",
          title: `Release ${pkg.version}`,
          notes: `Notes for ${pkg.name}`,
        };
      },
    });

    await plugin.afterPublish?.call(
      publishContext(),
      publishResult({
        packages: [
          packageResult({
            distTag: "alpha",
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

    await plugin.afterPublish?.call(
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

    await plugin.afterPublish?.call(
      publishContext(),
      publishResult({
        packages: [
          packageResult({
            changelogs: [
              {
                id: "change-1",
                filename: "change.md",
                packages: new Set(["@acme/core"]),
                type: "minor",
                title: "Add proxy server",
                content: "Some description.",
              },
            ],
          }),
        ],
      }),
    );

    expect(exec.mock.calls).toMatchInlineSnapshot(`
      [
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
        ],
      ]
    `);
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
      exec.mockImplementation(() => commandResult());

      await plugin.cli?.init?.call(publishContext());

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

      await plugin.cli?.afterVersion?.call(publishContext(), versionDraft());

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

      await plugin.cli?.afterVersion?.call(publishContext(), versionDraft());

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
        - @acme/core@1.0.0 → @acme/core@1.1.0

        ## Changelogs
        - Add feature

        Merge this PR to publish the versioned packages.",
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
      await plugin.cli?.afterVersion?.call(publishContext(), versionDraft());
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
          createVersionPR: true,
        },
      });

      exec.mockImplementation((command, args = []) => {
        if (command === "git" && args[0] === "status") {
          return commandResult({ stdout: " M package.json\n" });
        }

        if (command === "git" || command === "gh") {
          return commandResult(command === "gh" && args[1] === "list" ? { stdout: "[]\n" } : {});
        }

        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      });

      await plugin.cli?.afterVersion?.call(publishContext(), versionDraft());

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
    changelogDir: ".tegami",
    planPath: "/repo/.tegami/publish-plan.json",
    options: {},
    plugins: [],
    publishOptions: {},
    graph: new PackageGraph([testPackage()]),
    getRegistryClient: registryClient,
  };
}

function testPackage(): WorkspacePackage {
  return {
    name: "@acme/core",
    path: "/repo/packages/core",
    manager: "test",
    version: "1.1.0",
    publish: true,
    id: "test:@acme/core",
  } as WorkspacePackage;
}

function versionDraft(context = publishContext()): DraftPlan {
  const changelogs = new Map([
    [
      "change-1",
      {
        id: "change-1",
        filename: "change.md",
        packages: new Set(["@acme/core"]),
        type: "minor" as const,
        title: "Add feature",
        content: "Description.",
      },
    ],
  ]);
  const packages = new Map<string, PackagePlan>([
    [
      "test:@acme/core",
      {
        type: "minor",
        changelogIds: new Set(["change-1"]),
        publish: true,
      },
    ],
  ]);

  return new DraftPlan(changelogs, packages, context);
}

function registryClient() {
  return {
    id: "test",
    async packageVersionExists() {
      return false;
    },
    async publish() {},
    async publishPlanStatus() {
      return { state: "success" as const };
    },
  };
}

function publishResult(overrides: Partial<PublishResult> = {}): PublishResult {
  return {
    planPath: "/repo/.tegami/publish-plan.json",
    _rawPlan: {
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

function packageResult(overrides: Partial<PackagePublishResult> = {}): PackagePublishResult {
  const name = overrides.name ?? "@acme/core";
  return {
    id: `test:${name}`,
    name,
    version: "1.0.1",
    distTag: "latest",
    changelogs: [],
    gitTag: "@acme/core@1.0.1",
    state: "success",
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
