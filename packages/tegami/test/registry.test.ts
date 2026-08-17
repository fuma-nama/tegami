import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { x } from "tinyexec";
import { createTegamiContext, resolveGraph } from "../src/context";
import { initPublishPlan, runPreflights, publishPlanStatus } from "../src/plans/publish";
import { NpmPackage } from "../src/providers/npm";
import { loadNpmrc, registryAuth, resolveRegistry } from "../src/providers/npm/registry";
import { writePublishLock } from "./helpers/lock";
import { runPluginTasks } from "./helpers/tasks";
import {
  fetchedRequests,
  fetchMock,
  installRegistryFetchMock,
  mockRegistryMissing,
  mockRegistryPublished,
  npmPackumentUrl,
  PACKUMENT_ACCEPT,
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
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("npmrc", () => {
  test("resolves scoped registries, falling back to the default one", async () => {
    const npmrc = await loadNpmrc(
      await createNpmrcDir(`registry=https://internal.example.test
@acme:registry=https://npm.pkg.github.com`),
    );

    expect(resolveRegistry(npmrc, "@acme/core")).toBe("https://npm.pkg.github.com");
    expect(resolveRegistry(npmrc, "@other/core")).toBe("https://internal.example.test");
    expect(resolveRegistry(npmrc, "core")).toBe("https://internal.example.test");
  });

  test("defaults to the public registry", async () => {
    const npmrc = await loadNpmrc(await createNpmrcDir(""));

    expect(resolveRegistry(npmrc, "@acme/core")).toBe("https://registry.npmjs.org");
  });

  test("expands environment variables in tokens", async () => {
    vi.stubEnv("GH_TOKEN", "secret-token");
    const npmrc = await loadNpmrc(
      await createNpmrcDir("//npm.pkg.github.com/:_authToken=${GH_TOKEN}"),
    );

    expect(registryAuth(npmrc, "https://npm.pkg.github.com")).toBe("Bearer secret-token");
  });

  test("drops entries whose environment variable is unset", async () => {
    const npmrc = await loadNpmrc(
      await createNpmrcDir("//npm.pkg.github.com/:_authToken=${MISSING_TOKEN}"),
    );

    expect(registryAuth(npmrc, "https://npm.pkg.github.com")).toBeUndefined();
  });

  test("reads basic credentials and ignores comments", async () => {
    const npmrc = await loadNpmrc(
      await createNpmrcDir(`# a comment=with an equals sign
; another one
registry=https://internal.example.test # trailing comment
//internal.example.test/:_auth="ZW5jb2RlZA=="`),
    );

    expect(resolveRegistry(npmrc, "core")).toBe("https://internal.example.test");
    expect(registryAuth(npmrc, "https://internal.example.test")).toBe("Basic ZW5jb2RlZA==");
  });

  test("reads files written with CRLF line endings", async () => {
    const npmrc = await loadNpmrc(
      await createNpmrcDir(
        "registry=https://internal.example.test\r\n//internal.example.test/:_authToken=abc\r\n",
      ),
    );

    expect(resolveRegistry(npmrc, "core")).toBe("https://internal.example.test");
    expect(registryAuth(npmrc, "https://internal.example.test")).toBe("Bearer abc");
  });

  test("ignores config values that are not strings", async () => {
    const npmrc = await loadNpmrc(
      await createNpmrcDir(`strict-ssl=false
//internal.example.test/:_authToken=abc`),
    );

    expect(registryAuth(npmrc, "https://internal.example.test")).toBe("Bearer abc");
  });

  test("falls back to a shorter path prefix", async () => {
    const npmrc = await loadNpmrc(await createNpmrcDir("//gitlab.example.test/:_authToken=glpat"));

    expect(registryAuth(npmrc, "https://gitlab.example.test/api/v4/projects/7/packages/npm/")).toBe(
      "Bearer glpat",
    );
    expect(registryAuth(npmrc, "https://other.example.test")).toBeUndefined();
  });

  test("prefers the deepest matching path prefix", async () => {
    const npmrc = await loadNpmrc(
      await createNpmrcDir(`//gitlab.example.test/:_authToken=root
//gitlab.example.test/api/v4/projects/7/packages/npm/:_authToken=project`),
    );

    expect(registryAuth(npmrc, "https://gitlab.example.test/api/v4/projects/7/packages/npm/")).toBe(
      "Bearer project",
    );
  });

  test("sends the configured token when reading a package", async () => {
    vi.stubEnv("GH_TOKEN", "secret-token");
    const cwd = await createNpmrcDir(`@acme:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=\${GH_TOKEN}`);
    await mkdir(join(cwd, "packages/core"), { recursive: true });
    await writeNpmWorkspaceRoot(cwd);
    await writeFile(
      join(cwd, "packages/core/package.json"),
      `${JSON.stringify({ name: "@acme/core", version: "1.0.1" }, null, 2)}\n`,
    );

    const context = await createResolvedContext({ cwd, npm: { client: "pnpm" } });
    mockRegistryPublished();

    await expect(publishPlanStatus(await loadPlan(context), context)).resolves.toEqual({
      status: "success",
    });
    expect(fetchedRequests()).toContainEqual({
      url: npmPackumentUrl("https://npm.pkg.github.com", "@acme/core"),
      headers: { accept: PACKUMENT_ACCEPT, authorization: "Bearer secret-token" },
    });
  });
});

describe("npm registry preflight", () => {
  test("reads the registry from the graph during resolvePlanStatus", async () => {
    const context = await createContext("pnpm", "https://registry.example.test");

    mockRegistryPublished();

    const plan = await loadPlan(context);

    await expect(publishPlanStatus(plan, context)).resolves.toEqual({ status: "success" });
    expect(fetchedRequests()).toContainEqual({
      url: npmPackumentUrl("https://registry.example.test", "@acme/core"),
      headers: { accept: PACKUMENT_ACCEPT },
    });
  });

  test("returns shouldPublish true for missing package versions", async () => {
    const context = await createContext("pnpm", undefined, "9.9.9");
    const pkg = context.graph.get("npm:@acme/core");
    if (!(pkg instanceof NpmPackage)) throw new Error("missing package");
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    await expect(
      npmPlugin.publishPreflight?.call(context, { pkg, plan: await loadPlan(context) }),
    ).resolves.toEqual({ shouldPublish: true });
  });

  test("publishes with yarn publish", async () => {
    const context = await createContext("yarn");
    const pkg = context.graph.get("npm:@acme/core");
    if (!(pkg instanceof NpmPackage)) throw new Error("missing package");
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    exec.mockResolvedValue(execResult());
    const plan = await loadPlan(context, "next");

    await runPluginTasks(npmPlugin, context, plan);

    expect(exec).toHaveBeenCalledWith("yarn", ["publish", "--tag", "next"], {
      nodeOptions: {
        cwd: pkg.path,
      },
    });
  });

  test.each(["aube", "nub"] as const)("publishes with %s publish", async (client) => {
    const context = await createContext(client);
    const pkg = context.graph.get("npm:@acme/core");
    if (!(pkg instanceof NpmPackage)) throw new Error("missing package");
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    exec.mockResolvedValue(execResult());
    const plan = await loadPlan(context, "next");

    await runPluginTasks(npmPlugin, context, plan);

    expect(exec).toHaveBeenCalledWith(client, ["publish", "--tag", "next"], {
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

    await runPluginTasks(npmPlugin, context, plan);

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

  test("runs publish lifecycle scripts before packing with bun", async () => {
    const context = await createContext("bun");
    const pkg = context.graph.get("npm:@acme/core");
    if (!(pkg instanceof NpmPackage)) throw new Error("missing package");
    pkg.manifest.scripts = {
      prepublishOnly: "node prepublish.js",
      prepare: "node prepare.js",
    };
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;
    const tarballPath = join(pkg.path, "pkg.tgz");

    exec.mockResolvedValue(execResult());
    const plan = await loadPlan(context);

    await runPluginTasks(npmPlugin, context, plan);

    expect(exec).toHaveBeenNthCalledWith(1, "bun", ["run", "prepublishOnly"], {
      nodeOptions: { cwd: pkg.path },
    });
    expect(exec).toHaveBeenNthCalledWith(2, "bun", ["run", "prepare"], {
      nodeOptions: { cwd: pkg.path },
    });
    expect(exec).toHaveBeenNthCalledWith(3, "bun", ["pm", "pack", "--filename", tarballPath], {
      nodeOptions: { cwd: pkg.path },
    });
    expect(exec).toHaveBeenNthCalledWith(4, "npm", ["publish", tarballPath, "--tag", "latest"], {
      nodeOptions: { cwd: pkg.path },
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
    mockRegistryPublished();
    const plan = await loadPlan(context);

    await expect(publishPlanStatus(plan, context)).resolves.toEqual({ status: "success" });
    expect(fetchedRequests()).toContainEqual({
      url: npmPackumentUrl("https://registry.example.test", "@acme/core"),
      headers: { accept: PACKUMENT_ACCEPT },
    });
  });

  test("returns pending when a publishable package is missing from the registry", async () => {
    const context = await createTestContext();
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));
    const plan = await loadPlan(context);

    await expect(publishPlanStatus(plan, context)).resolves.toEqual({
      status: "pending",
      reason: 'Task "publish:npm:@acme/core" is pending',
    });
  });
});

async function createTestContext() {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-registry-"));
  tempDirs.push(cwd);

  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await writeNpmWorkspaceRoot(cwd);
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

  return createResolvedContext({
    cwd,
    npm: { client: "pnpm" },
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
  client: "pnpm" | "npm" | "yarn" | "bun" | "aube" | "nub",
  registry?: string,
  version = "1.0.1",
) {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-registry-client-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await writeNpmWorkspaceRoot(cwd);
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
  const context = await createResolvedContext({
    cwd,
    npm: { client },
  });
  await writePublishLock(context.cwd, {
    packages: [{ id: "npm:@acme/core", updated: true }],
    npm: [{ id: "npm:@acme/core", distTag: "latest" }],
  });
  return context;
}

async function createResolvedContext(options: Parameters<typeof createTegamiContext>[0]) {
  const context = await createTegamiContext(options);
  await resolveGraph(context);
  return context;
}

async function createNpmrcDir(content: string) {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-npmrc-"));
  tempDirs.push(cwd);
  await writeFile(join(cwd, ".npmrc"), content);
  return cwd;
}

async function writeNpmWorkspaceRoot(cwd: string) {
  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify({ name: "@acme/root", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
  );
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
