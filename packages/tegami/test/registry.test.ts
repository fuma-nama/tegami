import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { x } from "tinyexec";
import { createTegamiContext } from "../src/context";
import { publishPlanStatus } from "../src/plans/checks";
import { initPublishPlan, runPreflights } from "../src/plans/publish";
import { NpmPackage } from "../src/providers/npm";
import { writePublishLock } from "./helpers/lock";
import {
  fetchMock,
  installRegistryFetchMock,
  mockRegistryMissing,
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
});

afterEach(async () => {
  uninstallRegistryFetchMock();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("npm registry preflight", () => {
  test("reads the registry from the graph during preflight", async () => {
    const context = await createContext("pnpm", "https://registry.example.test");

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ version: "1.0.1" }), { status: 200 }),
    );

    await loadPlan(context);

    expect(fetchMock).toHaveBeenCalledWith(
      npmPackageVersionUrl("https://registry.example.test", "@acme/core", "1.0.1"),
      { headers: { Accept: "application/json" } },
    );
  });

  test("returns publish true for missing package versions", async () => {
    const context = await createContext("npm", undefined, "9.9.9");
    const pkg = context.graph.get("npm:@acme/core");
    if (!(pkg instanceof NpmPackage)) throw new Error("missing package");
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));

    await expect(
      npmPlugin.publishPreflight?.call(context, { pkg, plan: await loadPlan(context) }),
    ).resolves.toEqual({ publish: true });
  });

  test("publishes with yarn publish", async () => {
    const context = await createContext("yarn");
    const pkg = context.graph.get("npm:@acme/core");
    if (!(pkg instanceof NpmPackage)) throw new Error("missing package");
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    exec.mockResolvedValue(execResult());
    const plan = await loadPlan(context, "next");

    await npmPlugin.publish?.call(context, { pkg, plan });

    expect(exec).toHaveBeenCalledWith("yarn", ["publish", "--tag", "next"], {
      nodeOptions: {
        cwd: pkg.path,
      },
    });
  });

  test("packs with bun then publishes tarball with npm", async () => {
    const context = await createContext("bun");
    const pkg = context.graph.get("npm:@acme/core");
    if (!(pkg instanceof NpmPackage)) throw new Error("missing package");
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;
    const tarballPath = join(pkg.path, "pkg.tgz");

    exec.mockResolvedValueOnce(execResult()).mockResolvedValueOnce(execResult());
    const plan = await loadPlan(context);

    await npmPlugin.publish?.call(context, { pkg, plan });

    expect(exec).toHaveBeenNthCalledWith(1, "bun", ["pm", "pack", "--filename", tarballPath], {
      nodeOptions: {
        cwd: pkg.path,
      },
    });
    expect(exec).toHaveBeenNthCalledWith(2, "npm", ["publish", tarballPath, "--tag", "latest"], {
      nodeOptions: {
        cwd: pkg.path,
      },
    });
  });
});

describe("publish plan status", () => {
  test("initPublishPlan returns undefined when no publish lock exists", async () => {
    const context = await createTestContext();

    await expect(initPublishPlan(context, {})).resolves.toBeUndefined();
  });

  test("returns success when publishable packages are on the registry", async () => {
    const context = await createTestContext();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ version: "1.0.1" }), { status: 200 }),
    );
    const plan = await loadPlan(context);

    await expect(publishPlanStatus(plan, context)).resolves.toBe("success");
    expect(fetchMock).toHaveBeenCalledWith(
      npmPackageVersionUrl("https://registry.example.test", "@acme/core", "1.0.1"),
      { headers: { Accept: "application/json" } },
    );
  });

  test("returns pending when a publishable package is missing from the registry", async () => {
    const context = await createTestContext();
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));
    const plan = await loadPlan(context);

    await expect(publishPlanStatus(plan, context)).resolves.toBe("pending");
  });
});

async function createTestContext() {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-registry-"));
  tempDirs.push(cwd);

  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeFile(
    join(cwd, "packages/core/package.json"),
    `${JSON.stringify(
      {
        name: "@acme/core",
        version: "1.0.1",
        publishConfig: { registry: "https://registry.example.test" },
      },
      null,
      2,
    )}\n`,
  );

  return createTegamiContext({
    cwd,
    npm: { client: "npm" },
  });
}

async function loadPlan(
  context: Awaited<ReturnType<typeof createTestContext>>,
  distTag = "latest",
) {
  await writePublishLock(context.cwd, {
    packages: [{ id: "npm:@acme/core", updated: true }],
    npm: [{ id: "npm:@acme/core", distTag }],
  });
  const plan = await initPublishPlan(context, {});
  if (!plan) throw new Error("missing plan");
  await runPreflights(context, plan);
  return plan;
}

async function createContext(
  client: "pnpm" | "npm" | "yarn" | "bun",
  registry?: string,
  version = "1.0.1",
) {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-registry-client-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeFile(
    join(cwd, "packages/core/package.json"),
    `${JSON.stringify(
      {
        name: "@acme/core",
        version,
        ...(registry ? { publishConfig: { registry } } : {}),
      },
      null,
      2,
    )}\n`,
  );
  const context = await createTegamiContext({
    cwd,
    npm: { client },
  });
  await writePublishLock(context.cwd, {
    packages: [{ id: "npm:@acme/core", updated: true }],
    npm: [{ id: "npm:@acme/core", distTag: "latest" }],
  });
  return context;
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
