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
    expect(context.npm?.client).toBe("npm");
    expect(context.npm?.graph?.packages.has("@acme/core")).toBe(true);
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
    expect(context.npm?.client).toBe("pnpm");
    expect(context.npm?.graph?.packages.has("@acme/core")).toBe(true);
  });

  test.each(["aube", "nub"] as const)(
    "detects %s when creating a project context",
    async (name) => {
      detectPackageManager.mockResolvedValue({
        name,
        agent: name,
      });

      const cwd = await npmWorkspace();
      const context = await createResolvedContext({
        cwd,
      });

      expect(context.npm?.client).toBe(name);
      expect(context.npm?.agent).toBe(name);
      expect(context.npm?.graph?.packages.has("@acme/core")).toBe(true);
    },
  );

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

    expect(context.npm?.client).toBe("npm");
    expect(context.npm?.graph?.packages.has("@acme/core")).toBe(true);
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
        "pre-a",
        "pre-b",
        "npm",
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

    const context = await createResolvedContext({ cwd, npm: { client: "pnpm" } });
    const pkg = context.graph.get("npm:@acme/lib");

    expect(pkg).toBeDefined();
    expect(pkg!.version).toBeUndefined();
  });

  test.each(["pnpm", "aube", "nub"] as const)(
    "%s discovers pnpm-workspace.yaml packages and catalogs",
    async (client) => {
      const cwd = await workspaceRoot();
      await writeWorkspaceYaml(cwd, "pnpm-workspace.yaml", {
        packageGlob: "packages/pnpm-*",
        catalog: "react: ^19.0.0",
      });
      await writePackage(cwd, "packages/pnpm-lib", {
        name: "@acme/pnpm-lib",
        version: "1.0.0",
        dependencies: { react: "catalog:" },
      });

      const context = await createResolvedContext({ cwd, npm: { client } });

      expect(context.npm?.graph?.packages.has("@acme/pnpm-lib")).toBe(true);
      expect(
        context.npm?.graph?.catalogs.find((catalog) => catalog.resolve("react", "default")),
      ).toBeDefined();
    },
  );

  test("aube discovers aube-workspace.yaml packages and tolerates aube-specific settings", async () => {
    const cwd = await workspaceRoot();
    await writeWorkspaceYaml(cwd, "aube-workspace.yaml", {
      packageGlob: "packages/aube-*",
      catalog: "react: ^19.0.0",
      extra: "overrides:\n  left-pad: 1.3.0",
    });
    await writePackage(cwd, "packages/aube-lib", {
      name: "@acme/aube-lib",
      version: "1.0.0",
      dependencies: { react: "catalog:" },
    });

    const context = await createResolvedContext({ cwd, npm: { client: "aube" } });

    expect(context.npm?.graph?.packages.has("@acme/aube-lib")).toBe(true);
    expect(
      context.npm?.graph?.catalogs.find((catalog) => catalog.resolve("react", "default")),
    ).toBeDefined();
  });

  test.each(["pnpm", "nub", "npm", "yarn", "bun"] as const)(
    "%s does not discover aube-workspace.yaml packages",
    async (client) => {
      const cwd = await workspaceRoot();
      await writeWorkspaceYaml(cwd, "aube-workspace.yaml", {
        packageGlob: "packages/aube-*",
      });
      await writePackage(cwd, "packages/aube-lib", {
        name: "@acme/aube-lib",
        version: "1.0.0",
      });

      const context = await createResolvedContext({ cwd, npm: { client } });

      expect(context.npm?.graph?.packages.has("@acme/aube-lib")).toBe(false);
    },
  );

  test.each(["npm", "yarn", "bun"] as const)(
    "%s does not discover pnpm-workspace.yaml packages",
    async (client) => {
      const cwd = await workspaceRoot();
      await writeWorkspaceYaml(cwd, "pnpm-workspace.yaml", {
        packageGlob: "packages/pnpm-*",
      });
      await writePackage(cwd, "packages/pnpm-lib", {
        name: "@acme/pnpm-lib",
        version: "1.0.0",
      });

      const context = await createResolvedContext({ cwd, npm: { client } });

      expect(context.npm?.graph?.packages.has("@acme/pnpm-lib")).toBe(false);
    },
  );

  test.each(["npm", "pnpm", "yarn", "bun", "aube", "nub"] as const)(
    "%s discovers package.json workspaces",
    async (client) => {
      const cwd = await workspaceRoot({
        workspaces: ["packages/*"],
      });
      await writePackage(cwd, "packages/lib", {
        name: "@acme/lib",
        version: "1.0.0",
      });

      const context = await createResolvedContext({ cwd, npm: { client } });

      expect(context.npm?.graph?.packages.has("@acme/lib")).toBe(true);
    },
  );

  test("yarn reads catalogs from .yarnrc.yml instead of package-manager workspace yaml", async () => {
    const cwd = await workspaceRoot({
      workspaces: ["packages/*"],
    });
    await writeFile(join(cwd, ".yarnrc.yml"), `catalog:\n  react: ^19.0.0\n`);
    await writePackage(cwd, "packages/lib", {
      name: "@acme/lib",
      version: "1.0.0",
      dependencies: { react: "catalog:" },
    });

    const context = await createResolvedContext({ cwd, npm: { client: "yarn" } });

    expect(
      context.npm?.graph?.catalogs.find((catalog) => catalog.resolve("react", "default")),
    ).toBeDefined();
  });

  test.each(["aube", "nub"] as const)(
    "%s updates lockfiles with pnpm-compatible lockfile-only flags",
    async (client) => {
      const cwd = await npmWorkspace();
      const context = await createResolvedContext({ cwd, npm: { client } });
      const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;
      exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

      await npmPlugin.applyCliDraft?.call(context, {} as never);

      expect(exec).toHaveBeenCalledWith(
        client,
        ["install", "--lockfile-only", "--no-frozen-lockfile"],
        { nodeOptions: { cwd } },
      );
    },
  );
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

async function workspaceRoot(manifest: Record<string, unknown> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-context-workspace-"));
  tempDirs.push(cwd);
  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify({ name: "@acme/root", private: true, ...manifest }, null, 2)}\n`,
  );
  return cwd;
}

async function writeWorkspaceYaml(
  cwd: string,
  fileName: string,
  {
    packageGlob,
    catalog,
    extra,
  }: {
    packageGlob: string;
    catalog?: string;
    extra?: string;
  },
) {
  const blocks = [`packages:\n  - "${packageGlob}"`];
  if (catalog) blocks.push(`catalog:\n  ${catalog}`);
  if (extra) blocks.push(extra);
  await writeFile(join(cwd, fileName), `${blocks.join("\n")}\n`);
}

async function writePackage(cwd: string, packagePath: string, manifest: Record<string, unknown>) {
  await mkdir(join(cwd, packagePath), { recursive: true });
  await writeFile(join(cwd, packagePath, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
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
