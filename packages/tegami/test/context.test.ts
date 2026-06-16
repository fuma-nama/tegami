import { detect } from "package-manager-detector";
import { x } from "tinyexec";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createTegamiContext } from "../src/context";
import { NpmPackage } from "../src/providers/npm";
import type { TegamiPlugin } from "../src/types";
import { WorkspacePackage } from "../src/graph";

vi.mock("package-manager-detector", () => ({
  detect: vi.fn(),
}));
vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const detectPackageManager = vi.mocked(detect);
const exec = vi.mocked(x);

beforeEach(() => {
  detectPackageManager.mockReset();
  exec.mockReset();
  exec.mockResolvedValue({
    exitCode: 0,
    stdout: '"1.0.0"\n',
    stderr: "",
  } as Awaited<ReturnType<typeof x>>);
});

describe("tegami context", () => {
  test("uses an explicit npm client without detecting", async () => {
    const context = await createTegamiContext({
      cwd: "/repo",
      npm: { client: "npm" },
    });
    const pkg = npmPackage();
    context.graph.add(pkg);

    await context.getRegistryClient("npm").isPackagePublished(pkg);

    expect(exec).toHaveBeenCalledWith("npm", ["view", "@acme/core@1.0.0", "version", "--json"], {
      nodeOptions: {
        cwd: "/repo",
      },
    });
    expect(detectPackageManager).not.toHaveBeenCalled();
  });

  test("detects pnpm when creating a project context", async () => {
    detectPackageManager.mockResolvedValue({
      name: "pnpm",
      agent: "pnpm",
    });

    const context = await createTegamiContext({
      cwd: "/repo",
    });
    const pkg = npmPackage();
    context.graph.add(pkg);

    await context.getRegistryClient("npm").isPackagePublished(pkg);

    expect(exec).toHaveBeenCalledWith("pnpm", ["view", "@acme/core@1.0.0", "version", "--json"], {
      nodeOptions: {
        cwd: "/repo",
      },
    });
    expect(detectPackageManager).toHaveBeenCalledTimes(1);
    expect(detectPackageManager).toHaveBeenCalledWith({
      cwd: "/repo",
    });
  });

  test("throws for unsupported package managers", async () => {
    const context = await createTegamiContext({
      cwd: "/repo",
    });

    expect(() => context.getRegistryClient("yarn")).toThrow(
      "No registry client is available for yarn.",
    );
    expect(() => context.getRegistryClient(workspacePackage("yarn"))).toThrow(
      "No registry client is available for yarn.",
    );
    expect(() => context.getRegistryClient(workspacePackage("npm"))).toThrow(
      "No registry client is available for npm.",
    );
    expect(exec).not.toHaveBeenCalled();
  });

  test("defaults the publish plan path", async () => {
    const context = await createTegamiContext({
      cwd: "/repo",
    });

    expect(context.planPath).toBe("/repo/.tegami/publish-plan");
  });

  test("stores plugins in enforce order", async () => {
    const plugins = [
      plugin("default-a"),
      plugin("post-a", "post"),
      plugin("pre-a", "pre"),
      plugin("default-b", "default"),
      plugin("pre-b", "pre"),
      plugin("post-b", "post"),
    ];

    const context = await createTegamiContext({
      cwd: "/repo",
      plugins,
    });

    expect(context.plugins.map((plugin) => plugin.name)).toMatchInlineSnapshot(`
      [
        "npm",
        "cargo",
        "pre-a",
        "pre-b",
        "default-a",
        "default-b",
        "post-a",
        "post-b",
      ]
    `);
  });
});

function plugin(name: string, enforce?: TegamiPlugin["enforce"]): TegamiPlugin {
  return {
    name,
    enforce,
  };
}

function workspacePackage(manager: string): WorkspacePackage {
  return new TestPackage(manager);
}

class TestPackage extends WorkspacePackage {
  readonly name = "pkg";
  readonly path = "/repo/pkg";
  readonly publish = true;
  readonly version = "1.0.0";

  constructor(readonly manager: string) {
    super();
  }

  setVersion(): void {}

  async updateDependency(): Promise<void> {}

  async write(): Promise<void> {}
}

function npmPackage(): NpmPackage {
  return new NpmPackage("/repo/packages/core", {
    name: "@acme/core",
    version: "1.0.0",
  });
}
