import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { initSync, parse } from "@rainbowatcher/toml-edit-js";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { parsePublishLock } from "../src/plans/lock";
import { getPendingPackageIds } from "./helpers/draft";
import { installRegistryFetchMock, mockRegistryMissing } from "./helpers/registry-fetch";

initSync();

type TomlTable = Record<string, unknown>;
type TomlValue = unknown;

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

describe("cargo packages", () => {
  test("skips cargo lockfile update on npm-only workspaces", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-cargo-inactive-"));
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
    await tegami({ cwd })
      .draft()
      .then((draft) => draft.apply());

    expect(exec.mock.calls.some(([command]) => command === "cargo")).toBe(false);
  });

  test("resolves npm packages and cargo crates into one graph", async () => {
    const cwd = await createMixedWorkspace();
    tempDirs.push(cwd);

    const graph = await tegami({ cwd })._internal.graph();
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
          manager: "cargo",
          name: "acme_core",
          version: "1.0.0",
        },
        {
          manager: "cargo",
          name: "acme_binding",
          version: "1.0.0",
        },
      ]),
    );
  });

  test("writes a mixed npm and cargo publish lock", async () => {
    const cwd = await createMixedWorkspace();
    tempDirs.push(cwd);

    const draft = await tegami({ cwd }).draft();
    await draft.apply();

    const npmPackage = JSON.parse(await readFile(join(cwd, "packages/js/package.json"), "utf8"));
    const core = await readCargo(join(cwd, "crates/core"));
    const binding = await readCargo(join(cwd, "crates/binding"));
    const lock = parsePublishLock(await readFile(join(cwd, ".tegami/publish-lock.yaml"), "utf8"));

    expect(npmPackage.version).toBe("1.1.0");
    expect(table(core.package)?.version).toBe("1.1.0");
    expect(table(table(binding.dependencies)?.acme_core)?.version).toBe("1.1.0");
    expect(table(binding.package)?.version).toBe("1.0.1");

    const packageIds: string[] = [];
    let entry: unknown;
    while ((entry = lock.read("core:packages"))) {
      packageIds.push((entry as { id: string }).id);
    }
    expect(packageIds.sort()).toEqual(
      ["cargo:acme_binding", "cargo:acme_core", "npm:@acme/js"].sort(),
    );
  });

  test("allows npm packages and cargo crates with the same name", async () => {
    const cwd = await createDuplicateNameWorkspace();
    tempDirs.push(cwd);

    const paper = tegami({ cwd });
    const draft = await paper.draft();
    await draft.apply();

    const npmPackage = JSON.parse(await readFile(join(cwd, "packages/pkg-a/package.json"), "utf8"));
    const crate = await readCargo(join(cwd, "crates/pkg-a"));
    const lock = parsePublishLock(await readFile(join(cwd, ".tegami/publish-lock.yaml"), "utf8"));

    expect(getPendingPackageIds(draft, (await paper._internal.context()).graph).sort()).toEqual([
      "cargo:pkg-a",
      "npm:pkg-a",
    ]);
    expect(npmPackage.version).toBe("1.1.0");
    expect(table(crate.package)?.version).toBe("1.1.0");

    const packageIds: string[] = [];
    let entry: unknown;
    while ((entry = lock.read("core:packages"))) {
      packageIds.push((entry as { id: string }).id);
    }
    expect(packageIds.sort()).toEqual(["cargo:pkg-a", "npm:pkg-a"]);
  });

  test("preserves Cargo.toml formatting and comments when applying a plan", async () => {
    const cwd = await createMixedWorkspace();
    tempDirs.push(cwd);

    const bindingManifest = `[package]
name = "acme_binding"
version = "1.0.0" # keep this comment

[dependencies]
acme_core = { path = "../core", version = "1.0.0" } # linked crate
`;
    await writeFile(join(cwd, "crates/binding/Cargo.toml"), bindingManifest);

    await tegami({ cwd })
      .draft()
      .then((draft) => draft.apply());

    const written = await readFile(join(cwd, "crates/binding/Cargo.toml"), "utf8");
    expect(written).toContain("# keep this comment");
    expect(written).toContain("# linked crate");
    expect(written).toContain('version = "1.0.1"');
    expect(written).toContain('version = "1.1.0"');
  });

  test("routes npm and cargo publishes through their registry clients", async () => {
    const cwd = await createMixedWorkspace();
    tempDirs.push(cwd);
    await tegami({ cwd })
      .draft()
      .then((draft) => draft.apply());

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    exec.mockImplementation(() => commandResult());

    const result = await tegami({ cwd, npm: { client: "npm" } }).publish();

    if (result === "skipped") {
      throw new Error("expected publish plan, got skipped");
    }

    const published = [...result.packages.entries()]
      .filter(([, plan]) => plan.publishResult!.type === "published")
      .map(([id]) => id);

    expect(published.sort()).toEqual(
      ["cargo:acme_binding", "cargo:acme_core", "npm:@acme/js"].sort(),
    );
    expect(
      exec.mock.calls.map(([command, args, options]) => ({
        command,
        args,
        cwd: normalizeDirPath(String(options?.nodeOptions?.cwd)),
      })),
    ).toEqual([
      {
        command: "npm",
        args: ["publish"],
        cwd: normalizeDirPath(join(cwd, "packages/js")),
      },
      {
        command: "cargo",
        args: ["publish"],
        cwd: normalizeDirPath(join(cwd, "crates/core")),
      },
      {
        command: "cargo",
        args: ["publish"],
        cwd: normalizeDirPath(join(cwd, "crates/binding")),
      },
    ]);
    expect(fetch).toHaveBeenCalledWith("https://crates.io/api/v1/crates/acme_core/1.1.0");
    expect(fetch).toHaveBeenCalledWith("https://crates.io/api/v1/crates/acme_binding/1.0.1");
  });

  test("throws on circular cargo workspace dependencies", async () => {
    const cwd = await createCircularCargoWorkspace();
    tempDirs.push(cwd);
    await tegami({ cwd })
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

    await expect(tegami({ cwd }).publish()).rejects.toThrow(/circular reference of deps/);
  });

  test("includes cargo crates without a version field in the graph", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-cargo-no-version-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, "crates/lib"), { recursive: true });
    await writeFile(
      join(cwd, "Cargo.toml"),
      `[workspace]
members = ["crates/*"]
`,
    );
    await writeFile(
      join(cwd, "crates/lib/Cargo.toml"),
      `[package]
name = "acme_lib"
`,
    );

    const graph = await tegami({ cwd })._internal.graph();
    const pkg = graph.get("cargo:acme_lib");

    expect(pkg).toBeDefined();
    expect(pkg!.version).toBe("0.0.0");
  });
});

async function createMixedWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-cargo-"));
  await mkdir(join(cwd, "packages/js"), { recursive: true });
  await mkdir(join(cwd, "crates/core"), { recursive: true });
  await mkdir(join(cwd, "crates/binding"), { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });

  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeJson(join(cwd, "packages/js/package.json"), {
    name: "@acme/js",
    version: "1.0.0",
  });
  await writeFile(
    join(cwd, "Cargo.toml"),
    `[workspace]
members = ["crates/*"]
`,
  );
  await writeFile(
    join(cwd, "crates/core/Cargo.toml"),
    `[package]
name = "acme_core"
version = "1.0.0"
`,
  );
  await writeFile(
    join(cwd, "crates/binding/Cargo.toml"),
    `[package]
name = "acme_binding"
version = "1.0.0"

[dependencies]
acme_core = { path = "../core", version = "1.0.0" }
`,
  );
  await writeFile(
    join(cwd, ".tegami/change.md"),
    `---
packages: ["@acme/js", "acme_core"]
---

## Mixed release

Ship JS bindings and the Rust crate together.
`,
  );

  return cwd;
}

async function createCircularCargoWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-cargo-cycle-"));
  await mkdir(join(cwd, "crates/a"), { recursive: true });
  await mkdir(join(cwd, "crates/b"), { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });

  await writeFile(
    join(cwd, "Cargo.toml"),
    `[workspace]
members = ["crates/*"]
`,
  );
  await writeFile(
    join(cwd, "crates/a/Cargo.toml"),
    `[package]
name = "crate_a"
version = "1.0.0"

[dependencies]
crate_b = { path = "../b", version = "1.0.0" }
`,
  );
  await writeFile(
    join(cwd, "crates/b/Cargo.toml"),
    `[package]
name = "crate_b"
version = "1.0.0"

[dependencies]
crate_a = { path = "../a", version = "1.0.0" }
`,
  );
  await writeFile(
    join(cwd, ".tegami/change.md"),
    `---
packages: ["crate_a", "crate_b"]
---

## Circular release

Both crates depend on each other.
`,
  );

  return cwd;
}

async function createDuplicateNameWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-cargo-duplicate-"));
  await mkdir(join(cwd, "packages/pkg-a"), { recursive: true });
  await mkdir(join(cwd, "crates/pkg-a"), { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });

  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeJson(join(cwd, "packages/pkg-a/package.json"), {
    name: "pkg-a",
    version: "1.0.0",
  });
  await writeFile(
    join(cwd, "Cargo.toml"),
    `[workspace]
members = ["crates/*"]
`,
  );
  await writeFile(
    join(cwd, "crates/pkg-a/Cargo.toml"),
    `[package]
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

Release the npm package and crate together.
`,
  );

  return cwd;
}

async function readCargo(path: string): Promise<TomlTable> {
  return parse(await readFile(join(path, "Cargo.toml"), "utf8")) as TomlTable;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function table(value: TomlValue | undefined): TomlTable | undefined {
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
