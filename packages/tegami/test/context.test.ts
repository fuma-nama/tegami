import { detect } from "package-manager-detector";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTegamiContext } from "../src/context";
import { NpmPackage } from "../src/providers/npm";
import {
  fetchMock,
  installRegistryFetchMock,
  mockRegistryPublished,
  npmPackageVersionUrl,
  uninstallRegistryFetchMock,
} from "./helpers/registry-fetch";
import type { TegamiPlugin } from "../src/types";

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
  installRegistryFetchMock();
  mockRegistryPublished(JSON.stringify({ version: "1.0.0" }));
});

afterEach(() => {
  uninstallRegistryFetchMock();
});

describe("tegami context", () => {
  test("uses an explicit npm client without detecting", async () => {
    const context = await createTegamiContext({
      cwd: "/repo",
      npm: { client: "npm" },
    });
    const pkg = npmPackage();
    context.graph.add(pkg);
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    await npmPlugin.publishPreflight?.call(context, {
      pkg,
      plan: emptyPlan(),
    });

    expect(fetchMock).toHaveBeenCalledWith(npmPackageVersionUrl(undefined, "@acme/core", "1.0.0"), {
      headers: { Accept: "application/json" },
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
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    await npmPlugin.publishPreflight?.call(context, {
      pkg,
      plan: emptyPlan(),
    });

    expect(fetchMock).toHaveBeenCalledWith(npmPackageVersionUrl(undefined, "@acme/core", "1.0.0"), {
      headers: { Accept: "application/json" },
    });
    expect(detectPackageManager).toHaveBeenCalledTimes(1);
    expect(detectPackageManager).toHaveBeenCalledWith({
      cwd: "/repo",
    });
  });

  test("defaults npm client when package manager detection fails", async () => {
    const context = await createTegamiContext({
      cwd: "/repo",
    });
    const pkg = npmPackage();
    context.graph.add(pkg);
    const npmPlugin = context.plugins.find((plugin) => plugin.name === "npm")!;

    await npmPlugin.publishPreflight?.call(context, {
      pkg,
      plan: emptyPlan(),
    });

    expect(fetchMock).toHaveBeenCalledWith(npmPackageVersionUrl(undefined, "@acme/core", "1.0.0"), {
      headers: { Accept: "application/json" },
    });
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

function emptyPlan() {
  return {
    options: {},
    changelogs: new Map(),
    packages: new Map(),
  };
}

function plugin(name: string, enforce?: TegamiPlugin["enforce"]): TegamiPlugin {
  return {
    name,
    enforce,
  };
}

function npmPackage(): NpmPackage {
  return new NpmPackage("/repo/packages/core", {
    name: "@acme/core",
    version: "1.0.0",
  });
}
