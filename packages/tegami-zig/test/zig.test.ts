import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { tegami, type TegamiPlugin } from "tegami";
import { zig } from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("zig plugin", () => {
  test("discovers root and recursive local path dependencies", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const graph = (await tegami({ cwd, plugins: [zig()] })._internal.context()).graph;
    const packages = graph
      .getPackages()
      .filter((pkg) => pkg.manager === "zig")
      .map((pkg) => ({
        id: pkg.id,
        name: pkg.name,
        version: pkg.version,
      }));

    expect(packages).toEqual(
      expect.arrayContaining([
        { id: "zig:root", name: "root", version: "1.0.0" },
        { id: "zig:core-lib", name: "core-lib", version: "1.0.0" },
        { id: "zig:api", name: "api", version: "1.0.0" },
      ]),
    );
  });

  test("bumps local path dependents and rewrites optional version constraints", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "zig:core-lib", "major");

    await tegami({ cwd, plugins: [zig()] })
      .draft()
      .then((draft) => draft.apply());

    const core = await readFile(join(cwd, "packages/core/build.zig.zon"), "utf8");
    const api = await readFile(join(cwd, "packages/api/build.zig.zon"), "utf8");
    const root = await readFile(join(cwd, "build.zig.zon"), "utf8");

    expect(core).toContain('.version = "2.0.0" // package version');
    expect(api).toContain('.version = "1.0.1"');
    expect(api).toContain('.version = "^2.0.0", // local contract');
    expect(root).toContain('.version = "1.0.1"');
    expect(api).toContain("// keep api comment");
  });

  test("supports explicit workspace globs for unreferenced packages", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await mkdir(join(cwd, "tools/bench"), { recursive: true });
    await writeFile(
      join(cwd, "tools/bench/build.zig.zon"),
      `.{
    .name = .bench,
    .version = "0.1.0",
    .paths = .{ "build.zig", "build.zig.zon" },
}
`,
    );

    const graph = (
      await tegami({ cwd, plugins: [zig({ workspace: ["tools/*"] })] })._internal.context()
    ).graph;

    expect(graph.get("zig:bench")?.version).toBe("0.1.0");
  });

  test("handles transitive, cyclic, remote, and missing dependencies in monorepos", async () => {
    const cwd = await createComplexWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "zig:core", "major");

    const graph = (await tegami({ cwd, plugins: [zig()] })._internal.context()).graph;
    expect(
      graph
        .getPackages()
        .filter((pkg) => pkg.manager === "zig")
        .map((pkg) => pkg.id)
        .sort(),
    ).toEqual(["zig:api", "zig:cli", "zig:core", "zig:root"].sort());

    await tegami({ cwd, plugins: [zig()] })
      .draft()
      .then((draft) => draft.apply());

    const root = await readFile(join(cwd, "build.zig.zon"), "utf8");
    const core = await readFile(join(cwd, "packages/core/build.zig.zon"), "utf8");
    const api = await readFile(join(cwd, "packages/api/build.zig.zon"), "utf8");
    const cli = await readFile(join(cwd, "apps/cli/build.zig.zon"), "utf8");

    expect(root).toContain('.version = "1.0.1"');
    expect(root).toContain('.url = "https://example.com/remote.tar.gz"');
    expect(core).toContain('.version = "2.0.0"');
    expect(core).toContain('.version = "^1.0.0"');
    expect(api).toContain('.version = "1.0.1"');
    expect(api).toContain('.version = "^2.0.0"');
    expect(cli).toContain('.version = "1.0.1"');
    expect(cli).toContain(`.path = "../../packages/api",
            .version = "1.0.1"`);
  });

  test("throws when a discovered build.zig.zon is invalid", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-zig-invalid-"));
    tempDirs.push(cwd);
    await writeFile(
      join(cwd, "build.zig.zon"),
      `.{ .name = .root .version = "1.0.0" }
`,
    );

    await expect(tegami({ cwd, plugins: [zig()] })._internal.context()).rejects.toThrow(
      /Expected ","/,
    );
  });

  test("marks Zig packages as not publishable", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "zig:core-lib", "patch");
    await tegami({ cwd, plugins: [zig()] })
      .draft()
      .then((draft) => draft.apply());

    await expect(tegami({ cwd, plugins: [zig()] }).publish()).resolves.toBe("skipped");
  });

  test("publishes through Tegami git tags when publish is git-tag", async () => {
    const cwd = await createSinglePackage();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "zig:single", "patch");
    await tegami({ cwd, plugins: [zig()] })
      .draft()
      .then((draft) => draft.apply());

    const result = await tegami({
      cwd,
      plugins: [zig({ publish: "git-tag" }), pendingTagPlugin()],
    }).publish();

    expect(result).not.toBe("skipped");
    if (result === "skipped") return;

    const plan = result.packages.get("zig:single");
    expect(plan?.git?.tag).toBe("single@1.0.1");
    expect(plan?.publishResult).toEqual({ type: "published" });
  });

  test("fails git-tag publishing when no tag provider is configured", async () => {
    const cwd = await createSinglePackage();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "zig:single", "patch");
    await tegami({ cwd, plugins: [zig()] })
      .draft()
      .then((draft) => draft.apply());

    const result = await tegami({
      cwd,
      plugins: [zig({ publish: "git-tag" })],
    }).publish();

    expect(result).not.toBe("skipped");
    if (result === "skipped") return;

    expect(result.packages.get("zig:single")?.publishResult).toEqual({
      type: "failed",
      error:
        "Zig git-tag publishing requires the git, github, or gitlab plugin to provide a release tag.",
    });
  });

  test("publishes with custom application logic", async () => {
    const cwd = await createSinglePackage();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "zig:single", "minor");
    await tegami({ cwd, plugins: [zig()] })
      .draft()
      .then((draft) => draft.apply());
    const publish = vi.fn(() => ({ type: "published" as const }));

    const result = await tegami({
      cwd,
      plugins: [
        zig({
          publish: {
            type: "custom",
            publish,
          },
        }),
      ],
    }).publish();

    expect(result).not.toBe("skipped");
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        pkg: expect.objectContaining({
          name: "single",
          path: cwd,
          version: "1.1.0",
        }),
      }),
    );
    if (result === "skipped") return;

    expect(result.packages.get("zig:single")?.publishResult).toEqual({ type: "published" });
  });
});

function pendingTagPlugin(): TegamiPlugin {
  return {
    name: "test-release-tags",
    initPublishPlan({ plan }) {
      for (const [id, packagePlan] of plan.packages) {
        const pkg = this.graph.get(id);
        if (!pkg?.version) continue;
        packagePlan.git ??= {};
        packagePlan.git.tag ??= `${pkg.name}@${pkg.version}`;
      }
    },
    resolvePlanStatus() {
      return "pending";
    },
  };
}

async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-zig-"));
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await mkdir(join(cwd, "packages/api"), { recursive: true });

  await writeFile(
    join(cwd, "build.zig.zon"),
    `.{
    .name = .root,
    .version = "1.0.0",
    .dependencies = .{
        .@"core-lib" = .{
            .path = "packages/core",
        },
        .api = .{
            .path = "packages/api",
        },
    },
    .paths = .{ "build.zig", "build.zig.zon" },
}
`,
  );
  await writeFile(
    join(cwd, "packages/core/build.zig.zon"),
    `.{
    .name = .@"core-lib",
    .version = "1.0.0" // package version
}
`,
  );
  await writeFile(
    join(cwd, "packages/api/build.zig.zon"),
    `.{
    // keep api comment
    .name = .api,
    .version = "1.0.0",
    .dependencies = .{
        .@"core-lib" = .{
            .path = "../core",
            .version = "^1.0.0", // local contract
        },
    },
}
`,
  );

  return cwd;
}

async function createSinglePackage(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-zig-single-"));
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await writeFile(
    join(cwd, "build.zig.zon"),
    `.{
    .name = .single,
    .version = "1.0.0",
}
`,
  );

  return cwd;
}

async function createComplexWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-zig-complex-"));
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await mkdir(join(cwd, "packages/api"), { recursive: true });
  await mkdir(join(cwd, "apps/cli"), { recursive: true });

  await writeFile(
    join(cwd, "build.zig.zon"),
    `.{
    .name = .root,
    .version = "1.0.0",
    .dependencies = .{
        .cli = .{
            .path = "apps/cli",
        },
        .missing = .{
            .path = "packages/missing",
        },
        .remote = .{
            .url = "https://example.com/remote.tar.gz",
            .hash = "1220000000000000000000000000000000000000000000000000",
        },
    },
}
`,
  );
  await writeFile(
    join(cwd, "packages/core/build.zig.zon"),
    `.{
    .name = .core,
    .version = "1.0.0",
    .dependencies = .{
        .cli = .{
            .path = "../../apps/cli",
            .version = "^1.0.0",
        },
    },
}
`,
  );
  await writeFile(
    join(cwd, "packages/api/build.zig.zon"),
    `.{
    .name = .api,
    .version = "1.0.0",
    .dependencies = .{
        .core = .{
            .path = "../core",
            .version = "^1.0.0",
        },
    },
}
`,
  );
  await writeFile(
    join(cwd, "apps/cli/build.zig.zon"),
    `.{
    .name = .cli,
    .version = "1.0.0",
    .dependencies = .{
        .api = .{
            .path = "../../packages/api",
            .version = "1.0.0",
        },
    },
}
`,
  );

  return cwd;
}

async function writeChangelog(cwd: string, pkg: string, type: string): Promise<void> {
  await writeFile(
    join(cwd, ".tegami/change.md"),
    `---
packages:
  "${pkg}": ${type}
---

### Update ${pkg}

Release ${pkg}.
`,
  );
}
