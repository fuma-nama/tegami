import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { parse } from "yaml";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { getPendingPackageIds, normalizePackagePlan } from "./helpers/draft";
import { writePublishLock } from "./helpers/lock";
import {
  installRegistryFetchMock,
  mockRegistryMissing,
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

describe("draft publish plans", () => {
  test("builds draft and writes an executable publish plan", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const paper = tegami({
      cwd,
      packages: {
        "@acme/core": {
          npm: { distTag: "alpha" },
        },
      },
    });

    const context = await paper._internal.context();
    const draft = await paper.draft();
    const packages = getPendingPackageIds(draft, context.graph).sort();
    const changelogId = draft.getChangelogs()[0]?.id;

    expect(changelogId).toEqual(expect.any(String));
    expect({
      packages,
      core: normalizePackagePlan(draft.getPackageDraft("npm:@acme/core")),
      ui: normalizePackagePlan(draft.getPackageDraft("npm:@acme/ui")),
    }).toMatchInlineSnapshot(`
      {
        "core": {
          "bumpVersion": [Function],
          "changelogIds": [
            "change.md",
          ],
          "npm": {
            "distTag": "alpha",
          },
          "type": "minor",
        },
        "packages": [
          "npm:@acme/core",
          "npm:@acme/ui",
        ],
        "ui": {
          "bumpReasons": Set {
            "update dependency "@acme/core-alias"",
            "update dependency "@acme/core"",
          },
          "bumpVersion": [Function],
          "changelogIds": [
            "change.md",
          ],
          "npm": {
            "distTag": undefined,
          },
          "type": "major",
        },
      }
    `);

    await draft.apply();
    expect(await readFile(join(cwd, "packages/core/package.json"), "utf-8")).toMatchInlineSnapshot(`
      "{
        "name": "@acme/core",
        "version": "1.1.0"
      }
      "
    `);
    expect(await readFile(join(cwd, "packages/ui/package.json"), "utf-8")).toMatchInlineSnapshot(`
      "{
        "name": "@acme/ui",
        "version": "2.0.0",
        "dependencies": {
          "@acme/core": "^1.0.0",
          "@acme/core-alias": "npm:@acme/core@~1.1.0"
        },
        "devDependencies": {
          "@acme/core": "workspace:^1.0.0"
        },
        "peerDependencies": {
          "@acme/core": "workspace:*"
        },
        "optionalDependencies": {
          "@acme/core": "~1.1.0"
        }
      }
      "
    `);

    expect(await readFile(join(cwd, "packages/core/CHANGELOG.md"), "utf8")).toContain(
      "## @acme/core@1.1.0 (alpha)",
    );
    await expect(readFile(join(cwd, ".tegami/change.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const rawPlan = parse(await readFile(join(cwd, ".tegami/publish-lock.yaml"), "utf8")) as Record<
      string,
      unknown[]
    >;

    expect(rawPlan["core:changelogs"]).toEqual([
      expect.objectContaining({
        filename: "change.md",
        v: "0.0.0",
      }),
    ]);
    expect(rawPlan["core:packages"]).toEqual(
      expect.arrayContaining([
        {
          changelogIds: ["change.md"],
          id: "npm:@acme/core",
          updated: true,
        },
        {
          changelogIds: ["change.md"],
          id: "npm:@acme/ui",
          updated: true,
        },
      ]),
    );
    expect(rawPlan["npm:packages"]).toEqual(
      expect.arrayContaining([{ distTag: "alpha", id: "npm:@acme/core" }]),
    );
  });

  test("omits packages without pending version changes from the draft", async () => {
    const cwd = await createWorkspace({
      changelog: false,
    });
    tempDirs.push(cwd);

    const paper = tegami({ cwd });
    const draft = await paper.draft();

    expect(draft.hasPending()).toBe(false);
    expect(getPendingPackageIds(draft, (await paper._internal.context()).graph)).toEqual([]);
  });

  test("does not treat matching prerelease config as a pending version bump", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-draft-prerelease-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, "packages/tegami"), { recursive: true });
    await mkdir(join(cwd, ".tegami"), { recursive: true });
    await writeFile(
      join(cwd, "pnpm-workspace.yaml"),
      `packages:
  - "packages/*"
`,
    );
    await writeJson(join(cwd, "packages/tegami/package.json"), {
      name: "tegami",
      version: "1.1.0-alpha.2",
    });

    const paper = tegami({
      cwd,
      packages: {
        tegami: { prerelease: "alpha" },
      },
    });
    const context = await paper._internal.context();
    const draft = await paper.draft();
    const pkg = context.graph.get("npm:tegami")!;

    expect(draft.getPackageDraft("npm:tegami")?.type).toBeUndefined();
    expect(draft.getPackageDraft("npm:tegami")?.prerelease).toBe("alpha");
    expect(draft.hasPending()).toBe(false);
    expect(getPendingPackageIds(draft, context.graph)).toEqual([]);
    expect(draft.getPackageDraft("npm:tegami")?.bumpVersion(pkg)).toBe("1.1.0-alpha.2");
  });

  test("treats file: dependencies outside the workspace as external", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-draft-file-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, "packages/core"), { recursive: true });
    await mkdir(join(cwd, "packages/ui"), { recursive: true });
    await mkdir(join(cwd, "vendor/core"), { recursive: true });
    await mkdir(join(cwd, ".tegami"), { recursive: true });
    await writeFile(
      join(cwd, "pnpm-workspace.yaml"),
      `packages:
  - "packages/*"
`,
    );
    await writeJson(join(cwd, "packages/core/package.json"), {
      name: "@acme/core",
      version: "1.0.0",
    });
    await writeJson(join(cwd, "vendor/core/package.json"), {
      name: "@acme/core",
      version: "9.9.9",
    });
    await writeJson(join(cwd, "packages/ui/package.json"), {
      name: "@acme/ui",
      version: "1.0.0",
      dependencies: {
        "@acme/core": "file:../../vendor/core",
      },
    });
    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages: ["@acme/core"]
---

## Core release

Core only.
`,
    );

    const draft = await tegami({ cwd }).draft();

    expect(draft.getPackageDraft("npm:@acme/core")?.type).toBe("minor");
    expect(draft.getPackageDraft("npm:@acme/ui")?.type).toBeUndefined();

    await draft.apply();

    expect(JSON.parse(await readFile(join(cwd, "packages/ui/package.json"), "utf8"))).toMatchObject(
      {
        dependencies: {
          "@acme/core": "file:../../vendor/core",
        },
      },
    );
  });

  test("links file: dependencies to workspace packages by path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-draft-file-linked-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, "packages/core"), { recursive: true });
    await mkdir(join(cwd, "packages/ui"), { recursive: true });
    await mkdir(join(cwd, ".tegami"), { recursive: true });
    await writeFile(
      join(cwd, "pnpm-workspace.yaml"),
      `packages:
  - "packages/*"
`,
    );
    await writeJson(join(cwd, "packages/core/package.json"), {
      name: "@acme/core",
      version: "1.0.0",
    });
    await writeJson(join(cwd, "packages/ui/package.json"), {
      name: "@acme/ui",
      version: "1.0.0",
      dependencies: {
        "@acme/core": "file:../core",
      },
    });
    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages: ["@acme/core"]
---

## Core release

Core only.
`,
    );

    const draft = await tegami({ cwd }).draft();

    expect(draft.getPackageDraft("npm:@acme/core")?.type).toBe("minor");
    expect(draft.getPackageDraft("npm:@acme/ui")?.type).toBe("patch");
  });

  test("uses a custom log generator", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const draft = await tegami({
      cwd,
      generator: {
        generate({ pkg }) {
          return `## custom ${pkg.name}@${pkg.version}`;
        },
      },
    }).draft();

    await draft.apply();

    await expect(
      await readFile(join(cwd, "packages/core/CHANGELOG.md"), "utf8"),
    ).toMatchFileSnapshot("./__snapshots__/custom-generator-changelog.md");
  });

  test("blocks new publish plans until the existing plan is finished", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    await writePublishLock(cwd, {
      packages: [{ id: "npm:@acme/core", updated: true }],
      npm: [{ id: "npm:@acme/core", distTag: "latest" }],
    });

    await expect(tegami({ cwd }).publishStatus()).resolves.toBe("pending");
  });

  test("excludes packages listed in ignore", async () => {
    const cwd = await createWorkspace({ changelog: false });
    tempDirs.push(cwd);

    const graph = (
      await tegami({
        cwd,
        ignore: ["@acme/ui"],
      })._internal.context()
    ).graph;

    expect(graph.get("npm:@acme/core")).toBeDefined();
    expect(graph.getByName("@acme/ui")).toEqual([]);

    const graphById = (
      await tegami({
        cwd,
        ignore: ["npm:@acme/core"],
      })._internal.context()
    ).graph;

    expect(graphById.get("npm:@acme/core")).toBeUndefined();
    expect(graphById.get("npm:@acme/ui")).toBeDefined();
  });

  test("excludes packages matching ignore regex", async () => {
    const cwd = await createWorkspace({ changelog: false });
    tempDirs.push(cwd);

    const graph = (
      await tegami({
        cwd,
        ignore: [/^@acme\/ui$/],
      })._internal.context()
    ).graph;

    expect(graph.get("npm:@acme/core")).toBeDefined();
    expect(graph.getByName("@acme/ui")).toEqual([]);

    const graphByPattern = (
      await tegami({
        cwd,
        ignore: [/^npm:@acme/],
      })._internal.context()
    ).graph;

    expect(graphByPattern.getPackages()).toEqual([]);
  });

  test("keeps replay changelog files until all replay conditions are consumed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-draft-replay-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, "packages/tegami"), { recursive: true });
    await mkdir(join(cwd, ".tegami"), { recursive: true });
    await writeFile(
      join(cwd, "pnpm-workspace.yaml"),
      `packages:
  - "packages/*"
`,
    );
    await writeJson(join(cwd, "packages/tegami/package.json"), {
      name: "tegami",
      version: "1.0.0",
    });
    await writeFile(
      join(cwd, ".tegami/replay.md"),
      `---
packages:
  npm:tegami:
    type: patch
    replay: [tegami@1.1.0]
---

## Use preferred package manager

This ensures the pm-specific protocols are respected.
`,
    );

    const paper = tegami({ cwd });
    const draft = await paper.draft();

    expect(draft.getPackageDraft("npm:tegami")?.type).toBe("patch");
    await draft.apply();

    expect(JSON.parse(await readFile(join(cwd, "packages/tegami/package.json"), "utf8"))).toEqual({
      name: "tegami",
      version: "1.0.1",
    });
    expect(await readFile(join(cwd, ".tegami/replay.md"), "utf8")).toMatchInlineSnapshot(`
      "---
      packages:
        npm:tegami:
          replay:
            - tegami@1.1.0
      ---

      ## Use preferred package manager

      This ensures the pm-specific protocols are respected.
      "
    `);
    expect(await readFile(join(cwd, "packages/tegami/CHANGELOG.md"), "utf8")).toContain(
      "## Use preferred package manager",
    );

    await writeFile(
      join(cwd, ".tegami/minor.md"),
      `---
packages: ["tegami"]
---

## Minor release

More features.
`,
    );
    await rm(join(cwd, ".tegami/publish-lock.yaml"), { force: true });

    const replayDraft = await paper.draft();
    expect(replayDraft.getPackageDraft("npm:tegami")?.type).toBe("minor");
    await replayDraft.apply();

    expect(JSON.parse(await readFile(join(cwd, "packages/tegami/package.json"), "utf8"))).toEqual({
      name: "tegami",
      version: "1.1.0",
    });
    await expect(readFile(join(cwd, ".tegami/replay.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const changelog = await readFile(join(cwd, "packages/tegami/CHANGELOG.md"), "utf8");
    expect(changelog.match(/## Use preferred package manager/g)?.length).toBe(2);
    expect(changelog).toContain("## Minor release");
  });

  test("auto-adds exit prerelease replay during apply for prerelease packages", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-draft-auto-replay-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, "packages/tegami"), { recursive: true });
    await mkdir(join(cwd, ".tegami"), { recursive: true });
    await writeFile(
      join(cwd, "pnpm-workspace.yaml"),
      `packages:
  - "packages/*"
`,
    );
    await writeJson(join(cwd, "packages/tegami/package.json"), {
      name: "tegami",
      version: "1.0.0-beta.0",
    });
    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages:
  npm:tegami: patch
---

## Beta fix

Fixed something during beta.
`,
    );

    const paper = tegami({
      cwd,
      packages: {
        tegami: { prerelease: "beta" },
      },
    });
    const draft = await paper.draft();

    expect(draft.getPackageDraft("npm:tegami")?.type).toBe("patch");
    await draft.apply();

    expect(JSON.parse(await readFile(join(cwd, "packages/tegami/package.json"), "utf8"))).toEqual({
      name: "tegami",
      version: "1.0.0-beta.1",
    });
    const keptChangelog = await readFile(join(cwd, ".tegami/change.md"), "utf8");
    expect(keptChangelog).toContain("exit-prerelease(npm:tegami)");
    expect(keptChangelog).not.toContain("type:");
    expect(await readFile(join(cwd, "packages/tegami/CHANGELOG.md"), "utf8")).toContain(
      "## Beta fix",
    );
  });

  test("discovers packages with nested workspace globs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-draft-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, "examples/nested/pkg"), { recursive: true });
    await mkdir(join(cwd, "examples/ignored/pkg"), { recursive: true });
    await writeFile(
      join(cwd, "pnpm-workspace.yaml"),
      `packages:
  - "examples/**"
  - "!examples/ignored/**"
`,
    );
    await writeJson(join(cwd, "examples/nested/pkg/package.json"), {
      name: "@acme/nested",
      version: "1.0.0",
    });
    await writeJson(join(cwd, "examples/ignored/pkg/package.json"), {
      name: "@acme/ignored",
      version: "1.0.0",
    });

    const graph = (await tegami({ cwd })._internal.context()).graph;

    expect(normalizeDirPath(graph.get("npm:@acme/nested")?.path ?? "")).toBe(
      normalizeDirPath(join(cwd, "examples/nested/pkg")),
    );
    expect(graph.getByName("@acme/ignored")).toEqual([]);
  });
});

async function createWorkspace(options: { changelog?: boolean } = {}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-draft-"));

  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await mkdir(join(cwd, "packages/ui"), { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await writeFile(
    join(cwd, "pnpm-workspace.yaml"),
    `packages:
  - "packages/*"
`,
  );
  await writeJson(join(cwd, "packages/core/package.json"), {
    name: "@acme/core",
    version: "1.0.0",
  });
  await writeJson(join(cwd, "packages/ui/package.json"), {
    name: "@acme/ui",
    version: "1.0.0",
    dependencies: {
      "@acme/core": "^1.0.0",
      "@acme/core-alias": "npm:@acme/core@~1.0.0",
    },
    devDependencies: {
      "@acme/core": "workspace:^1.0.0",
    },
    peerDependencies: {
      "@acme/core": "workspace:*",
    },
    optionalDependencies: {
      "@acme/core": "~1.0.0",
    },
  });
  if (options.changelog !== false) {
    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages: ["@acme/core", "@acme/ui"]
---

## Add shared API

Useful release note.
`,
    );
  }

  return cwd;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeDirPath(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
}
