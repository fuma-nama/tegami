import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { createTegamiContext, TegamiContext } from "../src/context";
import type { PackagePublishResult, PublishOptions, PublishResult } from "../src/publish";
import { publishFromPlan } from "../src/publish";
import { cleanupPublishPlan } from "../src/plans/draft";
import { parsePlanStore } from "../src/plans/store";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const tempDirs: string[] = [];
const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockReset();
  mockPendingPlan();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("publish plans", () => {
  test("skips registry and publish commands for dry runs", async () => {
    const { cwd, planPath } = await createPublishFixture({
      registry: "https://registry.example.test",
    });

    const result = createdResult(
      await publishFixture(
        planPath,
        await createTegamiContext({
          cwd,
          planPath,
        }),
        {
          dryRun: true,
        },
      ),
    );

    expect(result.packages).toEqual([
      expect.objectContaining({
        name: "@acme/core",
        state: "success",
      }),
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      "pnpm",
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

  test("skips publish when the plan is already finished", async () => {
    const { cwd, planPath } = await createPublishFixture({
      registry: "https://registry.example.test",
    });

    exec.mockResolvedValue(execResult({ exitCode: 0, stdout: '"1.0.1"\n' }));

    await expect(
      publishFixture(
        planPath,
        await createTegamiContext({
          cwd,
          planPath,
          npm: { client: "npm" },
        }),
        {
          dryRun: false,
        },
      ),
    ).resolves.toEqual({ state: "skipped" });

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
          packages: Record<string, "major" | "minor" | "patch">;
          sections: { depth: number; title: string; content: string }[];
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
        packages: { "@acme/core": "minor" },
        sections: [{ depth: 2, title: "Add proxy server", content: "Some description." }],
      },
    };
    plan.packages["npm:@acme/core"]!.changelogIds = ["change-1"];
    await writeJson(planPath, plan);

    const result = createdResult(
      await publishFixture(
        planPath,
        await createTegamiContext({
          cwd,
          planPath,
        }),
        { dryRun: true },
      ),
    );

    expect(result.packages[0]?.changelogs.map(normalizeChangelog)).toMatchInlineSnapshot(`
      [
        {
          "filename": "change.md",
          "id": "change-1",
          "packages": {
            "@acme/core": "minor",
          },
          "sections": [
            {
              "content": "Some description.",
              "depth": 2,
              "title": "Add proxy server",
            },
          ],
        },
      ]
    `);
  });

  test("does not run plugin work when any package publish fails", async () => {
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
        if (typeof cwd === "string" && normalizeDirPath(cwd).endsWith("packages/ui")) {
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
      }),
    );

    expect(result.state).toBe("failed");
    if (result.state === "failed")
      expect(result.packages).toContainEqual(
        expect.objectContaining({
          name: "@acme/ui",
          state: "failed",
          error: "publish failed",
        }),
      );
    expect(exec.mock.calls.every(([, args]) => args?.at(0) !== "tag")).toBe(true);
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

    const result = createdResult(
      await publishFixture(
        planPath,
        await createTegamiContext({
          cwd,
          planPath,
        }),
        {
          dryRun: false,
        },
      ),
    );

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
    expect(exec.mock.calls[1]?.[0]).toBe("pnpm");
    expect(exec.mock.calls[1]?.[1]).toEqual(["publish", "--tag", "latest", "--no-git-checks"]);
    expect(normalizeDirPath(String(exec.mock.calls[1]?.[2]?.nodeOptions?.cwd))).toBe(
      normalizeDirPath(packagePath),
    );
  });

  test("skips publish when pending changelog entries exist", async () => {
    const { cwd, planPath } = await createPublishFixture();

    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages: ["@acme/core"]
---

## Pending change

Not versioned yet.
`,
    );

    await expect(tegami({ cwd, planPath }).publish()).resolves.toEqual({
      state: "skipped",
    });
    expect(exec).not.toHaveBeenCalled();
  });

  test("skips publish when no publish plan exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-publish-"));
    tempDirs.push(cwd);

    await expect(tegami({ cwd }).publish()).resolves.toEqual({
      state: "skipped",
    });
  });

  test("skips publish when the plan has no publishable packages", async () => {
    const { cwd, planPath } = await createPublishFixture();

    await writeJson(planPath, {
      id: "tegami-test",
      createdAt: "2026-01-01T00:00:00.000Z",
      changelogs: {},
      packages: {
        "npm:@acme/core": {
          type: "patch",
          changelogIds: [],
          npm: { distTag: "latest" },
          publish: false,
        },
      },
    });

    const result = await publishFixture(
      planPath,
      await createTegamiContext({
        cwd,
        planPath,
      }),
    );

    expect(result).toEqual({
      state: "skipped",
    });
  });
});

describe("cleanup publish plan", () => {
  test("removes the publish plan when publishing has finished", async () => {
    const { cwd, planPath } = await createPublishFixture({
      registry: "https://registry.example.test",
    });

    exec.mockResolvedValue(execResult({ exitCode: 0, stdout: '"1.0.1"\n' }));

    const context = await createTegamiContext({
      cwd,
      planPath,
      npm: { client: "npm" },
    });

    await expect(cleanupPublishPlan(context)).resolves.toEqual({
      state: "removed",
    });
    await expect(access(planPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("skips cleanup when the publish plan is still pending", async () => {
    const { cwd, planPath } = await createPublishFixture();

    const context = await createTegamiContext({
      cwd,
      planPath,
    });

    await expect(cleanupPublishPlan(context)).resolves.toEqual({
      state: "skipped",
      reason: "pending",
    });
    await expect(readFile(planPath, "utf8")).resolves.toBeTruthy();
  });

  test("skips cleanup when no publish plan exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-publish-cleanup-"));
    tempDirs.push(cwd);
    const planPath = join(cwd, ".tegami/publish-plan");

    const context = await createTegamiContext({ cwd, planPath });

    await expect(cleanupPublishPlan(context)).resolves.toEqual({
      state: "skipped",
      reason: "missing",
    });
  });

  test("tegami.cleanup removes a finished publish plan", async () => {
    const { cwd, planPath } = await createPublishFixture({
      registry: "https://registry.example.test",
    });

    exec.mockResolvedValue(execResult({ exitCode: 0, stdout: '"1.0.1"\n' }));

    await expect(tegami({ cwd, planPath, npm: { client: "npm" } }).cleanup()).resolves.toEqual({
      state: "removed",
    });
  });
});

async function createPublishFixture(options: { registry?: string } = {}): Promise<{
  cwd: string;
  packagePath: string;
  planPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-publish-"));
  const packagePath = join(cwd, "packages/core");
  const planPath = join(cwd, ".tegami/publish-plan");
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
      "npm:@acme/core": {
        type: "patch",
        changelogIds: [],
        npm: { distTag: "latest" },
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
  const planPath = join(cwd, ".tegami/publish-plan");
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
      "npm:@acme/core": packageRelease(),
      "npm:@acme/ui": packageRelease(),
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
    npm: { distTag: "latest" },
    publish: true,
  };
}

async function publishFixture(
  planPath: string,
  context: TegamiContext,
  PublishOptions: PublishOptions = {},
) {
  return publishFromPlan(context, parsePlanStore(await readFile(planPath, "utf8")), PublishOptions);
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

function mockPendingPlan() {
  exec.mockResolvedValue(
    execResult({
      exitCode: 1,
      stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
    }),
  );
}

function createdResult(result: PublishResult) {
  expect(result.state).toBe("created");
  if (result.state !== "created") throw new Error(`expected created, got ${result.state}`);
  return result;
}

function normalizeChangelog(changelog: PackagePublishResult["changelogs"][number]) {
  return {
    ...changelog,
    packages: Object.fromEntries(changelog.packages),
  };
}

function normalizeDirPath(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
}
