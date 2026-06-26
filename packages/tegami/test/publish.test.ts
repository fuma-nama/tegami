import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { createTegamiContext } from "../src/context";
import {
  cleanupPublishLock,
  initPublishPlan,
  runPreflights,
  runPublishPlan,
} from "../src/plans/publish";
import { writePublishLock } from "./helpers/lock";
import {
  fetchMock,
  installRegistryFetchMock,
  mockRegistryMissing,
  mockRegistryPublished,
  npmPackageVersionUrl,
  uninstallRegistryFetchMock,
} from "./helpers/registry-fetch";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const tempDirs: string[] = [];
const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockReset();
  installRegistryFetchMock();
  mockRegistryMissing();
  mockPendingPlan();
});

afterEach(async () => {
  uninstallRegistryFetchMock();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("publish plans", () => {
  test("skips registry and publish commands for dry runs", async () => {
    const { cwd, lockPath } = await createPublishFixture({
      registry: "https://registry.example.test",
    });

    const context = await createTegamiContext({ cwd, lockPath: lockPath });
    const plan = await publishFixture(context, { dryRun: true });
    const result = plan.packages.get("npm:@acme/core");

    expect(result?.publishResult).toEqual({ type: "published" });
    expect(fetchMock).toHaveBeenCalledWith(
      npmPackageVersionUrl("https://registry.example.test", "@acme/core", "1.0.1"),
      { headers: { Accept: "application/json" } },
    );
    expect(exec).not.toHaveBeenCalled();
  });

  test("skips publish when the plan is already finished", async () => {
    const { cwd, lockPath } = await createPublishFixture({
      registry: "https://registry.example.test",
    });

    mockRegistryPublished();

    await expect(
      tegami({
        cwd,
        lockPath: lockPath,
        npm: { client: "npm" },
      }).publish({ dryRun: false }),
    ).resolves.toBe("skipped");

    expect(fetchMock).toHaveBeenCalledWith(
      npmPackageVersionUrl("https://registry.example.test", "@acme/core", "1.0.1"),
      { headers: { Accept: "application/json" } },
    );
    expect(exec).not.toHaveBeenCalled();
  });

  test("derives package changelogs from top-level plan changelogs", async () => {
    const { cwd, lockPath } = await createPublishFixture();
    await writePublishLock(cwd, {
      path: lockPath,
      changelogs: [
        {
          filename: "change.md",
          content: `---
packages:
  "@acme/core": minor
---

## Add proxy server

Some description.
`,
        },
      ],
      packages: [{ id: "npm:@acme/core", updated: true, changelogIds: ["change.md"] }],
      npm: [{ id: "npm:@acme/core", distTag: "latest" }],
    });

    const context = await createTegamiContext({ cwd, lockPath: lockPath });
    const plan = await publishFixture(context, { dryRun: true });
    const changelogs = plan.packages.get("npm:@acme/core")?.changelogs ?? [];

    expect(changelogs.map(normalizeChangelog)).toMatchInlineSnapshot(`
      [
        {
          "filename": "change.md",
          "id": "change.md",
          "packages": {
            "@acme/core": {
              "type": "minor",
            },
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
    const { cwd, lockPath } = await createMultiPackagePublishFixture();

    exec.mockImplementation((_command, args = [], options = {}) => {
      if (args.at(0) === "publish") {
        const cwd = options.nodeOptions?.cwd;
        if (typeof cwd === "string" && normalizeDirPath(cwd).endsWith("packages/ui")) {
          return commandResult({ exitCode: 1, stderr: "publish failed" });
        }

        return commandResult();
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const context = await createTegamiContext({ cwd, lockPath: lockPath });
    const plan = await publishFixture(context);
    const ui = plan.packages.get("npm:@acme/ui");

    expect(ui?.publishResult).toMatchObject({
      type: "failed",
    });
    expect(exec.mock.calls.every(([, args]) => args?.at(0) !== "tag")).toBe(true);
  });

  test("publishes versions that are missing from the registry", async () => {
    const { cwd, packagePath, lockPath } = await createPublishFixture();

    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "publish") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const context = await createTegamiContext({ cwd, lockPath: lockPath });
    const plan = await publishFixture(context, { dryRun: false });
    const result = plan.packages.get("npm:@acme/core");

    expect(result?.publishResult).toEqual({ type: "published" });
    expect(fetchMock).toHaveBeenCalledWith(npmPackageVersionUrl(undefined, "@acme/core", "1.0.1"), {
      headers: { Accept: "application/json" },
    });
    expect(exec.mock.calls[0]?.[0]).toBe("pnpm");
    expect(exec.mock.calls[0]?.[1]).toEqual(["publish", "--tag", "latest", "--no-git-checks"]);
    expect(normalizeDirPath(String(exec.mock.calls[0]?.[2]?.nodeOptions?.cwd))).toBe(
      normalizeDirPath(packagePath),
    );
  });

  test("still publishes when only replay changelog files remain", async () => {
    const { cwd, lockPath } = await createPublishFixture();

    await writeFile(
      join(cwd, ".tegami/replay.md"),
      `---
packages:
  "@acme/core":
    replay: ["@acme/core@2.0.0"]
---

## Replay notes

Included again on 2.0.0.
`,
    );

    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "publish") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await tegami({ cwd, lockPath: lockPath }).publish();
    expect(result).not.toBe("skipped");
  });

  test("skips publish when no publish plan exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-publish-"));
    tempDirs.push(cwd);

    await expect(tegami({ cwd }).publish()).resolves.toBe("skipped");
  });

  test("skips publish when the plan has no publishable packages", async () => {
    const { cwd, lockPath } = await createPublishFixture();

    await writePublishLock(cwd, {
      path: lockPath,
      packages: [{ id: "npm:@acme/core", updated: false }],
      npm: [{ id: "npm:@acme/core", distTag: "latest" }],
    });

    await expect(
      tegami({
        cwd,
        lockPath: lockPath,
      }).publish(),
    ).resolves.toBe("skipped");
  });
});

describe("cleanup publish plan", () => {
  test("removes the publish plan when publishing has finished", async () => {
    const { cwd, lockPath } = await createPublishFixture({
      registry: "https://registry.example.test",
    });

    mockRegistryPublished();

    const context = await createTegamiContext({
      cwd,
      lockPath: lockPath,
      npm: { client: "npm" },
    });

    await expect(cleanupPublishLock(context)).resolves.toEqual({
      state: "removed",
    });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("skips cleanup when the publish plan is still pending", async () => {
    const { cwd, lockPath } = await createPublishFixture();

    const context = await createTegamiContext({
      cwd,
      lockPath: lockPath,
    });

    await expect(cleanupPublishLock(context)).resolves.toEqual({
      state: "skipped",
      reason: "pending",
    });
    await expect(readFile(lockPath, "utf8")).resolves.toBeTruthy();
  });

  test("skips cleanup when no publish plan exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-publish-cleanup-"));
    tempDirs.push(cwd);
    const lockPath = join(cwd, ".tegami/publish-lock.yaml");

    const context = await createTegamiContext({ cwd, lockPath: lockPath });

    await expect(cleanupPublishLock(context)).resolves.toEqual({
      state: "skipped",
      reason: "missing",
    });
  });

  test("tegami.cleanup removes a finished publish plan", async () => {
    const { cwd, lockPath } = await createPublishFixture({
      registry: "https://registry.example.test",
    });

    mockRegistryPublished();

    await expect(
      tegami({ cwd, lockPath: lockPath, npm: { client: "npm" } }).cleanup(),
    ).resolves.toEqual({
      state: "removed",
    });
  });
});

async function createPublishFixture(options: { registry?: string } = {}): Promise<{
  cwd: string;
  packagePath: string;
  lockPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-publish-"));
  const packagePath = join(cwd, "packages/core");
  const lockPath = join(cwd, ".tegami/publish-lock.yaml");
  tempDirs.push(cwd);

  await mkdir(packagePath, { recursive: true });
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
  await writePublishLock(cwd, {
    path: lockPath,
    packages: [{ id: "npm:@acme/core", updated: true }],
    npm: [{ id: "npm:@acme/core", distTag: "latest" }],
  });

  return {
    cwd,
    packagePath,
    lockPath,
  };
}

async function createMultiPackagePublishFixture(): Promise<{
  cwd: string;
  corePath: string;
  uiPath: string;
  lockPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-publish-"));
  const corePath = join(cwd, "packages/core");
  const uiPath = join(cwd, "packages/ui");
  const lockPath = join(cwd, ".tegami/publish-lock.yaml");
  tempDirs.push(cwd);

  await mkdir(corePath, { recursive: true });
  await mkdir(uiPath, { recursive: true });
  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeJson(join(corePath, "package.json"), {
    name: "@acme/core",
    version: "1.0.1",
  });
  await writeJson(join(uiPath, "package.json"), {
    name: "@acme/ui",
    version: "1.0.1",
  });
  await writePublishLock(cwd, {
    path: lockPath,
    packages: [
      { id: "npm:@acme/core", updated: true },
      { id: "npm:@acme/ui", updated: true },
    ],
    npm: [
      { id: "npm:@acme/core", distTag: "latest" },
      { id: "npm:@acme/ui", distTag: "latest" },
    ],
  });

  return {
    cwd,
    corePath,
    uiPath,
    lockPath,
  };
}

async function publishFixture(
  context: Awaited<ReturnType<typeof createTegamiContext>>,
  options: { dryRun?: boolean } = {},
) {
  const plan = await initPublishPlan(context, options);
  if (!plan) throw new Error("missing plan");
  await runPreflights(context, plan);
  await runPublishPlan(context, plan);
  return plan;
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

function normalizeChangelog(changelog: {
  id: string;
  filename: string;
  subject?: string;
  packages: Map<string, { type?: string; replay?: string[] }>;
  sections: Array<{ title: string; content: string; depth: number }>;
}) {
  return {
    id: changelog.id,
    filename: changelog.filename,
    ...(changelog.subject ? { subject: changelog.subject } : {}),
    packages: Object.fromEntries(
      [...changelog.packages.entries()].map(([key, config]) => {
        const value: Record<string, unknown> = {};
        if (config.type) value.type = config.type;
        if (config.replay?.length) value.replay = config.replay;
        return [key, value];
      }),
    ),
    sections: changelog.sections,
  };
}

function normalizeDirPath(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
}
