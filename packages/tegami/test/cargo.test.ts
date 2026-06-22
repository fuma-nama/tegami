import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { initSync, parse } from "@rainbowatcher/toml-edit-js";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { createTegamiContext } from "../src/context";
import { parsePlanStore } from "../src/plans/store";
import { getPendingPackageIds } from "./helpers/draft";

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
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("cargo packages", () => {
  test("resolves npm packages and cargo crates into one graph", async () => {
    const cwd = await createMixedWorkspace();
    tempDirs.push(cwd);

    const graph = await tegami({ cwd })._internal.graph();
    const context = await createTegamiContext({ cwd });

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
    expect(context.getRegistryClient("npm").id).toBe("npm");
    expect(context.getRegistryClient("cargo").id).toBe("cargo");
  });

  test("writes a mixed npm and cargo publish plan", async () => {
    const cwd = await createMixedWorkspace();
    tempDirs.push(cwd);

    const draft = await tegami({ cwd }).draft();
    await draft.applyPlan();

    const npmPackage = JSON.parse(await readFile(join(cwd, "packages/js/package.json"), "utf8"));
    const core = await readCargo(join(cwd, "crates/core"));
    const binding = await readCargo(join(cwd, "crates/binding"));
    const plan = parsePlanStore(await readFile(join(cwd, ".tegami/publish-plan"), "utf8"));

    expect(npmPackage.version).toBe("1.1.0");
    expect(table(core.package)?.version).toBe("1.1.0");
    expect(table(table(binding.dependencies)?.acme_core)?.version).toBe("1.1.0");
    expect(table(binding.package)?.version).toBe("1.0.1");
    expect(Object.keys(plan.packages).sort()).toEqual(
      ["cargo:acme_binding", "cargo:acme_core", "npm:@acme/js"].sort(),
    );
  });

  test("allows npm packages and cargo crates with the same name", async () => {
    const cwd = await createDuplicateNameWorkspace();
    tempDirs.push(cwd);

    const paper = tegami({ cwd });
    const draft = await paper.draft();
    await draft.applyPlan();

    const npmPackage = JSON.parse(await readFile(join(cwd, "packages/pkg-a/package.json"), "utf8"));
    const crate = await readCargo(join(cwd, "crates/pkg-a"));
    const plan = parsePlanStore(await readFile(join(cwd, ".tegami/publish-plan"), "utf8"));

    expect(getPendingPackageIds(draft, (await paper._internal.context()).graph).sort()).toEqual([
      "cargo:pkg-a",
      "npm:pkg-a",
    ]);
    expect(npmPackage.version).toBe("1.1.0");
    expect(table(crate.package)?.version).toBe("1.1.0");
    expect(Object.keys(plan.packages)).toEqual(["npm:pkg-a", "cargo:pkg-a"]);
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
      .then((draft) => draft.applyPlan());

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
      .then((draft) => draft.applyPlan());

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 404,
        text: async () => "not found",
      })),
    );
    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "view") {
        return commandResult({
          exitCode: 1,
          stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
        });
      }

      return commandResult();
    });

    const result = await tegami({ cwd, npm: { client: "npm" } }).publish();

    if (result.state !== "created") {
      throw new Error(`expected created, got ${result.state}`);
    }

    expect(result.packages.map((pkg) => ({ name: pkg.name, state: pkg.state }))).toEqual(
      expect.arrayContaining([
        { name: "@acme/js", state: "success" },
        { name: "acme_core", state: "success" },
        { name: "acme_binding", state: "success" },
      ]),
    );
    expect(result.packages).toHaveLength(3);
    expect(
      exec.mock.calls.map(([command, args, options]) => ({
        command,
        args,
        cwd: normalizeDirPath(String(options?.nodeOptions?.cwd)),
      })),
    ).toEqual([
      {
        command: "npm",
        args: ["view", "@acme/js@1.1.0", "version", "--json"],
        cwd,
      },
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
      .then((draft) => draft.applyPlan());

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
