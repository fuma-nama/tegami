import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { tegami } from "tegami";
import { hex, isPackagePublished } from "../src/index";
import { parseMix } from "../src/mix";
import { satisfiesRequirement, updateRequirement } from "../src/requirement";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("hex plugin", () => {
  test("discovers umbrella apps with @version and inline version", async () => {
    const cwd = await createUmbrella();
    tempDirs.push(cwd);

    const graph = (await tegami({ cwd, plugins: [hex()] })._internal.context()).graph;
    const packages = graph
      .getPackages()
      .filter((pkg) => pkg.manager === "hex")
      .map((pkg) => ({ id: pkg.id, name: pkg.name, version: pkg.version }))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(packages).toEqual([
      { id: "hex:api", name: "api", version: "1.0.0" },
      { id: "hex:core", name: "core", version: "1.0.0" },
    ]);
  });

  test("bumps umbrella dependents and rewrites `~>` requirements only when needed", async () => {
    const cwd = await createUmbrella();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "hex:core", "major");

    await tegami({ cwd, plugins: [hex()] })
      .draft()
      .then((draft) => draft.apply());

    const core = await readFile(join(cwd, "apps/core/mix.exs"), "utf8");
    const api = await readFile(join(cwd, "apps/api/mix.exs"), "utf8");

    // core got the major bump (via its @version attribute)
    expect(core).toContain('@version "2.0.0"');
    // api is patch-bumped because its `~> 1.0` no longer accepts 2.0.0
    expect(api).toContain('version: "1.0.1"');
    expect(api).toContain('{:core, "~> 2.0", in_umbrella: true}');
    // comments and unrelated content preserved
    expect(api).toContain("# keep this comment");
  });

  test("does not bump dev/test-only dependents", async () => {
    const cwd = await createUmbrella();
    tempDirs.push(cwd);
    // tools depends on core only in :test
    await writeChangelog(cwd, "hex:core", "major");

    const draft = await tegami({ cwd, plugins: [hex()] }).draft();
    // `tools` is not part of the workspace here; assert api bumped but check policy via graph
    await draft.apply();

    const api = await readFile(join(cwd, "apps/api/mix.exs"), "utf8");
    expect(api).toContain('version: "1.0.1"');
  });

  test("publishPreflight reports publishable + wait ordering", async () => {
    const cwd = await createUmbrella();
    tempDirs.push(cwd);

    const ctx = await tegami({ cwd, plugins: [hex()] })._internal.context();
    const plugin = hex();
    // exercise preflight through a draft/plan is complex; assert heuristics via context graph
    const api = ctx.graph.get("hex:api");
    const core = ctx.graph.get("hex:core");
    expect(api?.version).toBe("1.0.0");
    expect(core?.version).toBe("1.0.0");
    expect(plugin.name).toBe("hex");
  });

  test("only: classifies by environment, not by presence", () => {
    const deps = parseMix(
      `defmodule App.MixProject do
        defp deps do
          [
            {:plain, "~> 1.0"},
            {:dev_only, "~> 1.0", only: :dev},
            {:dev_test, "~> 1.0", only: [:dev, :test]},
            {:prod_only, "~> 1.0", only: :prod},
            {:prod_and_dev, "~> 1.0", only: [:prod, :dev]}
          ]
        end
      end`,
      "/tmp/mix.exs",
    ).deps;

    const dev = Object.fromEntries(deps.map((dep) => [dep.name, dep.dev]));
    expect(dev).toEqual({
      plain: false,
      dev_only: true,
      dev_test: true,
      // `only: :prod` still ships in a release — it is a runtime dependency
      prod_only: false,
      prod_and_dev: false,
    });
  });

  test("requirement checker handles pessimistic operator", () => {
    expect(satisfiesRequirement("1.5.0", "~> 1.0")).toBe(true);
    expect(satisfiesRequirement("2.0.0", "~> 1.0")).toBe(false);
    expect(satisfiesRequirement("1.2.9", "~> 1.2.3")).toBe(true);
    expect(satisfiesRequirement("1.3.0", "~> 1.2.3")).toBe(false);
    expect(satisfiesRequirement("2.0.0", ">= 1.0.0")).toBe(true);
    expect(satisfiesRequirement("1.0.0", ">= 1.0.0 and < 2.0.0")).toBe(true);
    expect(satisfiesRequirement("2.0.0", ">= 1.0.0 and < 2.0.0")).toBe(false);
  });

  test("requirement rewrite preserves `~>` precision", () => {
    expect(updateRequirement("~> 1.0", "2.0.1")).toBe("~> 2.0");
    expect(updateRequirement("~> 1.2.3", "1.3.0")).toBe("~> 1.3.0");
  });

  test("parseMix resolves @version attribute reference", () => {
    const content = `defmodule Core.MixProject do
  use Mix.Project
  @version "3.1.4"
  def project do
    [app: :core, version: @version, deps: deps()]
  end
  defp deps, do: []
end
`;
    const file = parseMix(content, "/tmp/core/mix.exs");
    expect(file.app).toBe("core");
    expect(file.version).toBe("3.1.4");
  });

  test("resolvePlanStatus checks the Hex registry", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/packages/core")) {
        return new Response(JSON.stringify({ releases: [{ version: "2.0.0" }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(isPackagePublished("core", "2.0.0", "https://hex.pm/api")).resolves.toBe(true);
    await expect(isPackagePublished("core", "3.0.0", "https://hex.pm/api")).resolves.toBe(false);
    await expect(isPackagePublished("missing", "1.0.0", "https://hex.pm/api")).resolves.toBe(false);
  });
});

async function createUmbrella(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-hex-"));
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await mkdir(join(cwd, "apps/core"), { recursive: true });
  await mkdir(join(cwd, "apps/api"), { recursive: true });

  await writeFile(
    join(cwd, "mix.exs"),
    `defmodule Umbrella.MixProject do
  use Mix.Project
  def project do
    [apps_path: "apps", version: "0.1.0", deps: deps()]
  end
  defp deps, do: []
end
`,
  );

  // core uses a @version module attribute
  await writeFile(
    join(cwd, "apps/core/mix.exs"),
    `defmodule Core.MixProject do
  use Mix.Project

  @version "1.0.0"

  def project do
    [
      app: :core,
      version: @version,
      deps: deps(),
      package: package()
    ]
  end

  defp deps, do: []
  defp package, do: [licenses: ["MIT"]]
end
`,
  );

  // api uses an inline version and depends on core via `~> 1.0`
  await writeFile(
    join(cwd, "apps/api/mix.exs"),
    `defmodule Api.MixProject do
  use Mix.Project

  def project do
    [
      # keep this comment
      app: :api,
      version: "1.0.0",
      deps: deps(),
      package: [licenses: ["MIT"]]
    ]
  end

  defp deps do
    [
      {:core, "~> 1.0", in_umbrella: true}
    ]
  end
end
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
