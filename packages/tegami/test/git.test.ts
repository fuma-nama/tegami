import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tinyexec from "tinyexec";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PackagePublishResult, PublishResult } from "../src/publish";
import { git } from "../src/plugins/git";
import { PackageGraph, WorkspacePackage } from "../src/graph";

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

      await plugin.cli?.init?.call(pluginContext());

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
    const result = publishResult({
      packages: [
        packageResult({
          name: "@acme/core",
          version: "1.0.1",
        }),
        packageResult({
          name: "@acme/ui",
          version: "1.0.1",
        }),
      ],
    });

    if (result.state !== "created") throw new Error("must be created");

    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "rev-parse") {
        return commandResult({
          exitCode: 1,
        });
      }

      if (args.at(0) === "tag") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const next = await plugin.afterPublish?.call(pluginContext(), result);
    expect(next).toBe(result);
    expect(result.packages.map((pkg) => pkg.gitTag)).toEqual([
      "@acme/core@1.0.1",
      "@acme/ui@1.0.1",
    ]);
    expect(exec.mock.calls.map(normalizeExecCall)).toMatchInlineSnapshot(`
      [
        {
          "args": [
            "rev-parse",
            "-q",
            "--verify",
            "refs/tags/@acme/core@1.0.1",
          ],
          "command": "git",
          "cwd": "/repo",
          "throwOnError": undefined,
        },
        {
          "args": [
            "rev-parse",
            "-q",
            "--verify",
            "refs/tags/@acme/ui@1.0.1",
          ],
          "command": "git",
          "cwd": "/repo",
          "throwOnError": undefined,
        },
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

  test("skips plugin tags on dry runs, disabled tags, and failed publishes", async () => {
    await git().afterPublish?.call(pluginContext({ dryRun: true }), publishResult());
    await git({ createTags: false }).afterPublish?.call(pluginContext(), publishResult());
    await git().afterPublish?.call(
      pluginContext(),
      publishResult({
        state: "failed",
      }),
    );

    expect(exec).not.toHaveBeenCalled();
  });

  test("pushes newly created tags in CI", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";

    try {
      const plugin = git();
      exec.mockImplementation((_command, args = []) => {
        if (args.at(0) === "rev-parse") {
          return commandResult({
            exitCode: 1,
          });
        }

        if (args.at(0) === "tag" || args.at(0) === "push") {
          return commandResult();
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      await plugin.afterPublish?.call(pluginContext(), publishResult());

      expect(exec.mock.calls.map(normalizeExecCall)).toMatchInlineSnapshot(`
        [
          {
            "args": [
              "rev-parse",
              "-q",
              "--verify",
              "refs/tags/@acme/core@1.0.1",
            ],
            "command": "git",
            "cwd": "/repo",
            "throwOnError": undefined,
          },
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

  test("marks the publish result failed when git tag creation fails", async () => {
    const plugin = git();
    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "rev-parse") {
        return commandResult({
          exitCode: 1,
        });
      }

      if (args.at(0) === "tag") {
        return commandResult({ exitCode: 1, stderr: "tag failed" });
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await plugin.afterPublish?.call(pluginContext(), publishResult());

    expect(result).toMatchObject({
      state: "failed",
      error: expect.stringContaining("tag failed"),
    });
  });
});

function pluginContext(publishOptions: { dryRun?: boolean } = {}) {
  return {
    cwd: "/repo",
    changelogDir: ".tegami",
    planPath: "/repo/.tegami/publish-plan",
    options: {},
    plugins: [],
    publishOptions,
    graph: new PackageGraph([
      workspacePackage("@acme/core", "/repo/packages/core"),
      workspacePackage("@acme/ui", "/repo/packages/ui"),
    ]),
    getRegistryClient: registryClient,
  };
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
    packages: [packageResult()],
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
