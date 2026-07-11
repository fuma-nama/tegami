import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tegami } from "tegami";
import { gem, isGemVersionPublished, type GemPackage } from "../src/index";
import {
  formatRequirement,
  parseRequirement,
  pessimisticBounds,
  rewriteRequirement,
  satisfiesRequirement,
} from "../src/requirement";

const tempDirs: string[] = [];
const fetchMock = vi.fn<typeof fetch>();

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gem plugin discovery", () => {
  test("discovers gems with literal and constant versions", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const graph = (await tegami({ cwd, plugins: [gem()] })._internal.context()).graph;
    const packages = graph
      .getPackages()
      .filter((pkg) => pkg.manager === "gem")
      .map((pkg) => ({ id: pkg.id, name: pkg.name, version: pkg.version }))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(packages).toEqual([
      { id: "gem:api", name: "api", version: "1.0.0" },
      { id: "gem:cli", name: "cli", version: "1.0.0" },
      { id: "gem:core", name: "core", version: "1.0.0" },
      { id: "gem:tools", name: "tools", version: "1.0.0" },
    ]);
  });
});

describe("gem plugin versioning", () => {
  test("bumps dependents, rewrites pessimistic constraints only when needed", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "gem:core", "major");

    await tegami({ cwd, plugins: [gem()] })
      .draft()
      .then((draft) => draft.apply());

    const core = await readFile(join(cwd, "packages/core/core.gemspec"), "utf8");
    const apiSpec = await readFile(join(cwd, "packages/api/api.gemspec"), "utf8");
    const apiVersion = await readFile(join(cwd, "packages/api/lib/api/version.rb"), "utf8");
    const cli = await readFile(join(cwd, "packages/cli/cli.gemspec"), "utf8");
    const tools = await readFile(join(cwd, "packages/tools/tools.gemspec"), "utf8");

    // core: major-bumped literal, trailing comment preserved byte-for-byte.
    expect(core).toContain('spec.version = "2.0.0" # keep core version');

    // api: runtime dependent patch-bumped in version.rb (with `.freeze` preserved),
    // and its `~> 1.0` constraint rewritten to accept 2.0.0 at the same precision.
    expect(apiVersion).toContain('VERSION = "1.0.1".freeze');
    expect(apiSpec).toContain('spec.add_dependency "core", "~> 2.0"');

    // cli: transitively patch-bumped (depends on api), but its `~> 1.0` on api still
    // accepts 1.0.1 so the constraint is left untouched.
    expect(cli).toContain('spec.version = "1.0.1"');
    expect(cli).toContain('spec.add_runtime_dependency "api", "~> 1.0"');

    // tools: only a development dependency on core, so it is not bumped and its
    // `>= 1.0` constraint (which already accepts 2.0.0) is untouched.
    expect(tools).toContain('spec.version = "1.0.0"');
    expect(tools).toContain('spec.add_development_dependency "core", ">= 1.0"');
  });
});

describe("gem plugin publish preflight", () => {
  test("reports shouldPublish and waits on runtime workspace deps", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const plugin = gem();
    const context = await tegami({ cwd, plugins: [plugin] })._internal.context();

    const core = context.graph.get("gem:core") as GemPackage;
    const api = context.graph.get("gem:api") as GemPackage;

    const corePreflight = plugin.publishPreflight!.call(context, {
      pkg: core,
      plan: undefined as never,
    });
    const apiPreflight = plugin.publishPreflight!.call(context, {
      pkg: api,
      plan: undefined as never,
    });

    expect(corePreflight).toEqual({ shouldPublish: true, wait: [] });
    expect(apiPreflight).toEqual({ shouldPublish: true, wait: ["gem:core"] });
  });
});

describe("gem plugin resolvePlanStatus", () => {
  test("returns pending until the version appears on the registry", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const plugin = gem();
    const context = await tegami({ cwd, plugins: [plugin] })._internal.context();
    const plan = {
      packages: new Map([["gem:core", { preflight: { shouldPublish: true } }]]),
    } as never;

    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));
    const pending = await Promise.all(plugin.resolvePlanStatus!.call(context, { plan }) as never[]);
    expect(pending).toEqual(["pending"]);

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ number: "1.0.0" }, { number: "0.9.0" }]), { status: 200 }),
    );
    const published = await Promise.all(
      plugin.resolvePlanStatus!.call(context, { plan }) as never[],
    );
    expect(published).toEqual([undefined]);
  });

  test("isGemVersionPublished validates the RubyGems response", async () => {
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));
    await expect(isGemVersionPublished("core", "1.0.0")).resolves.toBe(false);

    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify([{ number: "1.0.0" }]), { status: 200 }),
    );
    await expect(isGemVersionPublished("core", "1.0.0")).resolves.toBe(true);
    await expect(isGemVersionPublished("core", "1.0.1")).resolves.toBe(false);
  });
});

describe("ruby requirement semantics", () => {
  test("parses operators and bare versions", () => {
    expect(parseRequirement("~> 1.2.3")).toEqual({
      operator: "~>",
      version: "1.2.3",
      bare: false,
    });
    expect(parseRequirement(">= 1.0")).toEqual({ operator: ">=", version: "1.0", bare: false });
    expect(parseRequirement("1.2.3")).toEqual({ operator: "=", version: "1.2.3", bare: true });
    expect(parseRequirement("ruby")).toBeUndefined();
  });

  test("computes pessimistic bounds", () => {
    expect(pessimisticBounds("1.0")).toEqual({ lower: "1.0", upper: "2" });
    expect(pessimisticBounds("1.2.3")).toEqual({ lower: "1.2.3", upper: "1.3" });
    expect(pessimisticBounds("1")).toEqual({ lower: "1", upper: "2" });
  });

  test("checks pessimistic satisfaction", () => {
    const twoSegment = parseRequirement("~> 1.0")!;
    expect(satisfiesRequirement("1.5.0", twoSegment)).toBe(true);
    expect(satisfiesRequirement("1.9.9", twoSegment)).toBe(true);
    expect(satisfiesRequirement("2.0.0", twoSegment)).toBe(false);
    expect(satisfiesRequirement("0.9.0", twoSegment)).toBe(false);

    const threeSegment = parseRequirement("~> 1.2.3")!;
    expect(satisfiesRequirement("1.2.3", threeSegment)).toBe(true);
    expect(satisfiesRequirement("1.2.9", threeSegment)).toBe(true);
    expect(satisfiesRequirement("1.3.0", threeSegment)).toBe(false);
    expect(satisfiesRequirement("1.2.2", threeSegment)).toBe(false);
  });

  test("checks other operators", () => {
    expect(satisfiesRequirement("2.0.0", parseRequirement(">= 1.0")!)).toBe(true);
    expect(satisfiesRequirement("0.9.0", parseRequirement(">= 1.0")!)).toBe(false);
    expect(satisfiesRequirement("1.0.0", parseRequirement("< 2.0")!)).toBe(true);
    expect(satisfiesRequirement("2.0.0", parseRequirement("< 2.0")!)).toBe(false);
    expect(satisfiesRequirement("1.2.3", parseRequirement("1.2.3")!)).toBe(true);
  });

  test("rewrites constraints preserving operator and precision", () => {
    expect(formatRequirement(rewriteRequirement(parseRequirement("~> 1.0")!, "2.0.0"))).toBe(
      "~> 2.0",
    );
    expect(formatRequirement(rewriteRequirement(parseRequirement("~> 1.2.3")!, "2.0.0"))).toBe(
      "~> 2.0.0",
    );
    expect(formatRequirement(rewriteRequirement(parseRequirement("= 1.2.3")!, "2.0.0"))).toBe(
      "= 2.0.0",
    );
    expect(formatRequirement(rewriteRequirement(parseRequirement("1.2.3")!, "2.0.0"))).toBe(
      "2.0.0",
    );
    expect(formatRequirement(rewriteRequirement(parseRequirement("< 2.0")!, "2.0.0"))).toBe(
      "< 2.1",
    );
  });

  test("never truncates prerelease versions", () => {
    // prerelease identifiers contain dots — truncation would mangle them
    expect(formatRequirement(rewriteRequirement(parseRequirement("~> 1.0")!, "1.1.0-alpha.0"))).toBe(
      "~> 1.1.0-alpha.0",
    );
    expect(formatRequirement(rewriteRequirement(parseRequirement("= 1.0.0")!, "2.0.0-rc.1"))).toBe(
      "= 2.0.0-rc.1",
    );
    // exclusive bounds only need the numeric core
    expect(formatRequirement(rewriteRequirement(parseRequirement("< 1.1")!, "1.1.0-alpha.0"))).toBe(
      "< 1.1.1",
    );
    // prerelease comparisons are not silently coerced to their release version
    expect(satisfiesRequirement("1.1.0-alpha.0", parseRequirement("~> 1.1.0")!)).toBe(false);
    expect(satisfiesRequirement("1.1.0-alpha.0", parseRequirement(">= 1.1.0-alpha.0")!)).toBe(true);
  });
});

async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-gem-"));
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await mkdir(join(cwd, "packages/api/lib/api"), { recursive: true });
  await mkdir(join(cwd, "packages/cli"), { recursive: true });
  await mkdir(join(cwd, "packages/tools"), { recursive: true });

  await writeFile(
    join(cwd, "packages/core/core.gemspec"),
    `# frozen_string_literal: true

Gem::Specification.new do |spec|
  spec.name = "core"
  spec.version = "1.0.0" # keep core version
  spec.summary = "Core library"
end
`,
  );

  await writeFile(
    join(cwd, "packages/api/lib/api/version.rb"),
    `module Api
  VERSION = "1.0.0".freeze
end
`,
  );
  await writeFile(
    join(cwd, "packages/api/api.gemspec"),
    `require_relative "lib/api/version"

Gem::Specification.new do |spec|
  spec.name = "api"
  spec.version = Api::VERSION
  spec.add_dependency "core", "~> 1.0"
end
`,
  );

  await writeFile(
    join(cwd, "packages/cli/cli.gemspec"),
    `Gem::Specification.new do |spec|
  spec.name = "cli"
  spec.version = "1.0.0"
  spec.add_runtime_dependency "api", "~> 1.0"
end
`,
  );

  await writeFile(
    join(cwd, "packages/tools/tools.gemspec"),
    `Gem::Specification.new do |spec|
  spec.name = "tools"
  spec.version = "1.0.0"
  spec.add_development_dependency "core", ">= 1.0"
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
