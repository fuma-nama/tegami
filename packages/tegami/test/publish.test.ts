import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { createTegamiContext, TegamiContext } from "../src/context";
import type { PublishOptions, PublishResult } from "../src/publish";
import { publishFromPlan } from "../src/publish";
import { planStoreSchema } from "../src/schemas";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const tempDirs: string[] = [];
const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockReset();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("publish plans", () => {
  test("skips registry and publish commands for dry runs", async () => {
    const { cwd, planPath } = await createPublishFixture({
      registry: "https://registry.example.test",
    });

    const result = await publishFixture(
      planPath,
      await createTegamiContext({
        cwd,
        planPath,
      }),
      {
        dryRun: true,
      },
    );

    expect(result.state).toBe("success");
    expect(result.packages).toEqual([
      expect.objectContaining({
        name: "@acme/core",
        state: "success",
      }),
    ]);
    expect(exec).not.toHaveBeenCalled();
  });

  test("does not republish versions that already exist in the registry", async () => {
    const { cwd, planPath } = await createPublishFixture({
      registry: "https://registry.example.test",
    });

    exec.mockResolvedValue(execResult({ exitCode: 0, stdout: '"1.0.1"\n' }));

    const result = await publishFixture(
      planPath,
      await createTegamiContext({
        cwd,
        planPath,
        npmClient: "npm",
      }),
      {
        dryRun: false,
        gitTags: false,
      },
    );

    expect(result.state).toBe("success");
    expect(result.packages).toEqual([
      expect.objectContaining({
        name: "@acme/core",
        state: "success",
      }),
    ]);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      "npm",
      [
        "view",
        "@acme/core@1.0.1",
        "version",
        "--json",
        "--registry",
        "https://registry.example.test",
      ],
      {
        nodeOptions: {
          cwd,
        },
      },
    );
  });

  test("derives package changelogs from top-level plan changelogs", async () => {
    const { cwd, planPath } = await createPublishFixture();
    const plan = await readJson<{
      changelogs: Record<
        string,
        {
          filename: string;
          packages: string[];
          type: "major" | "minor" | "patch";
          title: string;
          content: string;
        }
      >;
      packages: Record<
        string,
        {
          changelogIds: string[];
        }
      >;
    }>(planPath);
    plan.changelogs = {
      "change-1": {
        filename: "change.md",
        packages: ["@acme/core"],
        type: "minor",
        title: "Add proxy server",
        content: "Some description.",
      },
    };
    plan.packages["@acme/core"]!.changelogIds = ["change-1"];
    await writeJson(planPath, plan);

    const result = await publishFixture(
      planPath,
      await createTegamiContext({
        cwd,
        planPath,
      }),
      { dryRun: true },
    );

    expect(result.packages[0]?.changelogs.map(normalizeChangelog)).toMatchInlineSnapshot(`
      [
        {
          "content": "Some description.",
          "filename": "change.md",
          "id": "change-1",
          "packages": [
            "@acme/core",
          ],
          "title": "Add proxy server",
          "type": "minor",
        },
      ]
    `);
  });

  test("creates git tags after all packages publish successfully", async () => {
    const { cwd, corePath, uiPath, planPath } = await createMultiPackagePublishFixture();

    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "view") {
        return commandResult({
          exitCode: 1,
          stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
        });
      }

      if (args.at(0) === "rev-parse") {
        return commandResult({
          exitCode: 1,
        });
      }

      if (args.at(0) === "publish" || args.at(0) === "tag") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await publishFixture(
      planPath,
      await createTegamiContext({
        cwd,
        planPath,
        npmClient: "npm",
      }),
    );

    expect(result.state).toBe("success");
    expect(result.packages.every((pkg) => pkg.state === "success")).toBe(true);
    expect(
      exec.mock.calls.map((call) =>
        normalizeExecCall(call, {
          cwd,
          corePath,
          uiPath,
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "args": [
            "view",
            "@acme/core@1.0.1",
            "version",
            "--json",
          ],
          "command": "npm",
          "cwd": "<workspace>",
          "throwOnError": undefined,
        },
        {
          "args": [
            "publish",
            "--tag",
            "latest",
          ],
          "command": "npm",
          "cwd": "<core>",
          "throwOnError": true,
        },
        {
          "args": [
            "view",
            "@acme/ui@1.0.1",
            "version",
            "--json",
          ],
          "command": "npm",
          "cwd": "<workspace>",
          "throwOnError": undefined,
        },
        {
          "args": [
            "publish",
            "--tag",
            "latest",
          ],
          "command": "npm",
          "cwd": "<ui>",
          "throwOnError": true,
        },
        {
          "args": [
            "rev-parse",
            "-q",
            "--verify",
            "refs/tags/@acme/core@1.0.1",
          ],
          "command": "git",
          "cwd": "<core>",
          "throwOnError": undefined,
        },
        {
          "args": [
            "tag",
            "@acme/core@1.0.1",
          ],
          "command": "git",
          "cwd": "<core>",
          "throwOnError": true,
        },
        {
          "args": [
            "rev-parse",
            "-q",
            "--verify",
            "refs/tags/@acme/ui@1.0.1",
          ],
          "command": "git",
          "cwd": "<ui>",
          "throwOnError": undefined,
        },
        {
          "args": [
            "tag",
            "@acme/ui@1.0.1",
          ],
          "command": "git",
          "cwd": "<ui>",
          "throwOnError": true,
        },
      ]
    `);
  });

  test("does not create git tags when any package publish fails", async () => {
    const { cwd, planPath } = await createMultiPackagePublishFixture();

    exec.mockImplementation((_command, args = [], options = {}) => {
      if (args.at(0) === "view") {
        return commandResult({
          exitCode: 1,
          stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
        });
      }

      if (args.at(0) === "publish") {
        const cwd = options.nodeOptions?.cwd;
        if (typeof cwd === "string" && cwd.endsWith("packages/ui")) {
          throw new Error("publish failed");
        }

        return commandResult();
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await publishFixture(
      planPath,
      await createTegamiContext({
        cwd,
        planPath,
        npmClient: "npm",
      }),
    );

    expect(result.state).toBe("failed");
    expect(result.packages).toContainEqual(
      expect.objectContaining({
        name: "@acme/ui",
        state: "failed",
        error: "publish failed",
      }),
    );
    expect(exec.mock.calls.some(([, args]) => args?.at(0) === "tag")).toBe(false);
  });

  test("publishes versions that are missing from the registry", async () => {
    const { cwd, packagePath, planPath } = await createPublishFixture();

    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "view") {
        return commandResult({
          exitCode: 1,
          stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
        });
      }

      if (args.at(0) === "publish") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await publishFixture(
      planPath,
      await createTegamiContext({
        cwd,
        planPath,
        npmClient: "pnpm",
      }),
      {
        dryRun: false,
        gitTags: false,
      },
    );

    expect(result.state).toBe("success");
    expect(result.packages).toEqual([
      expect.objectContaining({
        name: "@acme/core",
        state: "success",
        version: "1.0.1",
      }),
    ]);
    expect(exec).toHaveBeenNthCalledWith(
      1,
      "pnpm",
      ["view", "@acme/core@1.0.1", "version", "--json"],
      {
        nodeOptions: {
          cwd,
        },
      },
    );
    expect(exec).toHaveBeenNthCalledWith(2, "pnpm", ["publish", "--tag", "latest"], {
      nodeOptions: {
        cwd: packagePath,
      },
      throwOnError: true,
    });
    await expect(readFile(planPath, "utf8")).resolves.toContain("@acme/core");
  });

  test("throws from root publish when no publish plan exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-publish-"));
    tempDirs.push(cwd);

    await expect(tegami({ cwd }).publish()).rejects.toThrow(/No publish plan found/);
  });
});

async function createPublishFixture(options: { registry?: string } = {}): Promise<{
  cwd: string;
  packagePath: string;
  planPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-publish-"));
  const packagePath = join(cwd, "packages/core");
  const planPath = join(cwd, ".tegami/publish-plan.json");
  tempDirs.push(cwd);

  await mkdir(packagePath, { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeJson(join(packagePath, "package.json"), {
    name: "@acme/core",
    version: "1.0.1",
    ...(options.registry
      ? {
          publishConfig: {
            registry: options.registry,
          },
        }
      : {}),
  });
  const storedPlan = {
    id: "tegami-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    changelogs: {},
    packages: {
      "@acme/core": {
        type: "patch",
        changelogIds: [],
        distTag: "latest",
        publish: true,
      },
    },
  };

  await writeJson(planPath, storedPlan);

  return {
    cwd,
    packagePath,
    planPath,
  };
}

async function createMultiPackagePublishFixture(): Promise<{
  cwd: string;
  corePath: string;
  uiPath: string;
  planPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-publish-"));
  const corePath = join(cwd, "packages/core");
  const uiPath = join(cwd, "packages/ui");
  const planPath = join(cwd, ".tegami/publish-plan.json");
  tempDirs.push(cwd);

  await mkdir(corePath, { recursive: true });
  await mkdir(uiPath, { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeJson(join(corePath, "package.json"), {
    name: "@acme/core",
    version: "1.0.1",
  });
  await writeJson(join(uiPath, "package.json"), {
    name: "@acme/ui",
    version: "1.0.1",
  });
  await writeJson(planPath, {
    id: "tegami-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    changelogs: {},
    packages: {
      "@acme/core": packageRelease(),
      "@acme/ui": packageRelease(),
    },
  });

  return {
    cwd,
    corePath,
    uiPath,
    planPath,
  };
}

function packageRelease() {
  return {
    type: "patch",
    changelogIds: [] as string[],
    distTag: "latest",
    publish: true,
  };
}

async function publishFixture(
  planPath: string,
  context: TegamiContext,
  PublishOptions: PublishOptions = {},
) {
  return publishFromPlan(
    context,
    planStoreSchema.decode(await readFile(planPath, "utf8")),
    PublishOptions,
  );
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

type ExecResult = Awaited<ReturnType<typeof x>>;

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  } as ExecResult;
}

function commandResult(overrides: Partial<ExecResult> = {}): ReturnType<typeof x> {
  return execResult(overrides) as unknown as ReturnType<typeof x>;
}

function normalizeChangelog(
  changelog: NonNullable<PublishResult["packages"][number]["changelogs"]>[number],
) {
  return {
    ...changelog,
    packages: Array.from(changelog.packages),
  };
}

function normalizeExecCall(
  [command, args, options]: Parameters<typeof x>,
  paths: {
    cwd: string;
    corePath: string;
    uiPath: string;
  },
) {
  return {
    command,
    args,
    cwd: normalizeCwd(
      typeof options?.nodeOptions?.cwd === "string" ? options.nodeOptions.cwd : undefined,
      paths,
    ),
    throwOnError: options?.throwOnError,
  };
}

function normalizeCwd(
  cwd: string | undefined,
  paths: {
    cwd: string;
    corePath: string;
    uiPath: string;
  },
) {
  if (cwd === paths.cwd) return "<workspace>";
  if (cwd === paths.corePath) return "<core>";
  if (cwd === paths.uiPath) return "<ui>";
  return cwd;
}
