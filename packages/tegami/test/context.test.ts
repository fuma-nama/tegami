import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "package-manager-detector";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTegamiContext, resolveGraph } from "../src/context";
import type { TegamiPlugin } from "../src/types";

vi.mock("package-manager-detector", () => ({
  detect: vi.fn(),
}));
vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const detectPackageManager = vi.mocked(detect);
const exec = vi.mocked(x);
const tempDirs: string[] = [];

beforeEach(() => {
  detectPackageManager.mockReset();
  exec.mockReset();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("tegami context", () => {
  test("uses an explicit npm client without detecting", async () => {
    const cwd = await npmWorkspace();
    const context = await createResolvedContext({
      cwd,
      npm: { client: "npm" },
    });
    const pkg = context.graph.get("npm:@acme/core")!;
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    await expect(
      npmPlugin.publishPreflight?.call(context, {
        pkg,
        plan: emptyPlan(),
      }),
    ).resolves.toEqual({ shouldPublish: true });

    expect(detectPackageManager).not.toHaveBeenCalled();
    expect(context.npm).toEqual({ client: "npm" });
  });

  test("detects pnpm when creating a project context", async () => {
    detectPackageManager.mockResolvedValue({
      name: "pnpm",
      agent: "pnpm",
    });

    const cwd = await npmWorkspace();
    const context = await createResolvedContext({
      cwd,
    });
    const pkg = context.graph.get("npm:@acme/core")!;
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    await expect(
      npmPlugin.publishPreflight?.call(context, {
        pkg,
        plan: emptyPlan(),
      }),
    ).resolves.toEqual({ shouldPublish: true });

    expect(detectPackageManager).toHaveBeenCalledTimes(1);
    expect(detectPackageManager).toHaveBeenCalledWith({
      cwd,
    });
    expect(context.npm).toEqual({ client: "pnpm" });
  });

  test("defaults npm client when package manager detection fails", async () => {
    const cwd = await npmWorkspace();
    const context = await createResolvedContext({
      cwd,
    });
    const pkg = context.graph.get("npm:@acme/core")!;
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    await expect(
      npmPlugin.publishPreflight?.call(context, {
        pkg,
        plan: emptyPlan(),
      }),
    ).resolves.toEqual({ shouldPublish: true });

    expect(context.npm).toEqual({ client: "npm" });
  });

  test("defaults the publish lock path", async () => {
    const context = await createTegamiContext({
      cwd: "/repo",
    });

    expect(context.changelogDir).toBe("/repo/.tegami");
    expect(context.lockPath).toBe("/repo/.tegami/publish-lock.yaml");
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
        "pre-a",
        "pre-b",
        "default-a",
        "default-b",
        "post-a",
        "post-b",
      ]
    `);
  });

  test("includes npm packages without a version field in the graph", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-context-no-version-"));
    tempDirs.push(cwd);
    await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
    await mkdir(join(cwd, "packages/lib"), { recursive: true });
    await writeFile(
      join(cwd, "packages/lib/package.json"),
      `${JSON.stringify({ name: "@acme/lib" }, null, 2)}\n`,
    );

    const context = await createResolvedContext({ cwd });
    const pkg = context.graph.get("npm:@acme/lib");

    expect(pkg).toBeDefined();
    expect(pkg!.version).toBeUndefined();
  });
});

async function npmWorkspace() {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-context-npm-"));
  tempDirs.push(cwd);
  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify({ name: "@acme/core", version: "1.0.0" }, null, 2)}\n`,
  );
  return cwd;
}

function emptyPlan() {
  return {
    options: {},
    changelogs: new Map(),
    packages: new Map(),
  };
}

async function createResolvedContext(options: Parameters<typeof createTegamiContext>[0]) {
  const context = await createTegamiContext(options);
  await resolveGraph(context);
  return context;
}

function plugin(name: string, enforce?: TegamiPlugin["enforce"]): TegamiPlugin {
  return {
    name,
    enforce,
  };
}
