import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { x } from "tinyexec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "tegami";
import { dart, isPackagePublished, updateConstraintRange } from "../src/index";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const tempDirs: string[] = [];
const exec = vi.mocked(x);
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  exec.mockReset();
  exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as Awaited<ReturnType<typeof x>>);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Dart pub helpers", () => {
  test("updates the lower bound of Dart version constraints", () => {
    expect(updateConstraintRange("^1.0.0", "2.0.0")).toBe("^2.0.0");
    expect(updateConstraintRange(">=1.0.0 <2.0.0", "2.0.0")).toBe(">=2.0.0 <2.0.0");
    expect(updateConstraintRange("1.0.0", "2.0.0")).toBe("2.0.0");
  });

  test("checks package versions against custom hosted registries", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        versions: [{ version: "1.0.0" }, { version: "1.0.1" }],
      }),
    );

    await expect(isPackagePublished("core", "1.0.1", "https://pub.example.com/")).resolves.toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pub.example.com/api/packages/core",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.pub.v2+json",
        }),
      }),
    );
  });
});

describe("dart plugin", () => {
  test("ignores non-workspace Dart pubspecs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-dart-inactive-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, "packages/core"), { recursive: true });

    await writeFile(
      join(cwd, "pubspec.yaml"),
      `name: root
version: 1.0.0
`,
    );
    await writeFile(
      join(cwd, "packages/core/pubspec.yaml"),
      `name: core
version: 1.0.0
`,
    );

    const graph = (await tegami({ cwd, plugins: [dart()] })._internal.context()).graph;
    expect(graph.getPackages().filter((pkg) => pkg.manager === "dart")).toHaveLength(0);
  });

  test("bumps workspace dependents and rewrites pubspec constraints", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "core", "major");

    const paper = tegami({ cwd, plugins: [dart()] });
    const draft = await paper.draft();
    await draft.apply();

    const core = await readPubspec(join(cwd, "packages/core"));
    const api = await readPubspec(join(cwd, "packages/api"));
    const tool = await readPubspec(join(cwd, "packages/tool"));
    const example = await readPubspec(join(cwd, "packages/example"));

    expect(core.version).toBe("2.0.0");
    expect(api.version).toBe("1.0.1");
    expect(tool.version).toBe("1.0.1");
    expect(example.version).toBe("1.0.0");
    expect((api.dependencies as Record<string, string>).core).toBe("^2.0.0");
    expect((tool.dependency_overrides as Record<string, string>).core).toBe("^2.0.0");

    const context = await paper._internal.context();
    const plugin = context.plugins.find((plugin) => plugin.name === "dart");
    await plugin?.applyCliDraft?.call(context, draft);
    expect(exec).toHaveBeenCalledWith("dart", ["pub", "get"], {
      nodeOptions: { cwd },
    });
  });

  test("publishes with dart pub publish --force in CI and skips publish_to none", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "core", "patch");
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));
    vi.stubEnv("CI", "true");

    await tegami({ cwd, plugins: [dart()] })
      .draft()
      .then((draft) => draft.apply());
    exec.mockClear();

    const result = await tegami({ cwd, plugins: [dart()] }).publish();

    expect(result).not.toBe("skipped");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pub.example.com/api/packages/core",
      expect.anything(),
    );
    expect(exec).toHaveBeenCalledWith("dart", ["pub", "publish", "--force"], {
      nodeOptions: { cwd: join(cwd, "packages/core") },
    });
    expect(
      exec.mock.calls.some(
        ([command, , options]) =>
          command === "dart" && options?.nodeOptions?.cwd === join(cwd, "packages/private"),
      ),
    ).toBe(false);
  });
});

async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-dart-"));
  await mkdir(join(cwd, ".tegami"), { recursive: true });

  for (const name of ["core", "api", "tool", "example", "private"]) {
    await mkdir(join(cwd, `packages/${name}`), { recursive: true });
  }

  await writeFile(
    join(cwd, "pubspec.yaml"),
    `name: _
publish_to: none
environment:
  sdk: ^3.6.0
workspace:
  - packages/*
`,
  );
  await writeFile(
    join(cwd, "packages/core/pubspec.yaml"),
    `name: core
version: 1.0.0
publish_to: https://pub.example.com/
resolution: workspace
environment:
  sdk: ^3.6.0
`,
  );
  await writeFile(
    join(cwd, "packages/api/pubspec.yaml"),
    `name: api
version: 1.0.0
resolution: workspace
environment:
  sdk: ^3.6.0
dependencies:
  core: ^1.0.0
`,
  );
  await writeFile(
    join(cwd, "packages/tool/pubspec.yaml"),
    `name: tool
version: 1.0.0
resolution: workspace
environment:
  sdk: ^3.6.0
dependency_overrides:
  core: ^1.0.0
`,
  );
  await writeFile(
    join(cwd, "packages/example/pubspec.yaml"),
    `name: example
version: 1.0.0
resolution: workspace
environment:
  sdk: ^3.6.0
dev_dependencies:
  core: ^1.0.0
`,
  );
  await writeFile(
    join(cwd, "packages/private/pubspec.yaml"),
    `name: private
version: 1.0.0
publish_to: none
resolution: workspace
environment:
  sdk: ^3.6.0
`,
  );

  return cwd;
}

async function writeChangelog(cwd: string, pkg: string, type: string): Promise<void> {
  await writeFile(
    join(cwd, ".tegami/change.md"),
    `---
packages:
  ${pkg}: ${type}
---

### Update ${pkg}

Release ${pkg}.
`,
  );
}

async function readPubspec(dir: string): Promise<Record<string, unknown>> {
  return load(await readFile(join(dir, "pubspec.yaml"), "utf8")) as Record<string, unknown>;
}
