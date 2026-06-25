import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { x } from "tinyexec";
import { createTegamiContext } from "../src/context";
import { publishPlanStatus } from "../src/plans/checks";
import { initPublishPlan, runPreflights } from "../src/plans/publish";
import { NpmPackage } from "../src/providers/npm";
import { writePublishLock } from "./helpers/lock";

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

describe("npm registry preflight", () => {
  test("reads the registry from the graph during preflight", async () => {
    const context = await createContext("pnpm", "https://registry.example.test");

    exec.mockResolvedValue(execResult({ stdout: '"1.0.1"\n' }));

    await loadPlan(context);

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
          cwd: context.cwd,
        },
      },
    );
  });

  test("returns publish true for missing package versions", async () => {
    const context = await createContext("npm", undefined, "9.9.9");
    const pkg = context.graph.get("npm:@acme/core");
    if (!(pkg instanceof NpmPackage)) throw new Error("missing package");
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    exec.mockResolvedValue(
      execResult({
        exitCode: 1,
        stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
      }),
    );

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

    exec
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult());
    const plan = await loadPlan(context);

    await npmPlugin.publish?.call(context, { pkg, plan });

    expect(exec).toHaveBeenNthCalledWith(2, "bun", ["pm", "pack", "--filename", tarballPath], {
      nodeOptions: {
        cwd: pkg.path,
      },
    });
    expect(exec).toHaveBeenNthCalledWith(3, "npm", ["publish", tarballPath, "--tag", "latest"], {
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
    exec.mockResolvedValue(execResult({ stdout: '"1.0.1"\n' }));
    const plan = await loadPlan(context);

    await expect(publishPlanStatus(plan, context)).resolves.toBe("success");
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
          cwd: context.cwd,
        },
      },
    );
  });

  test("returns pending when a publishable package is missing from the registry", async () => {
    const context = await createTestContext();
    exec.mockResolvedValue(
      execResult({
        exitCode: 1,
        stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
      }),
    );
    const plan = await loadPlan(context);

    await expect(publishPlanStatus(plan, context)).resolves.toBe("pending");
  });
});

async function createTestContext() {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-registry-"));
  tempDirs.push(cwd);

  const context = await createTegamiContext({
    cwd,
    npm: { client: "npm" },
  });
  context.graph.add(
    new NpmPackage(join(cwd, "packages/core"), {
      name: "@acme/core",
      version: "1.0.1",
      publishConfig: { registry: "https://registry.example.test" },
    }),
  );

  return context;
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
  const context = await createTegamiContext({
    cwd,
    npm: { client },
  });
  context.graph.add(
    new NpmPackage(join(cwd, "packages/core"), {
      name: "@acme/core",
      version,
      ...(registry ? { publishConfig: { registry } } : {}),
    }),
  );
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
