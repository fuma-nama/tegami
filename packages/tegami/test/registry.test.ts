import { x } from "tinyexec";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PublishPlan } from "../src/schemas";
import { RegistryClient } from "../src/utils/registry";
import { PackageGraph, type WorkspacePackage } from "../src/workspace";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockReset();
});

describe("registry client", () => {
  test("caches package version lookups and reads the registry from the graph", async () => {
    const client = new RegistryClient("/repo", "pnpm", graph("https://registry.example.test"));

    exec.mockResolvedValue(execResult({ stdout: '"1.0.1"\n' }));

    await expect(client.packageVersionExists("@acme/core", "1.0.1")).resolves.toBe(true);
    await expect(client.packageVersionExists("@acme/core", "1.0.1")).resolves.toBe(true);

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
    const client = new RegistryClient("/repo", "npm", graph());

    exec.mockResolvedValue(
      execResult({
        exitCode: 1,
        stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
      }),
    );

    await expect(client.packageVersionExists("@acme/core", "9.9.9")).resolves.toBe(false);
  });

  test("returns successful publish plan status", async () => {
    const client = new RegistryClient("/repo", "npm", graph("https://registry.example.test"));
    exec.mockResolvedValue(execResult({ stdout: '"1.0.1"\n' }));

    const status = await client.publishPlanStatus(storedPlan());

    expect(status).toEqual({
      state: "success",
    });
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
          cwd: "/repo",
        },
      },
    );
  });

  test("returns pending publish plan status", async () => {
    const client = new RegistryClient("/repo", "npm", graph());
    exec.mockResolvedValue(
      execResult({
        exitCode: 1,
        stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
      }),
    );

    await expect(client.publishPlanStatus(storedPlan())).resolves.toEqual({
      state: "pending",
    });
  });
});

function graph(registry?: string): PackageGraph {
  const pkg: WorkspacePackage = {
    name: "@acme/core",
    path: "/repo/packages/core",
    version: "1.0.1",
    private: false,
    manifest: {
      name: "@acme/core",
      version: "1.0.1",
      ...(registry ? { publishConfig: { registry } } : {}),
    },
  };

  return new PackageGraph([pkg]);
}

function storedPlan(): PublishPlan {
  return {
    id: "tegami-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    changelogs: [],
    packages: [
      {
        name: "@acme/core",
        version: "1.0.1",
        changelogIds: new Set(),
        distTag: "latest",
        gitTag: "@acme/core@1.0.1",
        publish: true,
      },
    ],
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
