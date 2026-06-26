import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { git } from "../src/plugins/git";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import type { TegamiContext } from "../src/context";
import { getPendingPackageIds } from "./helpers/draft";
import { publishPlan } from "./helpers/plan";

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

describe("package groups", () => {
  test("registers groups from options and resolves group names in changelogs", async () => {
    const cwd = await createWorkspace({
      changelog: `---
packages: ["group:acme"]
---

## Add shared API

Useful release note.
`,
    });
    tempDirs.push(cwd);

    const paper = tegami({
      cwd,
      groups: {
        acme: {},
      },
      packages: {
        "@acme/core": { group: "acme" },
        "@acme/ui": { group: "acme" },
      },
    });
    const draft = await paper.draft();

    expect(getPendingPackageIds(draft, (await paper._internal.context()).graph).sort()).toEqual([
      "npm:@acme/core",
      "npm:@acme/ui",
    ]);
  });

  test("applies group prerelease to version and keeps distTag separate", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const draft = await tegami({
      cwd,
      groups: {
        acme: {
          prerelease: "alpha",
        },
      },
      packages: {
        "@acme/core": { group: "acme" },
        "@acme/ui": { group: "acme", npm: { distTag: "next" } },
      },
    }).draft();

    expect({
      coreDistTag: draft.getPackageDraft("npm:@acme/core")?.npm?.distTag,
      uiDistTag: draft.getPackageDraft("npm:@acme/ui")?.npm?.distTag,
    }).toEqual({
      coreDistTag: "alpha",
      uiDistTag: "next",
    });

    await draft.apply();

    expect(await readJson(join(cwd, "packages/core/package.json"))).toMatchObject({
      version: "1.1.0-alpha.0",
    });
    expect(await readJson(join(cwd, "packages/ui/package.json"))).toMatchObject({
      version: "1.1.0-alpha.0",
    });
  });

  test("syncs bump types across grouped packages", async () => {
    const cwd = await createWorkspace({
      coreVersion: "1.0.0",
      uiVersion: "1.2.0",
      changelog: `---
packages: ["group:acme"]
---

### Patch change

Patch note.

# Breaking change

Breaking note.
`,
    });
    tempDirs.push(cwd);

    const draft = await tegami({
      cwd,
      groups: {
        acme: {
          syncBump: true,
        },
      },
      packages: {
        "@acme/core": { group: "acme" },
        "@acme/ui": { group: "acme" },
      },
    }).draft();

    expect({
      core: draft.getPackageDraft("npm:@acme/core")?.type,
      ui: draft.getPackageDraft("npm:@acme/ui")?.type,
    }).toEqual({
      core: "major",
      ui: "major",
    });

    await draft.apply();

    expect(await readJson(join(cwd, "packages/core/package.json"))).toMatchObject({
      version: "2.0.0",
    });
    expect(await readJson(join(cwd, "packages/ui/package.json"))).toMatchObject({
      version: "2.0.0",
    });
  });

  test("creates one git tag for syncGitTag groups", async () => {
    const plugin = git();
    const context = createGroupContext({
      groups: {
        acme: { syncGitTag: true },
      },
      packages: {
        "@acme/core": { group: "acme" },
        "@acme/ui": { group: "acme" },
      },
    });
    const core = context.graph.get("test:@acme/core")!;
    const ui = context.graph.get("test:@acme/ui")!;
    const plan = publishPlan(context.graph, {
      packages: [
        { pkg: core, git: { tag: "acme@1.0.1" } },
        { pkg: ui, git: { tag: "acme@1.0.1" } },
      ],
    });

    exec.mockImplementation((_command, args = []) => {
      if (args.at(0) === "rev-parse") {
        return commandResult({ exitCode: 1 });
      }

      if (args.at(0) === "tag") {
        return commandResult();
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    await plugin.afterPublishAll?.call(context, { plan });

    expect(exec.mock.calls.filter(([, args]) => args?.at(0) === "tag")).toHaveLength(1);
  });

  test("clears package group references when members or groups are removed", () => {
    const graph = new PackageGraph([
      workspacePackage("@acme/core", "/repo/packages/core"),
      workspacePackage("@acme/ui", "/repo/packages/ui"),
    ]);
    graph.registerGroup("acme", {});
    graph.registerGroup("next", {});

    graph.addGroupMember("acme", "test:@acme/core");
    graph.removeGroupMember("acme", "test:@acme/core");
    graph.addGroupMember("next", "test:@acme/core");

    expect(graph.getPackageGroup("test:@acme/core")?.name).toBe("next");
    expect(graph.getGroup("acme")?.packages).toEqual([]);

    graph.addGroupMember("next", "test:@acme/ui");
    graph.unregisterGroup("next");

    expect(graph.getGroup("next")).toBeUndefined();
    expect(graph.getPackageGroup("test:@acme/core")).toBeUndefined();
    expect(graph.getPackageGroup("test:@acme/ui")).toBeUndefined();
  });
});

function createGroupContext(options: TegamiContext["options"]): TegamiContext {
  const graph = new PackageGraph([
    workspacePackage("@acme/core", "/repo/packages/core"),
    workspacePackage("@acme/ui", "/repo/packages/ui"),
  ]);

  for (const [name, groupOptions] of Object.entries(options.groups ?? {})) {
    graph.registerGroup(name, groupOptions);
  }

  for (const pkg of graph.getPackages()) {
    const packageOptions = options.packages?.[pkg.id] ?? options.packages?.[pkg.name];
    if (!packageOptions) continue;

    pkg.setPackageOptions(packageOptions);

    if (packageOptions.group) {
      graph.addGroupMember(packageOptions.group, pkg.id);
    }
  }

  return {
    cwd: "/repo",
    changelogDir: "/repo/.tegami",
    lockPath: "/repo/.tegami/publish-lock.yaml",
    options,
    plugins: [],
    graph,
  };
}

async function createWorkspace(
  options: {
    changelog?: string | false;
    coreVersion?: string;
    uiVersion?: string;
  } = {},
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-groups-"));

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
    version: options.coreVersion ?? "1.0.0",
  });
  await writeJson(join(cwd, "packages/ui/package.json"), {
    name: "@acme/ui",
    version: options.uiVersion ?? "1.0.0",
    dependencies: {
      "@acme/core": "^1.0.0",
    },
  });

  if (options.changelog !== false) {
    await writeFile(
      join(cwd, ".tegami/change.md"),
      options.changelog ??
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

function workspacePackage(name: string, path: string): WorkspacePackage {
  return new TestPackage(name, path);
}

class TestPackage extends WorkspacePackage {
  readonly manager = "test";
  readonly version = "1.0.1";
  readonly publish = true;

  constructor(
    readonly name: string,
    readonly path: string,
  ) {
    super();
  }

  setVersion(): void {}

  async updateDependency(): Promise<void> {}

  async write(): Promise<void> {}
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
