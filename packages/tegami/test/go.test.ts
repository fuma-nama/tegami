import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { git } from "../src/plugins/git";
import { parsePublishLock } from "../src/plans/lock";
import { go } from "../src/plugins/go";
import { getPendingPackageIds } from "./helpers/draft";
import { fetchMock, installRegistryFetchMock, mockRegistryMissing } from "./helpers/registry-fetch";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const tempDirs: string[] = [];
const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockReset();
  installRegistryFetchMock();
  mockRegistryMissing();
  exec.mockImplementation((command, args = [], options) => mockGoExec(command, args, options));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("go packages", () => {
  test("skips go work sync and go mod tidy on npm-only workspaces", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-go-inactive-"));
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

    await tegami({ cwd, plugins: [git(), go()] })
      .draft()
      .then((draft) => draft.apply());

    expect(
      exec.mock.calls.some(
        ([command, args]) =>
          command === "go" &&
          ((args?.[0] === "work" && args?.[1] === "sync") ||
            (args?.[0] === "mod" && args?.[1] === "tidy")),
      ),
    ).toBe(false);
  });

  test("requires the git plugin when go modules are present", async () => {
    const cwd = await createRootModuleWorkspace();
    tempDirs.push(cwd);

    await expect(tegami({ cwd, plugins: [go()] })._internal.context()).rejects.toThrow(
      /requires the git plugin/,
    );
  });

  test("resolves go modules from go.work", async () => {
    const cwd = await createGoWorkspace();
    tempDirs.push(cwd);

    const graph = await tegami({ cwd, plugins: [git(), go()] })._internal.graph();
    const packages = graph.getPackages().map((pkg) => ({
      manager: pkg.manager,
      name: pkg.name,
      version: pkg.version,
    }));

    expect(packages).toEqual(
      expect.arrayContaining([
        {
          manager: "go",
          name: "example.com/acme/core",
          version: "1.0.0",
        },
        {
          manager: "go",
          name: "example.com/acme/api",
          version: "1.0.0",
        },
      ]),
    );
  });

  test("reads module versions from git tags", async () => {
    const cwd = await createGoWorkspace();
    tempDirs.push(cwd);

    exec.mockImplementation((command, args = [], options) => {
      if (command === "git" && args[0] === "tag" && args[1] === "--list") {
        const pattern = args[2];
        if (pattern === "v*") {
          return commandResult({ stdout: "v2.0.0\n" });
        }
        if (pattern === "pkg/api/v*") {
          return commandResult({ stdout: "pkg/api/v3.1.0\n" });
        }
      }

      return mockGoExec(command, args, options);
    });

    const graph = await tegami({ cwd, plugins: [git(), go()] })._internal.graph();
    const packages = Object.fromEntries(graph.getPackages().map((pkg) => [pkg.name, pkg.version]));

    expect(packages).toEqual({
      "example.com/acme/core": "2.0.0",
      "example.com/acme/api": "3.1.0",
    });
  });

  test("writes go publish lock entries and updates require directives", async () => {
    const cwd = await createGoWorkspace();
    tempDirs.push(cwd);

    const paper = tegami({ cwd, plugins: [git(), go()] });
    const draft = await paper.draft();
    await draft.apply();

    const coreMod = await readFile(join(cwd, "go.mod"), "utf8");
    const lock = parsePublishLock(await readFile(join(cwd, ".tegami/publish-lock.yaml"), "utf8"));

    expect(coreMod).toContain("module example.com/acme/core");
    expect(
      exec.mock.calls.some(
        ([command, args]) =>
          command === "go" &&
          args?.[0] === "mod" &&
          args?.[1] === "edit" &&
          args?.includes("-require=example.com/acme/core@v1.1.0"),
      ),
    ).toBe(true);
    expect(getPendingPackageIds(draft, (await paper._internal.context()).graph).sort()).toEqual([
      "go:example.com/acme/api",
      "go:example.com/acme/core",
    ]);

    const goVersions: Array<{ id: string; version: string }> = [];
    let entry: unknown;
    while ((entry = lock.read("go:packages"))) {
      goVersions.push(entry as { id: string; version: string });
    }

    expect(goVersions.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "go:example.com/acme/api", version: "1.0.1" },
      { id: "go:example.com/acme/core", version: "1.1.0" },
    ]);
  });

  test("runs go work sync after versioning", async () => {
    const cwd = await createGoWorkspace();
    tempDirs.push(cwd);

    const paper = tegami({ cwd, plugins: [git(), go()] });
    const draft = await paper.draft();
    await draft.apply();

    const context = await paper._internal.context();
    for (const plugin of context.plugins) {
      await plugin.cli?.draftApplied?.call(context, draft);
    }

    expect(
      exec.mock.calls.some(
        ([command, args, options]) =>
          command === "go" &&
          args?.[0] === "work" &&
          args?.[1] === "sync" &&
          normalizeDirPath(String(options?.nodeOptions?.cwd)) === normalizeDirPath(cwd),
      ),
    ).toBe(true);
    expect(
      exec.mock.calls.some(
        ([command, args]) => command === "go" && args?.[0] === "mod" && args?.[1] === "tidy",
      ),
    ).toBe(false);
  });

  test("runs go mod tidy for single-module workspaces", async () => {
    const cwd = await createRootModuleWorkspace();
    tempDirs.push(cwd);

    const paper = tegami({ cwd, plugins: [git(), go()] });
    const draft = await paper.draft();
    await draft.apply();

    const context = await paper._internal.context();
    for (const plugin of context.plugins) {
      await plugin.cli?.draftApplied?.call(context, draft);
    }

    expect(
      exec.mock.calls.some(
        ([command, args, options]) =>
          command === "go" &&
          args?.[0] === "mod" &&
          args?.[1] === "tidy" &&
          normalizeDirPath(String(options?.nodeOptions?.cwd)) === normalizeDirPath(cwd),
      ),
    ).toBe(true);
  });

  test("sets Go-style git tags and delegates tagging to the git plugin", async () => {
    const cwd = await createGoWorkspace();
    tempDirs.push(cwd);

    await tegami({ cwd, plugins: [git(), go()] })
      .draft()
      .then((draft) => draft.apply());

    mockRegistryMissing();
    exec.mockImplementation((command, args = [], options) => {
      if (command === "git" && args[0] === "tag" && args[1] === "--list") {
        return commandResult({ stdout: "v1.0.0\npkg/api/v1.0.0\n" });
      }

      if (command === "git" && args[0] === "rev-parse") {
        return commandResult({ exitCode: 1 });
      }

      if (command === "git" && (args[0] === "tag" || args[0] === "push")) {
        return commandResult();
      }

      return mockGoExec(command, args, options);
    });

    const result = await tegami({ cwd, plugins: [git(), go()] }).publish();
    if (result === "skipped") {
      throw new Error("expected publish plan, got skipped");
    }

    expect(result.packages.get("go:example.com/acme/core")?.git?.tag).toBe("v1.1.0");
    expect(result.packages.get("go:example.com/acme/api")?.git?.tag).toBe("pkg/api/v1.0.1");

    const published = [...result.packages.entries()]
      .filter(([, plan]) => plan.publishResult!.type === "published")
      .map(([id]) => id);

    expect(published.sort()).toEqual(["go:example.com/acme/api", "go:example.com/acme/core"]);

    expect(
      exec.mock.calls
        .filter(([command, args]) => command === "git" && args?.[0] === "tag" && args.length === 2)
        .map(([, args]) => args?.[1]),
    ).toEqual(expect.arrayContaining(["v1.1.0", "pkg/api/v1.0.1"]));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.golang.org/example.com%2Facme%2Fcore/@v/v1.1.0.info",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.golang.org/example.com%2Facme%2Fapi/@v/v1.0.1.info",
    );
  });

  test("still creates git tags when the module version is already on the proxy", async () => {
    const cwd = await createRootModuleWorkspace();
    tempDirs.push(cwd);

    await tegami({ cwd, plugins: [git(), go()] })
      .draft()
      .then((draft) => draft.apply());

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("example.com%2Facme%2Fapp/@v/v1.0.1.info")) {
        return new Response(JSON.stringify({ Version: "v1.0.1" }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    });

    exec.mockImplementation((command, args = [], options) => {
      if (command === "git" && args[0] === "tag" && args[1] === "--list") {
        return commandResult({ stdout: "v1.0.0\n" });
      }

      if (command === "git" && args[0] === "rev-parse") {
        return commandResult({ exitCode: 1 });
      }

      return mockGoExec(command, args, options);
    });

    expect(await tegami({ cwd, plugins: [git(), go()] }).publish()).toBe("skipped");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.golang.org/example.com%2Facme%2Fapp/@v/v1.0.1.info",
    );
    expect(
      exec.mock.calls
        .filter(([command, args]) => command === "git" && args?.[0] === "tag" && args.length === 2)
        .map(([, args]) => args?.[1]),
    ).toEqual(["v1.0.1"]);
  });
});

async function createGoWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-go-"));
  await mkdir(join(cwd, "pkg/api"), { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });

  await writeFile(
    join(cwd, "go.work"),
    `go 1.22

use (
    .
    ./pkg/api
)
`,
  );
  await writeFile(
    join(cwd, "go.mod"),
    `module example.com/acme/core

go 1.22
`,
  );
  await writeFile(
    join(cwd, "pkg/api/go.mod"),
    `module example.com/acme/api

go 1.22

require example.com/acme/core v1.0.0

replace example.com/acme/core => ../..
`,
  );
  await writeFile(
    join(cwd, ".tegami/change.md"),
    `---
packages:
  "example.com/acme/core": minor
---

### Core release

Ship the core module.
`,
  );

  return cwd;
}

async function createRootModuleWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-go-root-"));
  await mkdir(join(cwd, ".tegami"), { recursive: true });

  await writeFile(
    join(cwd, "go.mod"),
    `module example.com/acme/app

go 1.22
`,
  );
  await writeFile(
    join(cwd, ".tegami/change.md"),
    `---
packages:
  "example.com/acme/app": patch
---

### App release

Ship the app module.
`,
  );

  return cwd;
}

function mockGoExec(
  command: string,
  args: readonly string[] = [],
  options?: { nodeOptions?: { cwd?: string | URL } },
) {
  if (command === "go" && args[0] === "work" && args[1] === "edit" && args[2] === "-json") {
    const cwd = String(options?.nodeOptions?.cwd ?? "");
    if (
      !cwd.includes("tegami-go-") ||
      cwd.includes("tegami-go-inactive") ||
      cwd.includes("tegami-go-root")
    ) {
      return commandResult({ exitCode: 1 });
    }

    return commandResult({ stdout: goWorkJsonFor() });
  }

  if (command === "go" && args[0] === "mod" && args[1] === "edit" && args[2] === "-json") {
    const cwd = String(options?.nodeOptions?.cwd ?? "");
    if (cwd.includes("tegami-go-inactive")) {
      return commandResult({ exitCode: 1 });
    }

    return commandResult({ stdout: goModJsonFor(cwd) });
  }

  if (command === "git" && args[0] === "tag" && args[1] === "--list") {
    const pattern = args[2];
    if (pattern === "v*") {
      return commandResult({ stdout: "v1.0.0\n" });
    }
    if (pattern === "pkg/api/v*") {
      return commandResult({ stdout: "pkg/api/v1.0.0\n" });
    }

    return commandResult({ stdout: "" });
  }

  if (command === "go") {
    return commandResult();
  }

  return commandResult();
}

function goWorkJsonFor(): string {
  return JSON.stringify({
    Go: "1.22",
    Use: [{ DiskPath: "." }, { DiskPath: "./pkg/api" }],
  });
}

function goModJsonFor(dir: string): string {
  if (dir.includes("pkg/api")) {
    return JSON.stringify({
      Module: { Path: "example.com/acme/api" },
      Require: [{ Path: "example.com/acme/core", Version: "v1.0.0" }],
      Replace: [{ Old: { Path: "example.com/acme/core" }, New: { Path: "../.." } }],
    });
  }

  if (dir.includes("tegami-go-root")) {
    return JSON.stringify({
      Module: { Path: "example.com/acme/app" },
    });
  }

  return JSON.stringify({
    Module: { Path: "example.com/acme/core" },
  });
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

function normalizeDirPath(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
}
