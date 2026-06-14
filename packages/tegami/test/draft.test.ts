import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { planStoreSchema, type PackageManifest } from "../src/schemas";

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

describe("draft publish plans", () => {
  test("builds an editable draft and writes an executable publish plan", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const paper = tegami({
      cwd,
      packages: {
        "@acme/core": {
          distTag: "alpha",
        },
      },
    });

    const draft = await paper.draft();
    const packages = draft.getPackageIds();
    const changelogId = draft.getChangelogIds()[0];

    expect(changelogId).toEqual(expect.any(String));
    expect({
      packages,
      core: normalizePackagePlan(draft.getPackage("npm:@acme/core")),
      ui: normalizePackagePlan(draft.getPackage("npm:@acme/ui")),
    }).toMatchInlineSnapshot(`
      {
        "core": {
          "changelogIds": [
            "change.md:0",
          ],
          "distTag": "alpha",
          "publish": true,
          "type": "minor",
        },
        "packages": [
          "npm:@acme/core",
          "npm:@acme/ui",
        ],
        "ui": {
          "changelogIds": [
            "change.md:0",
          ],
          "distTag": undefined,
          "publish": true,
          "type": "minor",
        },
      }
    `);

    await draft.createPublishPlan();

    expect({
      core: await readJson<PackageManifest>(join(cwd, "packages/core/package.json")),
      ui: await readJson<PackageManifest>(join(cwd, "packages/ui/package.json")),
    }).toMatchInlineSnapshot(`
      {
        "core": {
          "name": "@acme/core",
          "version": "1.1.0",
        },
        "ui": {
          "dependencies": {
            "@acme/core": "^1.0.0",
            "@acme/core-alias": "npm:@acme/core@1.1.0",
          },
          "devDependencies": {
            "@acme/core": "workspace:^1.0.0",
          },
          "name": "@acme/ui",
          "optionalDependencies": {
            "@acme/core": "1.1.0",
          },
          "peerDependencies": {
            "@acme/core": "workspace:*",
          },
          "version": "1.1.0",
        },
      }
    `);
    expect(await readFile(join(cwd, "packages/core/CHANGELOG.md"), "utf8")).toContain("## 1.1.0");
    await expect(readFile(join(cwd, ".tegami/change.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const rawPlan = await readJson<{
      packages: Record<string, { version?: string; distTag?: string; changelogIds: string[] }>;
    }>(join(cwd, ".tegami/publish-plan.json"));
    const plan = planStoreSchema.decode(
      await readFile(join(cwd, ".tegami/publish-plan.json"), "utf8"),
    );

    expect({
      changelogs: plan.changelogs,
      packages: Object.fromEntries(
        Object.entries(plan.packages).map(([name, packagePlan]) => [
          name,
          normalizePackagePlan(packagePlan),
        ]),
      ),
      rawPackageVersions: Object.fromEntries(
        Object.entries(rawPlan.packages).map(([name, packagePlan]) => [name, packagePlan.version]),
      ),
    }).toMatchInlineSnapshot(`
      {
        "changelogs": {
          "change.md:0": {
            "content": "Useful release note.",
            "filename": "change.md",
            "packages": [
              "@acme/core",
              "@acme/ui",
            ],
            "title": "Add shared API",
            "type": "minor",
          },
        },
        "packages": {
          "npm:@acme/core": {
            "changelogIds": [
              "change.md:0",
            ],
            "distTag": "alpha",
            "publish": true,
            "type": "minor",
          },
          "npm:@acme/ui": {
            "changelogIds": [
              "change.md:0",
            ],
            "publish": true,
            "type": "minor",
          },
        },
        "rawPackageVersions": {
          "npm:@acme/core": undefined,
          "npm:@acme/ui": undefined,
        },
      }
    `);
  });

  test("omits packages without pending changelogs from the draft", async () => {
    const cwd = await createWorkspace({
      changelog: false,
    });
    tempDirs.push(cwd);

    const draft = await tegami({ cwd }).draft();

    expect(draft.getPackageIds()).toEqual([]);
  });

  test("uses a custom log generator", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const draft = await tegami({
      cwd,
      generator: {
        generate({ packageName, version }) {
          return `## custom ${packageName}@${version}`;
        },
      },
    }).draft();

    await draft.createPublishPlan();

    await expect(
      await readFile(join(cwd, "packages/core/CHANGELOG.md"), "utf8"),
    ).toMatchFileSnapshot("./__snapshots__/custom-generator-changelog.md");
  });

  test("blocks new publish plans until the existing plan is finished", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    await writeJson(join(cwd, ".tegami/publish-plan.json"), {
      id: "tegami-existing",
      createdAt: "2026-01-01T00:00:00.000Z",
      changelogs: {},
      packages: {
        "npm:@acme/core": {
          type: "patch",
          changelogIds: [],
          distTag: "latest",
          publish: true,
        },
      },
    });

    const draft = await tegami({ cwd }).draft();
    exec.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
    } as Awaited<ReturnType<typeof x>>);

    await expect(draft.createPublishPlan()).rejects.toThrow(/Publish plan already exists/);
    expect(await readJson<PackageManifest>(join(cwd, "packages/core/package.json"))).toMatchObject({
      version: "1.0.0",
    });
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

    const graph = await tegami({ cwd }).graph();

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

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function normalizePackagePlan(
  plan: { changelogIds: Set<string>; distTag?: string; publish: boolean; type: string } | undefined,
) {
  if (!plan) return undefined;

  return {
    ...plan,
    changelogIds: Array.from(plan.changelogIds),
  };
}

function normalizeDirPath(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
}
