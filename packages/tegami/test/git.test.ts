import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tinyexec from "tinyexec";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { git } from "../src/plugins/git";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import type { TegamiContext } from "../src/context";
import { publishPlan } from "./helpers/plan";
import { createTegamiCliRegistry } from "../src/cli/core";
import { pluginTaskStatus, runPluginTasks } from "./helpers/tasks";

vi.mock("tinyexec", async (importOriginal) => {
  const actual = await importOriginal<typeof tinyexec>();

  return {
    ...actual,
    x: vi.fn(actual.x),
  };
});

const tempDirs: string[] = [];
const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockClear();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("git utils", () => {
  test("configures git user during cli.init in CI", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = git();
      exec.mockImplementation(() => commandResult() as ReturnType<typeof x>);

      await plugin.initCli?.call(
        pluginContext(),
        createTegamiCliRegistry(tegami({ cwd: "/repo" })),
      );

      expect(
        exec.mock.calls.map(([command, args, options]) => ({
          command,
          args,
          cwd: options?.nodeOptions?.cwd,
        })),
      ).toEqual([
        {
          command: "git",
          args: ["config", "user.name", "github-actions[bot]"],
          cwd: "/repo",
        },
        {
          command: "git",
          args: ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
          cwd: "/repo",
        },
      ]);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("skips tags that already exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-git-"));
    tempDirs.push(cwd);

    await x("git", ["init"], { nodeOptions: { cwd }, throwOnError: true });
    await writeFile(join(cwd, "README.md"), "# Test\n");
    await x("git", ["add", "README.md"], { nodeOptions: { cwd }, throwOnError: true });
    await x(
      "git",
      ["-c", "user.name=Tegami", "-c", "user.email=tegami@example.com", "commit", "-m", "init"],
      {
        nodeOptions: { cwd },
        throwOnError: true,
      },
    );
    await x("git", ["tag", "pkg@1.0.0"], { nodeOptions: { cwd }, throwOnError: true });
  });

  test("creates git tags for successful publish results", async () => {
    const plugin = git();
    const context = pluginContext();
    const core = context.graph.get("test:@acme/core")!;
    const ui = context.graph.get("test:@acme/ui")!;
    const plan = publishPlan(context.graph, {
      packages: [
        { pkg: core, git: { tag: "@acme/core@1.0.1" } },
        { pkg: ui, git: { tag: "@acme/ui@1.0.1" } },
      ],
    });

    exec.mockImplementation(
      mockGit((args) => {
        if (args.at(0) === "tag") {
          return commandResult();
        }
      }),
    );

    await runPluginTasks(plugin, context, plan);
    expect(exec.mock.calls.map(normalizeExecCall)).toMatchInlineSnapshot(`
      [
        {
          "args": [
            "tag",
            "@acme/core@1.0.1",
          ],
          "command": "git",
          "cwd": "/repo",
          "throwOnError": undefined,
        },
        {
          "args": [
            "tag",
            "@acme/ui@1.0.1",
          ],
          "command": "git",
          "cwd": "/repo",
          "throwOnError": undefined,
        },
      ]
    `);
  });

  test("creates git tags for skipped publish results", async () => {
    const plugin = git();
    const context = pluginContext();
    const core = context.graph.get("test:@acme/core")!;
    exec.mockImplementation(
      mockGit((args) => {
        if (args.at(0) === "tag") {
          return commandResult();
        }
      }),
    );

    await runPluginTasks(
      plugin,
      context,
      publishPlan(context.graph, {
        packages: [{ pkg: core, publishResult: { type: "skipped" } }],
      }),
    );

    expect(exec.mock.calls.map(normalizeExecCall)).toEqual([
      {
        args: ["tag", "@acme/core@1.0.1"],
        command: "git",
        cwd: "/repo",
        throwOnError: undefined,
      },
    ]);
  });

  test("skips plugin tags on dry runs, disabled tags, and failed publishes", async () => {
    const context = pluginContext();
    const core = context.graph.get("test:@acme/core")!;

    await runPluginTasks(
      git(),
      context,
      publishPlan(context.graph, { dryRun: true, packages: [{ pkg: core }] }),
    );
    await runPluginTasks(
      git({ createTags: false }),
      context,
      publishPlan(context.graph, { packages: [{ pkg: core }] }),
    );
    await runPluginTasks(
      git(),
      context,
      publishPlan(context.graph, {
        packages: [{ pkg: core, publishResult: { type: "failed", error: "publish failed" } }],
      }),
    );

    expect(exec).not.toHaveBeenCalled();
  });

  test("pushes newly created tags in CI", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = git();
      const context = pluginContext();
      const core = context.graph.get("test:@acme/core")!;
      exec.mockImplementation(
        mockGit((args) => {
          if (args.at(0) === "tag" || args.at(0) === "push") {
            return commandResult();
          }
        }),
      );

      await runPluginTasks(
        plugin,
        context,
        publishPlan(context.graph, { packages: [{ pkg: core }] }),
      );

      expect(exec.mock.calls.map(normalizeExecCall)).toMatchInlineSnapshot(`
        [
          {
            "args": [
              "tag",
              "@acme/core@1.0.1",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
          {
            "args": [
              "push",
              "origin",
              "@acme/core@1.0.1",
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

  test("pushes duplicate local tags so retries cannot strand them", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = git();
      const context = pluginContext();
      const core = context.graph.get("test:@acme/core")!;
      exec.mockImplementation(
        mockGit((args) => {
          if (args.at(0) === "tag") {
            return commandResult({
              exitCode: 128,
              stderr: "fatal: tag '@acme/core@1.0.1' already exists",
            });
          }

          if (args.at(0) === "push") return commandResult();
        }),
      );

      await runPluginTasks(
        plugin,
        context,
        publishPlan(context.graph, { packages: [{ pkg: core }] }),
      );

      expect(exec.mock.calls.map(normalizeExecCall)).toEqual([
        {
          args: ["tag", "@acme/core@1.0.1"],
          command: "git",
          cwd: "/repo",
          throwOnError: undefined,
        },
        {
          args: ["push", "origin", "@acme/core@1.0.1"],
          command: "git",
          cwd: "/repo",
          throwOnError: undefined,
        },
      ]);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("accepts a concurrent push when the remote tag matches", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = git();
      const context = pluginContext();
      const core = context.graph.get("test:@acme/core")!;
      exec.mockImplementation(
        mockGit((args) => {
          if (args.at(0) === "tag") {
            return commandResult();
          }

          if (args.at(0) === "push") {
            return commandResult({
              exitCode: 1,
              stderr:
                "! [rejected] @acme/core@1.0.1 -> @acme/core@1.0.1 (already exists)\nerror: failed to push some refs",
            });
          }

          if (args.at(0) === "rev-parse") return commandResult({ stdout: "abc123\n" });
          if (args.at(0) === "ls-remote") {
            return commandResult({ stdout: "abc123\trefs/tags/@acme/core@1.0.1\n" });
          }
        }),
      );

      await expect(
        runPluginTasks(plugin, context, publishPlan(context.graph, { packages: [{ pkg: core }] })),
      ).resolves.toBeUndefined();

      expect(exec.mock.calls.map(normalizeExecCall)).toEqual([
        {
          args: ["tag", "@acme/core@1.0.1"],
          command: "git",
          cwd: "/repo",
          throwOnError: undefined,
        },
        {
          args: ["push", "origin", "@acme/core@1.0.1"],
          command: "git",
          cwd: "/repo",
          throwOnError: undefined,
        },
        {
          args: ["rev-parse", "refs/tags/@acme/core@1.0.1^{}"],
          command: "git",
          cwd: "/repo",
          throwOnError: undefined,
        },
        {
          args: [
            "ls-remote",
            "--tags",
            "origin",
            "refs/tags/@acme/core@1.0.1",
            "refs/tags/@acme/core@1.0.1^{}",
          ],
          command: "git",
          cwd: "/repo",
          throwOnError: undefined,
        },
      ]);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("throws when git tag creation fails", async () => {
    const plugin = git();
    const context = pluginContext();
    const core = context.graph.get("test:@acme/core")!;
    exec.mockImplementation(
      mockGit((args) => {
        if (args.at(0) === "tag") {
          return commandResult({ exitCode: 1, stderr: "tag failed" });
        }
      }),
    );

    await expect(
      runPluginTasks(plugin, context, publishPlan(context.graph, { packages: [{ pkg: core }] })),
    ).rejects.toThrow(/tag failed/);
  });

  test("resolves task status as done when tag exists locally", async () => {
    const plugin = git();
    const context = pluginContext();
    const core = context.graph.get("test:@acme/core")!;
    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "rev-parse") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const status = await pluginTaskStatus(
      plugin,
      context,
      publishPlan(context.graph, { packages: [{ pkg: core }] }),
    );

    expect(status).toBeUndefined();
    expect(exec.mock.calls.map(normalizeExecCall)).toEqual([
      {
        args: ["rev-parse", "-q", "--verify", "refs/tags/@acme/core@1.0.1"],
        command: "git",
        cwd: "/repo",
        throwOnError: undefined,
      },
    ]);
  });

  test("resolves task status as done when tag exists on origin", async () => {
    const plugin = git();
    const context = pluginContext();
    const core = context.graph.get("test:@acme/core")!;
    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "rev-parse") {
        return commandResult({ exitCode: 1 });
      }

      if (args.at(0) === "ls-remote") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const status = await pluginTaskStatus(
      plugin,
      context,
      publishPlan(context.graph, { packages: [{ pkg: core }] }),
    );

    expect(status).toBeUndefined();
    expect(exec.mock.calls.map(normalizeExecCall)).toEqual([
      {
        args: ["rev-parse", "-q", "--verify", "refs/tags/@acme/core@1.0.1"],
        command: "git",
        cwd: "/repo",
        throwOnError: undefined,
      },
      {
        args: ["ls-remote", "--exit-code", "--tags", "origin", "refs/tags/@acme/core@1.0.1"],
        command: "git",
        cwd: "/repo",
        throwOnError: undefined,
      },
    ]);
  });

  test("resolves task status as pending when tag is missing", async () => {
    const plugin = git();
    const context = pluginContext();
    const core = context.graph.get("test:@acme/core")!;
    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "rev-parse") {
        return commandResult({ exitCode: 1 });
      }

      if (args.at(0) === "ls-remote") {
        return commandResult({ exitCode: 2 });
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const status = await pluginTaskStatus(
      plugin,
      context,
      publishPlan(context.graph, { packages: [{ pkg: core }] }),
    );

    expect(status).toBe("pending");
  });

  test("resolves push status as pending while a tag is missing from origin", async () => {
    const plugin = git({ pushTags: true });
    const context = pluginContext();
    const core = context.graph.get("test:@acme/core")!;
    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "rev-parse") return commandResult();
      if (args.at(0) === "ls-remote") return commandResult({ exitCode: 2 });
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const status = await pluginTaskStatus(
      plugin,
      context,
      publishPlan(context.graph, { packages: [{ pkg: core }] }),
    );

    expect(status).toBe("pending");
  });
});

function pluginContext(): TegamiContext {
  return {
    cwd: "/repo",
    changelogDir: "/repo/.tegami",
    lockPath: "/repo/.tegami/publish-lock.yaml",
    options: {},
    plugins: [],
    graph: new PackageGraph([
      workspacePackage("@acme/core", "/repo/packages/core"),
      workspacePackage("@acme/ui", "/repo/packages/ui"),
    ]),
  };
}

function workspacePackage(name: string, path: string): WorkspacePackage {
  return new TestPackage(name, path);
}

class TestPackage extends WorkspacePackage {
  readonly manager = "test";
  readonly version = "1.0.1";
  readonly publish = true;

  constructor(
    readonly name: string,
    readonly path: string,
  ) {
    super();
  }

  setVersion(): void {}

  async updateDependency(): Promise<void> {}

  async write(): Promise<void> {}
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

function mockGit(handler: (args: readonly string[]) => ReturnType<typeof x> | undefined) {
  return (_command: string, args?: readonly string[]) => {
    const argv = args ?? [];
    const result = handler(argv);
    if (result) return result;

    throw new Error(`Unexpected command: ${argv.join(" ")}`);
  };
}

function normalizeExecCall([command, args, options]: Parameters<typeof x>) {
  return {
    command,
    args,
    cwd: typeof options?.nodeOptions?.cwd === "string" ? options.nodeOptions.cwd : undefined,
    throwOnError: options?.throwOnError,
  };
}
