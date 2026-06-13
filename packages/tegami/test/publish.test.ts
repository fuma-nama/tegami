import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { createTegamiContext } from "../src/context";
import type { PublishOptions } from "../src/publish";
import { publishFromPlan } from "../src/publish";
import { publishPlanSchema } from "../src/schemas";

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
      await createPublishContext(cwd, planPath, {
        dryRun: true,
      }),
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
      await createPublishContext(cwd, planPath, {
        dryRun: false,
        gitTags: false,
        npmClient: "npm",
      }),
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
      changelogs: Array<{
        id: string;
        file: string;
        packages: string[];
        type: "major" | "minor" | "patch";
        title: string;
        content: string;
      }>;
      packages: Array<{
        changelogIds: string[];
      }>;
    }>(planPath);
    plan.changelogs = [
      {
        id: "change-1",
        file: "/repo/.tegami/change.md",
        packages: ["core"],
        type: "minor",
        title: "Add proxy server",
        content: "Some description.",
      },
    ];
    plan.packages[0]!.changelogIds = ["change-1"];
    await writeJson(planPath, plan);

    const result = await publishFixture(
      planPath,
      await createPublishContext(cwd, planPath, {
        dryRun: true,
      }),
    );

    expect(result.packages[0]?.changelogs).toEqual(plan.changelogs);
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
      await createPublishContext(cwd, planPath, {
        npmClient: "npm",
      }),
    );

    expect(result.state).toBe("success");
    expect(result.packages.every((pkg) => pkg.state === "success")).toBe(true);
    expect(exec).toHaveBeenNthCalledWith(
      1,
      "npm",
      ["view", "@acme/core@1.0.1", "version", "--json"],
      expect.any(Object),
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "npm",
      ["publish", "--tag", "latest"],
      expect.objectContaining({
        nodeOptions: {
          cwd: corePath,
        },
      }),
    );
    expect(exec).toHaveBeenNthCalledWith(
      3,
      "npm",
      ["view", "@acme/ui@1.0.1", "version", "--json"],
      expect.any(Object),
    );
    expect(exec).toHaveBeenNthCalledWith(
      4,
      "npm",
      ["publish", "--tag", "latest"],
      expect.objectContaining({
        nodeOptions: {
          cwd: uiPath,
        },
      }),
    );
    expect(exec).toHaveBeenNthCalledWith(5, "git", ["rev-parse", "-q", "--verify", "refs/tags/@acme/core@1.0.1"], expect.any(Object));
    expect(exec).toHaveBeenNthCalledWith(6, "git", ["tag", "@acme/core@1.0.1"], expect.any(Object));
    expect(exec).toHaveBeenNthCalledWith(7, "git", ["rev-parse", "-q", "--verify", "refs/tags/@acme/ui@1.0.1"], expect.any(Object));
    expect(exec).toHaveBeenNthCalledWith(8, "git", ["tag", "@acme/ui@1.0.1"], expect.any(Object));
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
      await createPublishContext(cwd, planPath, {
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
      await createPublishContext(cwd, planPath, {
        dryRun: false,
        gitTags: false,
        npmClient: "pnpm",
      }),
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

  test("publishes legacy plans without using status as source of truth", async () => {
    const { cwd, planPath } = await createPublishFixture({
      legacyStatus: "completed",
    });

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
      await createPublishContext(cwd, planPath, {
        dryRun: false,
        gitTags: false,
        npmClient: "npm",
      }),
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
      2,
      "npm",
      ["publish", "--tag", "latest"],
      expect.any(Object),
    );
  });

  test("throws from root publish when no publish plan exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-publish-"));
    tempDirs.push(cwd);

    await expect(tegami({ cwd }).publish()).rejects.toThrow(/No publish plan found/);
  });
});

async function createPublishFixture(
  options: { registry?: string; legacyStatus?: "pending" | "completed" } = {},
): Promise<{
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
    ...(options.legacyStatus ? { status: options.legacyStatus } : {}),
    changelogs: [],
    packages: [
      {
        name: "@acme/core",
        version: "1.0.1",
        changelogIds: [],
        distTag: "latest",
        gitTag: false,
        publish: true,
      },
    ],
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
    changelogs: [],
    packages: [packageRelease("@acme/core"), packageRelease("@acme/ui")],
  });

  return {
    cwd,
    corePath,
    uiPath,
    planPath,
  };
}

function packageRelease(name: string) {
  return {
    name,
    version: "1.0.1",
    changelogIds: [] as string[],
    distTag: "latest",
    gitTag: `${name}@1.0.1`,
    publish: true,
  };
}

function createPublishContext(cwd: string, planPath: string, publish?: PublishOptions) {
  return createTegamiContext({
    cwd,
    planPath,
    publish,
  });
}

async function publishFixture(
  planPath: string,
  context: Awaited<ReturnType<typeof createTegamiContext>>,
) {
  return publishFromPlan(context, await publishPlanSchema.decode(await readFile(planPath, "utf8")));
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
