import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import type { PackageManifest } from "../src/schemas";

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
  test("versions workspace packages and writes an executable publish plan", async () => {
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

    expect(draft.packages.map((pkg) => [pkg.name, pkg.version])).toEqual([
      ["@acme/core", "1.1.0"],
      ["@acme/ui", "1.1.0"],
    ]);
    const changelogId = draft.changelogs[0]?.id;
    expect(changelogId).toEqual(expect.any(String));
    expect(Array.from(draft.packages[0]!.changelogIds)).toEqual([changelogId]);

    const storedPlan = await draft.createPublishPlan();

    expect(storedPlan.packages).toHaveLength(2);
    expect(await readJson<PackageManifest>(join(cwd, "packages/core/package.json"))).toMatchObject({
      version: "1.1.0",
    });
    expect(await readJson<PackageManifest>(join(cwd, "packages/ui/package.json"))).toMatchObject({
      version: "1.1.0",
      dependencies: {
        "@acme/core": "^1.1.0",
      },
    });
    expect(await readFile(join(cwd, "packages/core/CHANGELOG.md"), "utf8")).toContain("## 1.1.0");
    await expect(readFile(join(cwd, ".tegami/change.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const plan = await readJson<{
      changelogs: Array<{
        id: string;
        file: string;
      }>;
      packages: Array<{
        name: string;
        version: string;
        distTag: string;
        changelogs?: unknown;
        changelogIds: string[];
      }>;
    }>(join(cwd, ".tegami/publish-plan.json"));

    const storedChangelogId = plan.changelogs[0]?.id;
    expect(storedChangelogId).toEqual(expect.any(String));
    expect(plan.changelogs).toEqual([
      expect.objectContaining({
        id: storedChangelogId,
        file: join(cwd, ".tegami/change.md"),
      }),
    ]);
    expect(plan.packages).toContainEqual(
      expect.objectContaining({
        name: "@acme/core",
        version: "1.1.0",
        distTag: "alpha",
        changelogIds: [storedChangelogId],
      }),
    );
    expect(plan.packages.every((pkg) => pkg.changelogs === undefined)).toBe(true);
  });

  test("omits packages without pending changelogs from the draft", async () => {
    const cwd = await createWorkspace({
      changelog: false,
    });
    tempDirs.push(cwd);

    const draft = await tegami({ cwd }).draft();

    expect(draft.packages).toEqual([]);
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

    expect(await readFile(join(cwd, "packages/core/CHANGELOG.md"), "utf8")).toContain(
      "## custom @acme/core@1.1.0",
    );
  });

  test("blocks new publish plans until the existing plan is finished", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    await writeJson(join(cwd, ".tegami/publish-plan.json"), {
      id: "tegami-existing",
      createdAt: "2026-01-01T00:00:00.000Z",
      changelogs: [],
      packages: [
        {
          name: "@acme/core",
          version: "1.0.1",
          changelogIds: [],
          distTag: "latest",
          gitTag: "@acme/core@1.0.1",
          publish: true,
        },
      ],
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

    expect(graph.get("@acme/nested")?.path).toBe(join(cwd, "examples/nested/pkg"));
    expect(graph.get("@acme/ignored")).toBeUndefined();
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
