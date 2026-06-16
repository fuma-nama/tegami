import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { x } from "tinyexec";
import { createTegamiContext } from "../src/context";
import { publishPlanStatus } from "../src/plans/draft";
import type { PlanStore } from "../src/plans/store";
import { readPlanStore } from "../src/plans/store";
import { NpmPackage, NpmRegistryClient } from "../src/providers/npm";
import { PackageGraph } from "../src/graph";

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

describe("registry client", () => {
  test("caches package version lookups and reads the registry from the graph", async () => {
    const packageGraph = graph("https://registry.example.test");
    const client = new NpmRegistryClient("/repo", "pnpm", packageGraph);
    const pkg = packageGraph.get("npm:@acme/core");
    if (!(pkg instanceof NpmPackage)) throw new Error("missing package");

    exec.mockResolvedValue(execResult({ stdout: '"1.0.1"\n' }));

    await expect(client.isPackagePublished(pkg)).resolves.toBe(true);
    await expect(client.isPackagePublished(pkg)).resolves.toBe(true);

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
          cwd: "/repo",
        },
      },
    );
  });

  test("returns false for missing package versions", async () => {
    const packageGraph = graph(undefined, "9.9.9");
    const client = new NpmRegistryClient("/repo", "npm", packageGraph);
    const pkg = packageGraph.get("npm:@acme/core");
    if (!(pkg instanceof NpmPackage)) throw new Error("missing package");

    exec.mockResolvedValue(
      execResult({
        exitCode: 1,
        stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
      }),
    );

    await expect(client.isPackagePublished(pkg)).resolves.toBe(false);
  });
});

describe("publish plan status", () => {
  test("readPlanStore returns undefined when no publish plan exists", async () => {
    const context = await createTestContext();

    await expect(readPlanStore(context)).resolves.toBeUndefined();
  });

  test("returns success when publishable packages are on the registry", async () => {
    const context = await createTestContext({ plan: storedPlan() });
    exec.mockResolvedValue(execResult({ stdout: '"1.0.1"\n' }));

    await expect(publishPlanStatus(storedPlan(), context)).resolves.toEqual({ state: "success" });
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
    const context = await createTestContext({ plan: storedPlan() });
    exec.mockResolvedValue(
      execResult({
        exitCode: 1,
        stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
      }),
    );

    await expect(publishPlanStatus(storedPlan(), context)).resolves.toEqual({ state: "pending" });
  });
});

async function createTestContext(options: { plan?: PlanStore } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-registry-"));
  tempDirs.push(cwd);

  if (options.plan) {
    await mkdir(join(cwd, ".tegami"), { recursive: true });
    await writeFile(
      join(cwd, ".tegami/publish-plan"),
      `${JSON.stringify(
        {
          ...options.plan,
          packages: Object.fromEntries(
            Object.entries(options.plan.packages).map(([id, plan]) => [
              id,
              {
                ...plan,
                changelogIds: Array.from(plan.changelogIds ?? []),
              },
            ]),
          ),
        },
        null,
        2,
      )}\n`,
    );
  }

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

function graph(registry?: string, version = "1.0.1"): PackageGraph {
  const pkg = new NpmPackage("/repo/packages/core", {
    name: "@acme/core",
    version,
    ...(registry ? { publishConfig: { registry } } : {}),
  });

  return new PackageGraph([pkg]);
}

function storedPlan(): PlanStore {
  return {
    version: "0.0.0",
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
