import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { initSync, parse } from "@rainbowatcher/toml-edit-js";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { pip } from "../src/index";
import { isPackagePublished, normalizePyPiName, updateConstraintRange } from "../src/utils";
import { pyprojectManifestSchema } from "../src/schema";
import { tegami } from "tegami";
import { parsePublishLock } from "../../tegami/src/plans/lock";
import {
  installRegistryFetchMock,
  mockRegistryMissing,
} from "../../tegami/test/helpers/registry-fetch";

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

describe("normalizePyPiName", () => {
  test("collapses separator runs per PEP 503", () => {
    expect(normalizePyPiName("My.Package")).toBe("my-package");
    expect(normalizePyPiName("acme_core")).toBe("acme-core");
    expect(normalizePyPiName("foo---bar")).toBe("foo-bar");
  });
});

describe("updateConstraintRange", () => {
  test("preserves compound ranges when updating lower bounds", () => {
    expect(updateConstraintRange(">=1.0.0,<2.0.0", "1.1.0")).toBe(">=1.1.0,<2.0.0");
    expect(updateConstraintRange(">1.0.0", "1.1.0")).toBe(">1.1.0");
    expect(updateConstraintRange("~=1.0.0", "1.1.0")).toBe("~=1.1.0");
  });
});

describe("isPackagePublished", () => {
  test("returns false when the project is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(
      isPackagePublished("acme-core", "1.1.0", "https://pypi.org/simple/"),
    ).resolves.toBe(false);
  });

  test("matches wheel and sdist filenames for the exact version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          files: [
            { filename: "acme-core-1.1.0-py3-none-any.whl" },
            { filename: "acme-core-1.1.0-1-py3-none-any.whl" },
            { filename: "acme-core-1.1.0.tar.gz" },
            { filename: "acme-core-1.0.0-py3-none-any.whl" },
          ],
        }),
      ),
    );

    await expect(
      isPackagePublished("acme-core", "1.1.0", "https://pypi.org/simple/"),
    ).resolves.toBe(true);
    await expect(
      isPackagePublished("acme-core", "1.2.0", "https://pypi.org/simple/"),
    ).resolves.toBe(false);
  });

  test("does not treat a prefix version as published", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          files: [{ filename: "acme-core-1.0.0-py3-none-any.whl" }],
        }),
      ),
    );

    await expect(isPackagePublished("acme-core", "1.0", "https://pypi.org/simple/")).resolves.toBe(
      false,
    );
  });

  test("normalizes the project name per PEP 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://pypi.org/simple/my-package/");
        return Response.json({
          files: [{ filename: "my-package-1.1.0-py3-none-any.whl" }],
        });
      }),
    );

    await expect(
      isPackagePublished("My.Package", "1.1.0", "https://pypi.org/simple/"),
    ).resolves.toBe(true);
  });
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
    expect((table(api.project)?.dependencies as string[] | undefined)?.[0]).toBe(
      "acme-core>=1.0.0",
    );

    const packageIds: string[] = [];
    let entry: unknown;
    while ((entry = lock.read("core:packages"))) {
      packageIds.push((entry as { id: string }).id);
    }
    expect(packageIds.sort()).toEqual(["npm:@acme/js", "pip:acme-api", "pip:acme-core"].sort());
  });

  test("updates compatible-release constraints with PEP 440 semantics", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pip-pep440-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, "packages/core"), { recursive: true });
    await mkdir(join(cwd, "packages/api"), { recursive: true });
    await mkdir(join(cwd, ".tegami"), { recursive: true });

    await writeFile(
      join(cwd, "pyproject.toml"),
      `[project]
name = "pep440-workspace"
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
dependencies = ["acme-core~=1.0.0"]

[tool.uv.sources]
acme-core = { workspace = true }
`,
    );
    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages: ["acme-core"]
---

## Core release

Bump core.
`,
    );

    exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as Awaited<
      ReturnType<typeof x>
    >);
    await tegami({ cwd, plugins: [pip()] })
      .draft()
      .then((draft) => draft.apply());

    const core = await readPyproject(join(cwd, "packages/core"));
    const api = await readPyproject(join(cwd, "packages/api"));
    expect(table(core.project)?.version).toBe("1.1.0");
    expect((table(api.project)?.dependencies as string[] | undefined)?.[0]).toBe(
      "acme-core~=1.1.0",
    );
  });

  test("bumps workspace dependents even when the version constraint is still satisfied", async () => {
    const cwd = await createMixedWorkspace();
    tempDirs.push(cwd);

    exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as Awaited<
      ReturnType<typeof x>
    >);
    await tegami({ cwd, plugins: [pip()] })
      .draft()
      .then((draft) => draft.apply());

    const api = await readPyproject(join(cwd, "packages/api"));
    expect(table(api.project)?.version).toBe("1.0.1");
  });

  test("does not bump dependents when a non-workspace constraint is still satisfied", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pip-satisfied-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, "packages/core"), { recursive: true });
    await mkdir(join(cwd, "packages/api"), { recursive: true });
    await mkdir(join(cwd, ".tegami"), { recursive: true });

    await writeFile(
      join(cwd, "pyproject.toml"),
      `[project]
name = "satisfied-workspace"
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
`,
    );
    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages: ["acme-core"]
---

## Core release

Bump core.
`,
    );

    exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as Awaited<
      ReturnType<typeof x>
    >);
    await tegami({ cwd, plugins: [pip()] })
      .draft()
      .then((draft) => draft.apply());

    const core = await readPyproject(join(cwd, "packages/core"));
    const api = await readPyproject(join(cwd, "packages/api"));
    expect(table(core.project)?.version).toBe("1.1.0");
    expect(table(api.project)?.version).toBe("1.0.0");
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

    const graph = await paperInstance._internal.context();
    expect(
      graph.graph
        .getPackages()
        .filter((pkg) => {
          const plan = draft.getPackageDraft(pkg.id);
          return plan && plan.bumpVersion(pkg) !== pkg.version;
        })
        .map((pkg) => pkg.id)
        .sort(),
    ).toEqual(["npm:pkg-a", "pip:pkg-a"]);
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
    expect(written).toContain('"acme-core>=1.0.0"');
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
    const uvPublishCalls = exec.mock.calls
      .filter(([command]) => command === "uv")
      .map(([command, args, options]) => ({
        command,
        args,
        cwd: normalizeDirPath(String(options?.nodeOptions?.cwd)),
      }));
    expect(uvPublishCalls).toHaveLength(2);
    expect(uvPublishCalls).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@acme/js/1.1.0",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://pypi.org/simple/acme-core/",
      expect.objectContaining({ headers: { Accept: "application/vnd.pypi.simple.v1+json" } }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://pypi.org/simple/acme-api/",
      expect.objectContaining({ headers: { Accept: "application/vnd.pypi.simple.v1+json" } }),
    );
  });

  test("normalizes dotted PyPI project names in publish status checks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pip-dotted-name-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, ".tegami"), { recursive: true });

    await writeFile(
      join(cwd, "pyproject.toml"),
      `[project]
name = "My.Package"
version = "1.0.0"
`,
    );
    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages: ["My.Package"]
---

## Dotted name

Release with separators.
`,
    );

    await tegami({ cwd, plugins: [pip()] })
      .draft()
      .then((draft) => draft.apply());

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://pypi.org/simple/my-package/");
      expect(init?.headers).toEqual({ Accept: "application/vnd.pypi.simple.v1+json" });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    exec.mockImplementation(() => commandResult());

    await tegami({ cwd, plugins: [pip()] }).publish();

    expect(fetchMock).toHaveBeenCalled();
  });

  test("publishes circular pip workspace dependencies", async () => {
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

    const result = await tegami({ cwd, plugins: [pip()] }).publish();

    if (result === "skipped") {
      throw new Error("expected publish plan, got skipped");
    }

    expect(
      [...result.packages.entries()]
        .filter(([, plan]) => plan.publishResult?.type === "published")
        .map(([id]) => id)
        .sort(),
    ).toEqual(["pip:pkg-a", "pip:pkg-b"]);
  });

  test("links workspace packages by dependency name", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pip-normalized-link-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, "packages/core"), { recursive: true });
    await mkdir(join(cwd, "packages/api"), { recursive: true });
    await mkdir(join(cwd, ".tegami"), { recursive: true });

    await writeFile(
      join(cwd, "pyproject.toml"),
      `[project]
name = "normalized-workspace"
version = "0.0.0"

[tool.uv.workspace]
members = ["packages/core", "packages/api"]
`,
    );
    await writeFile(
      join(cwd, "packages/core/pyproject.toml"),
      `[project]
name = "my-core"
version = "1.0.0"
`,
    );
    await writeFile(
      join(cwd, "packages/api/pyproject.toml"),
      `[project]
name = "acme-api"
version = "1.0.0"
dependencies = ["my-core>=1.0.0"]

[tool.uv.sources]
my-core = { workspace = true }
`,
    );
    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages: ["my-core"]
---

## Core release

Bump core.
`,
    );

    exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as Awaited<
      ReturnType<typeof x>
    >);
    await tegami({ cwd, plugins: [pip()] })
      .draft()
      .then((draft) => draft.apply());

    const api = await readPyproject(join(cwd, "packages/api"));
    expect(table(api.project)?.version).toBe("1.0.1");
    expect((table(api.project)?.dependencies as string[] | undefined)?.[0]).toBe("my-core>=1.0.0");
  });

  test("updates dependency-groups constraints for workspace members", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pip-dep-groups-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, "packages/core"), { recursive: true });
    await mkdir(join(cwd, "packages/api"), { recursive: true });
    await mkdir(join(cwd, ".tegami"), { recursive: true });

    await writeFile(
      join(cwd, "pyproject.toml"),
      `[project]
name = "dep-groups-workspace"
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

[dependency-groups]
dev = ["acme-core>=1.0.0"]

[tool.uv.sources]
acme-core = { workspace = true }
`,
    );
    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages: ["acme-core"]
---

## Core release

Bump core.
`,
    );

    exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as Awaited<
      ReturnType<typeof x>
    >);
    await tegami({ cwd, plugins: [pip()] })
      .draft()
      .then((draft) => draft.apply());

    const api = await readPyproject(join(cwd, "packages/api"));
    expect(table(api["dependency-groups"] as TomlTable)?.dev).toEqual(["acme-core>=1.0.0"]);
    expect(table(api.project)?.version).toBe("1.0.0");
  });

  test("uses a custom publish index from the workspace root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-pip-custom-index-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, ".tegami"), { recursive: true });

    await writeFile(
      join(cwd, "pyproject.toml"),
      `[project]
name = "custom-index"
version = "1.0.0"

[[tool.uv.index]]
name = "testpypi"
url = "https://test.pypi.org/simple/"
publish-url = "https://test.pypi.org/legacy/"
`,
    );
    await writeFile(
      join(cwd, ".tegami/change.md"),
      `---
packages: ["custom-index"]
---

## Custom index

Release to TestPyPI.
`,
    );

    await tegami({ cwd, plugins: [pip({ publishIndex: "testpypi" })] })
      .draft()
      .then((draft) => draft.apply());

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://test.pypi.org/simple/custom-index/");
      expect(init?.headers).toEqual({ Accept: "application/vnd.pypi.simple.v1+json" });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    exec.mockImplementation(() => commandResult());

    await tegami({ cwd, plugins: [pip({ publishIndex: "testpypi" })] }).publish();

    expect(fetchMock).toHaveBeenCalled();
    expect(exec.mock.calls[0]).toEqual([
      "uv",
      [
        "publish",
        "--publish-url",
        "https://test.pypi.org/legacy/",
        "--check-url",
        "https://test.pypi.org/simple/",
      ],
      { nodeOptions: { cwd } },
    ]);
  });
});

describe("pyproject manifest schema", () => {
  test("requires a project section", () => {
    expect(() =>
      pyprojectManifestSchema.parse(parse(`[tool.uv.workspace]\nmembers = ["packages/*"]\n`)),
    ).toThrow();
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
