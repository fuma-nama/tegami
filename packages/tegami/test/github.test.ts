import { x } from "tinyexec";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PublishResult } from "../src";
import { github } from "../src/plugins/github";
import type { TegamiPlugin } from "../src/types";
import { PackageGraph } from "../src/workspace";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockReset();
});

describe("github release plugin", () => {
  test("creates GitHub releases for successful published packages", async () => {
    const plugin = githubPlugin({
      repo: "acme/repo",
      onCreateRelease(pkg) {
        return {
          prerelease: pkg.distTag !== "latest",
          title: `Release ${pkg.version}`,
          notes: `Notes for ${pkg.name}`,
        };
      },
    });

    await plugin.afterPublish?.call(
      publishContext(),
      publishResult({
        packages: [
          packageResult({
            distTag: "alpha",
            gitTag: "@acme/core@1.0.1",
          }),
          packageResult({
            name: "@acme/no-tag",
            gitTag: undefined,
          }),
        ],
      }),
    );

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls).toMatchInlineSnapshot(`
      [
        [
          "gh",
          [
            "release",
            "create",
            "@acme/core@1.0.1",
            "--title",
            "Release 1.0.1",
            "--notes",
            "Notes for @acme/core",
            "--repo",
            "acme/repo",
            "--prerelease",
          ],
          {
            "throwOnError": true,
          },
        ],
      ]
    `);
  });

  test("does not create releases when any package failed", async () => {
    const plugin = githubPlugin();

    await plugin.afterPublish?.call(
      publishContext(),
      publishResult({
        state: "failed",
        packages: [
          packageResult(),
          packageResult({
            name: "@acme/ui",
            state: "failed",
          }),
        ],
      }),
    );

    expect(exec).not.toHaveBeenCalled();
  });

  test("uses changelog entries for default notes", async () => {
    const plugin = githubPlugin();

    await plugin.afterPublish?.call(
      publishContext(),
      publishResult({
        packages: [
          packageResult({
            changelogs: [
              {
                id: "change-1",
                filename: "change.md",
                packages: new Set(["@acme/core"]),
                type: "minor",
                title: "Add proxy server",
                content: "Some description.",
              },
            ],
          }),
        ],
      }),
    );

    expect(exec.mock.calls).toMatchInlineSnapshot(`
      [
        [
          "gh",
          [
            "release",
            "create",
            "@acme/core@1.0.1",
            "--title",
            "@acme/core@1.0.1",
            "--notes",
            "### Add proxy server

      Some description.",
          ],
          {
            "throwOnError": true,
          },
        ],
      ]
    `);
  });
});

function githubPlugin(options?: Parameters<typeof github>[0]): TegamiPlugin {
  const plugin = github(options).find((plugin) => plugin.name === "github");
  if (!plugin) throw new Error("GitHub plugin not found.");
  return plugin;
}

function publishContext() {
  return {
    cwd: "/repo",
    changelogDir: ".tegami",
    planPath: "/repo/.tegami/publish-plan.json",
    options: {},
    plugins: [],
    publishOptions: {},
    graph: new PackageGraph([]),
    getRegistryClient: registryClient,
  };
}

function registryClient() {
  return {
    id: "test",
    async packageVersionExists() {
      return false;
    },
    async publish() {},
    async publishPlanStatus() {
      return { state: "success" as const };
    },
  };
}

function publishResult(overrides: Partial<PublishResult> = {}): PublishResult {
  return {
    planPath: "/repo/.tegami/publish-plan.json",
    _rawPlan: {
      id: "tegami-test",
      createdAt: "2026-01-01T00:00:00.000Z",
      changelogs: {},
      packages: {},
    },
    state: "success",
    packages: [],
    ...overrides,
  };
}

function packageResult(
  overrides: Partial<PublishResult["packages"][number]> = {},
): PublishResult["packages"][number] {
  const name = overrides.name ?? "@acme/core";
  return {
    id: `test:${name}`,
    name,
    version: "1.0.1",
    distTag: "latest",
    changelogs: [],
    gitTag: "@acme/core@1.0.1",
    state: "success",
    ...overrides,
  };
}
