import * as tinyexec from "tinyexec";
import { x } from "tinyexec";
import { beforeEach, describe, expect, test, vi } from "vitest";
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

const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockClear();
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

    exec.mockImplementation(mockGit({}));

    await runPluginTasks(plugin, context, plan);
    expect(exec.mock.calls.map(normalizeExecCall)).toEqual([
      {
        args: ["tag", "--list", "@acme/core@1.0.1", "@acme/ui@1.0.1"],
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
          "refs/tags/@acme/ui@1.0.1",
        ],
        command: "git",
        cwd: "/repo",
        throwOnError: undefined,
      },
      {
        args: ["tag", "@acme/core@1.0.1"],
        command: "git",
        cwd: "/repo",
        throwOnError: undefined,
      },
      {
        args: ["tag", "@acme/ui@1.0.1"],
        command: "git",
        cwd: "/repo",
        throwOnError: undefined,
      },
    ]);
  });

  test("creates git tags for skipped publish results", async () => {
    const plugin = git();
    const context = pluginContext();
    const core = context.graph.get("test:@acme/core")!;
    exec.mockImplementation(mockGit({}));

    await runPluginTasks(
      plugin,
      context,
      publishPlan(context.graph, {
        packages: [{ pkg: core, publishResult: { type: "skipped" } }],
      }),
    );

    expect(exec.mock.calls.map(normalizeExecCall).at(-1)).toEqual({
      args: ["tag", "@acme/core@1.0.1"],
      command: "git",
      cwd: "/repo",
      throwOnError: undefined,
    });
  });

  test("leaves tags that already exist on origin untouched", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const context = pluginContext();
      const core = context.graph.get("test:@acme/core")!;
      exec.mockImplementation(mockGit({ origin: ["@acme/core@1.0.1"] }));

      await runPluginTasks(
        git(),
        context,
        publishPlan(context.graph, { packages: [{ pkg: core }] }),
      );

      // neither created nor pushed, the commit the origin tag points at is not ours to change
      expect(exec.mock.calls.map(([, args]) => args?.at(0))).toEqual(["tag", "ls-remote"]);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
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
      exec.mockImplementation(mockGit({}));

      await runPluginTasks(
        plugin,
        context,
        publishPlan(context.graph, { packages: [{ pkg: core }] }),
      );

      expect(exec.mock.calls.map(normalizeExecCall).slice(2)).toEqual([
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

  test("pushes tags that exist locally so retries cannot strand them", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = git();
      const context = pluginContext();
      const core = context.graph.get("test:@acme/core")!;
      exec.mockImplementation(mockGit({ local: ["@acme/core@1.0.1"] }));

      await runPluginTasks(
        plugin,
        context,
        publishPlan(context.graph, { packages: [{ pkg: core }] }),
      );

      expect(exec.mock.calls.map(normalizeExecCall).slice(2)).toEqual([
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

  test("accepts a push rejected by a concurrent release", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = git();
      const context = pluginContext();
      const core = context.graph.get("test:@acme/core")!;
      exec.mockImplementation(
        mockGit({}, (args) => {
          if (args.at(0) === "push") {
            return commandResult({
              exitCode: 1,
              stderr:
                " ! [rejected]        @acme/core@1.0.1 -> @acme/core@1.0.1 (already exists)\nerror: failed to push some refs",
            });
          }
        }),
      );

      await expect(
        runPluginTasks(plugin, context, publishPlan(context.graph, { packages: [{ pkg: core }] })),
      ).resolves.toBeUndefined();
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("throws when a push is rejected for another reason", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const context = pluginContext();
      const core = context.graph.get("test:@acme/core")!;
      exec.mockImplementation(
        mockGit({}, (args) => {
          if (args.at(0) === "push") {
            return commandResult({ exitCode: 128, stderr: "fatal: Authentication failed" });
          }
        }),
      );

      await expect(
        runPluginTasks(git(), context, publishPlan(context.graph, { packages: [{ pkg: core }] })),
      ).rejects.toThrow(/Authentication failed/);
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
      mockGit({}, (args) => {
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
    exec.mockImplementation(mockGit({ local: ["@acme/core@1.0.1"] }));

    const status = await pluginTaskStatus(
      plugin,
      context,
      publishPlan(context.graph, { packages: [{ pkg: core }] }),
    );

    expect(status).toBeUndefined();
    expect(exec.mock.calls.map(normalizeExecCall)).toEqual([
      {
        args: ["tag", "--list", "@acme/core@1.0.1"],
        command: "git",
        cwd: "/repo",
        throwOnError: undefined,
      },
      {
        args: ["ls-remote", "--tags", "origin", "refs/tags/@acme/core@1.0.1"],
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
    // annotated tags are listed again as their peeled ref
    exec.mockImplementation(mockGit({ origin: ["@acme/core@1.0.1", "@acme/core@1.0.1^{}"] }));

    const status = await pluginTaskStatus(
      plugin,
      context,
      publishPlan(context.graph, { packages: [{ pkg: core }] }),
    );

    expect(status).toBeUndefined();
  });

  test("resolves task status as pending when tag is missing", async () => {
    const plugin = git();
    const context = pluginContext();
    const core = context.graph.get("test:@acme/core")!;
    exec.mockImplementation(mockGit({}));

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
    exec.mockImplementation(mockGit({ local: ["@acme/core@1.0.1"] }));

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

/** answer the tag lookups with the given state, `handler` takes over the remaining commands */
function mockGit(
  tags: { local?: string[]; origin?: string[] },
  handler: (args: readonly string[]) => ReturnType<typeof x> | undefined = () => undefined,
) {
  return (_command: string, args: readonly string[] = []) => {
    if (args.at(0) === "tag" && args.at(1) === "--list") {
      return commandResult({ stdout: `${(tags.local ?? []).join("\n")}\n` });
    }

    if (args.at(0) === "ls-remote") {
      const refs = (tags.origin ?? []).map((tag) => `0000000\trefs/tags/${tag}`);
      return commandResult({ stdout: `${refs.join("\n")}\n` });
    }

    // creating & pushing tags succeeds unless the test says otherwise
    return handler(args) ?? commandResult();
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
