import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { initSync, parse } from "@rainbowatcher/toml-edit-js";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { pip } from "../src/plugins/pip";
import { parsePublishLock } from "../src/plans/lock";
import { getPendingPackageIds } from "./helpers/draft";
import { installRegistryFetchMock, mockRegistryMissing } from "./helpers/registry-fetch";

initSync();

type TomlTable = Record<string, unknown>;

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
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("pip packages", () => {
  test("skips uv lock update on npm-only workspaces", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pip-inactive-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, ".tegami"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      `${JSON.stringify({ name: "root", version: "1.0.0" }, null, 2)}\n`,
    );
    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages: ["root"]
---

## Change

Note.
`,
    );

    exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as Awaited<
      ReturnType<typeof x>
    >);
    await tegami({ cwd, plugins: [pip()] })
      .draft()
      .then((draft) => draft.apply());

    expect(exec.mock.calls.some(([command]) => command === "uv")).toBe(false);
  });

  test("resolves npm packages and python projects into one graph", async () => {
    const cwd = await createMixedWorkspace();
    tempDirs.push(cwd);

    const graph = (await tegami({ cwd, plugins: [pip()] })._internal.context()).graph;
    const packages = graph.getPackages().map((pkg) => ({
      manager: pkg.manager,
      name: pkg.name,
      version: pkg.version,
    }));

    expect(packages).toHaveLength(3);
    expect(packages).toEqual(
      expect.arrayContaining([
        {
          manager: "npm",
          name: "@acme/js",
          version: "1.0.0",
        },
        {
          manager: "pip",
          name: "acme-core",
          version: "1.0.0",
        },
        {
          manager: "pip",
          name: "acme-api",
          version: "1.0.0",
        },
      ]),
    );
  });

  test("writes a mixed npm and pip publish lock", async () => {
    const cwd = await createMixedWorkspace();
    tempDirs.push(cwd);

    const draft = await tegami({ cwd, plugins: [pip()] }).draft();
    await draft.apply();

    const npmPackage = JSON.parse(await readFile(join(cwd, "packages/js/package.json"), "utf8"));
    const core = await readPyproject(join(cwd, "packages/core"));
    const api = await readPyproject(join(cwd, "packages/api"));
    const lock = parsePublishLock(await readFile(join(cwd, ".tegami/publish-lock.yaml"), "utf8"));

    expect(npmPackage.version).toBe("1.1.0");
    expect(table(core.project)?.version).toBe("1.1.0");
    expect(table(api.project)?.version).toBe("1.0.1");
    expect((table(api.project)?.dependencies as string[])[0]).toBe("acme-core>=1.1.0");

    const packageIds: string[] = [];
    let entry: unknown;
    while ((entry = lock.read("core:packages"))) {
      packageIds.push((entry as { id: string }).id);
    }
    expect(packageIds.sort()).toEqual(
      ["npm:@acme/js", "pip:acme-api", "pip:acme-core"].sort(),
    );
  });

  test("allows npm packages and python projects with the same name", async () => {
    const cwd = await createDuplicateNameWorkspace();
    tempDirs.push(cwd);

    const paperInstance = tegami({ cwd, plugins: [pip()] });
    const draft = await paperInstance.draft();
    await draft.apply();

    const npmPackage = JSON.parse(await readFile(join(cwd, "packages/pkg-a/package.json"), "utf8"));
    const project = await readPyproject(join(cwd, "packages/py-pkg-a"));
    const lock = parsePublishLock(await readFile(join(cwd, ".tegami/publish-lock.yaml"), "utf8"));

    expect(getPendingPackageIds(draft, (await paperInstance._internal.context()).graph).sort()).toEqual([
      "npm:pkg-a",
      "pip:pkg-a",
    ]);
    expect(npmPackage.version).toBe("1.1.0");
    expect(table(project.project)?.version).toBe("1.1.0");

    const packageIds: string[] = [];
    let entry: unknown;
    while ((entry = lock.read("core:packages"))) {
      packageIds.push((entry as { id: string }).id);
    }
    expect(packageIds.sort()).toEqual(["npm:pkg-a", "pip:pkg-a"]);
  });

  test("preserves pyproject.toml formatting and comments when applying a plan", async () => {
    const cwd = await createMixedWorkspace();
    tempDirs.push(cwd);

    const apiManifest = `[project]
name = "acme-api"
version = "1.0.0" # keep this comment
dependencies = [
  "acme-core>=1.0.0", # linked package
]

[tool.uv.sources]
acme-core = { workspace = true }
`;
    await writeFile(join(cwd, "packages/api/pyproject.toml"), apiManifest);

    await tegami({ cwd, plugins: [pip()] })
      .draft()
      .then((draft) => draft.apply());

    const written = await readFile(join(cwd, "packages/api/pyproject.toml"), "utf8");
    expect(written).toContain("# keep this comment");
    expect(written).toContain('version = "1.0.1"');
    expect(written).toContain('"acme-core>=1.1.0"');
  });

  test("routes npm and pip publishes through their registry clients", async () => {
    const cwd = await createMixedWorkspace();
    tempDirs.push(cwd);
    await tegami({ cwd, plugins: [pip()] })
      .draft()
      .then((draft) => draft.apply());

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("registry.npmjs.org")) {
          return new Response(JSON.stringify({ version: "1.1.0" }), { status: 200 });
        }

        return new Response("not found", { status: 404 });
      }),
    );
    exec.mockImplementation(() => commandResult());

    const result = await tegami({ cwd, plugins: [pip()] }).publish();

    if (result === "skipped") {
      throw new Error("expected publish plan, got skipped");
    }

    const published = [...result.packages.entries()]
      .filter(([, plan]) => plan.publishResult!.type === "published")
      .map(([id]) => id);

    expect(published.sort()).toEqual(["pip:acme-api", "pip:acme-core"].sort());
    expect(result.packages.get("npm:@acme/js")?.publishResult).toEqual({ type: "skipped" });
    expect(
      exec.mock.calls.map(([command, args, options]) => ({
        command,
        args,
        cwd: normalizeDirPath(String(options?.nodeOptions?.cwd)),
      })),
    ).toEqual([
      {
        command: "uv",
        args: ["publish"],
        cwd: normalizeDirPath(join(cwd, "packages/core")),
      },
      {
        command: "uv",
        args: ["publish"],
        cwd: normalizeDirPath(join(cwd, "packages/api")),
      },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@acme/js/1.1.0",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(fetch).toHaveBeenCalledWith("https://pypi.org/pypi/acme-core/1.1.0/json");
    expect(fetch).toHaveBeenCalledWith("https://pypi.org/pypi/acme-api/1.0.1/json");
  });

  test("throws on circular pip workspace dependencies", async () => {
    const cwd = await createCircularPipWorkspace();
    tempDirs.push(cwd);
    await tegami({ cwd, plugins: [pip()] })
      .draft()
      .then((draft) => draft.apply());

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 404,
        text: async () => "not found",
      })),
    );
    exec.mockImplementation(() => commandResult());

    await expect(tegami({ cwd, plugins: [pip()] }).publish()).rejects.toThrow(/circular reference of deps/);
  });
});

async function createMixedWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-pip-"));
  await mkdir(join(cwd, "packages/js"), { recursive: true });
  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await mkdir(join(cwd, "packages/api"), { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });

  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeJson(join(cwd, "packages/js/package.json"), {
    name: "@acme/js",
    version: "1.0.0",
  });
  await writeFile(
    join(cwd, "pyproject.toml"),
    `[project]
name = "acme-workspace"
version = "0.0.0"

[tool.uv.workspace]
members = ["packages/core", "packages/api"]
`,
  );
  await writeFile(
    join(cwd, "packages/core/pyproject.toml"),
    `[project]
name = "acme-core"
version = "1.0.0"
`,
  );
  await writeFile(
    join(cwd, "packages/api/pyproject.toml"),
    `[project]
name = "acme-api"
version = "1.0.0"
dependencies = ["acme-core>=1.0.0"]

[tool.uv.sources]
acme-core = { workspace = true }
`,
  );
  await writeFile(
    join(cwd, ".tegami/change.md"),
    `---
packages: ["@acme/js", "acme-core"]
---

## Mixed release

Ship JS bindings and the Python packages together.
`,
  );

  return cwd;
}

async function createCircularPipWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-pip-cycle-"));
  await mkdir(join(cwd, "packages/a"), { recursive: true });
  await mkdir(join(cwd, "packages/b"), { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });

  await writeFile(
    join(cwd, "pyproject.toml"),
    `[project]
name = "cycle-workspace"
version = "0.0.0"

[tool.uv.workspace]
members = ["packages/*"]
`,
  );
  await writeFile(
    join(cwd, "packages/a/pyproject.toml"),
    `[project]
name = "pkg-a"
version = "1.0.0"
dependencies = ["pkg-b>=1.0.0"]

[tool.uv.sources]
pkg-b = { workspace = true }
`,
  );
  await writeFile(
    join(cwd, "packages/b/pyproject.toml"),
    `[project]
name = "pkg-b"
version = "1.0.0"
dependencies = ["pkg-a>=1.0.0"]

[tool.uv.sources]
pkg-a = { workspace = true }
`,
  );
  await writeFile(
    join(cwd, ".tegami/change.md"),
    `---
packages: ["pkg-a", "pkg-b"]
---

## Circular release

Both packages depend on each other.
`,
  );

  return cwd;
}

async function createDuplicateNameWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-pip-duplicate-"));
  await mkdir(join(cwd, "packages/pkg-a"), { recursive: true });
  await mkdir(join(cwd, "packages/py-pkg-a"), { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });

  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeJson(join(cwd, "packages/pkg-a/package.json"), {
    name: "pkg-a",
    version: "1.0.0",
  });
  await writeFile(
    join(cwd, "pyproject.toml"),
    `[project]
name = "duplicate-workspace"
version = "0.0.0"

[tool.uv.workspace]
members = ["packages/py-pkg-a"]
`,
  );
  await writeFile(
    join(cwd, "packages/py-pkg-a/pyproject.toml"),
    `[project]
name = "pkg-a"
version = "1.0.0"
`,
  );
  await writeFile(
    join(cwd, ".tegami/change.md"),
    `---
packages: ["pkg-a"]
---

## Shared package name

Release the npm package and Python project together.
`,
  );

  return cwd;
}

async function readPyproject(path: string): Promise<TomlTable> {
  return parse(await readFile(join(path, "pyproject.toml"), "utf8")) as TomlTable;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function table(value: unknown): TomlTable | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as TomlTable;
}

function normalizeDirPath(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
}

type ExecResult = Awaited<ReturnType<typeof x>>;

function commandResult(overrides: Partial<ExecResult> = {}): ReturnType<typeof x> {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  } as unknown as ReturnType<typeof x>;
}
