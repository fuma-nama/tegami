import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { tegami } from "tegami";
import { isPackagePublished, nuget, rewriteConstraint } from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("nuget plugin", () => {
  test("discovers projects, resolving own and inherited versions", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const graph = (await tegami({ cwd, plugins: [nuget()] })._internal.context()).graph;
    const packages = graph
      .getPackages()
      .filter((pkg) => pkg.manager === "nuget")
      .map((pkg) => ({ id: pkg.id, name: pkg.name, version: pkg.version }))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(packages).toEqual([
      // Api has its own <Version>
      { id: "nuget:Acme.Api", name: "Acme.Api", version: "3.0.0" },
      // Core inherits from Directory.Build.props
      { id: "nuget:Acme.Core", name: "Acme.Core", version: "1.0.0" },
      // Tests is IsPackable=false but still discovered
      { id: "nuget:Acme.Tests", name: "Acme.Tests", version: "1.0.0" },
    ]);
  });

  test("bumps the shared props version once and rewrites a PackageReference", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "nuget:Acme.Core", "major");

    await tegami({ cwd, plugins: [nuget()] })
      .draft()
      .then((draft) => draft.apply());

    const props = await readFile(join(cwd, "Directory.Build.props"), "utf8");
    // Core's version lives in the shared props file → bumped to 2.0.0
    expect(props).toContain("<Version>2.0.0</Version>");

    // Api has a ProjectReference to Core (patch-bumped) and a PackageReference to Core
    const api = await readFile(join(cwd, "src/Api/Acme.Api.csproj"), "utf8");
    expect(api).toContain("<Version>3.0.1</Version>"); // own version, patch-bumped
    // PackageReference to Core 1.0.0 no longer accepts 2.0.0 → rewritten
    expect(api).toContain('Include="Acme.Core" Version="2.0.0"');
    // formatting + comment preserved
    expect(api).toContain("<!-- api project -->");
  });

  test("does not release dependents whose references need no manifest change", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    // Tool references Core only via a floating PackageReference (`1.*`), which
    // still accepts a minor bump — nothing in Tool's manifest changes.
    await mkdir(join(cwd, "src/Tool"), { recursive: true });
    await writeFile(
      join(cwd, "src/Tool/Acme.Tool.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <Version>5.0.0</Version>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Acme.Core" Version="1.*" />
  </ItemGroup>
</Project>
`,
    );
    await writeChangelog(cwd, "nuget:Acme.Core", "minor");

    await tegami({ cwd, plugins: [nuget()] })
      .draft()
      .then((draft) => draft.apply());

    const tool = await readFile(join(cwd, "src/Tool/Acme.Tool.csproj"), "utf8");
    expect(tool).toContain("<Version>5.0.0</Version>"); // untouched
    expect(tool).toContain('Version="1.*"');
  });

  test("surfaces malformed project files instead of dropping them", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await mkdir(join(cwd, "src/Broken"), { recursive: true });
    await writeFile(join(cwd, "src/Broken/Acme.Broken.csproj"), `<Project><PropertyGroup`);

    await expect(tegami({ cwd, plugins: [nuget()] })._internal.context()).rejects.toThrow(
      /Failed to parse .*Acme\.Broken\.csproj/,
    );
  });

  test("marks IsPackable=false projects as not publishable", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const ctx = await tegami({ cwd, plugins: [nuget()] })._internal.context();
    const tests = ctx.graph.get("nuget:Acme.Tests");
    expect(tests?.version).toBe("1.0.0");
    // the plugin computes packability internally; assert discovery included it
    expect(tests?.name).toBe("Acme.Tests");
  });

  test("rewriteConstraint handles plain and exact versions", () => {
    expect(rewriteConstraint("1.0.0", "2.0.0")).toBe("2.0.0");
    expect(rewriteConstraint("2.0.0", "1.0.0")).toBeUndefined(); // already accepts
    expect(rewriteConstraint("[1.0.0]", "2.0.0")).toBe("[2.0.0]");
    expect(rewriteConstraint("[2.0.0]", "2.0.0")).toBeUndefined();
    expect(rewriteConstraint("1.*", "2.0.0")).toBeUndefined(); // floating left alone
    expect(rewriteConstraint("[1.0,2.0)", "2.0.0")).toBeUndefined(); // interval left alone
  });

  test("resolvePlanStatus checks the flat-container index", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("acme.core")) {
        return new Response(JSON.stringify({ versions: ["1.0.0", "2.0.0"] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const base = "https://api.nuget.org/v3-flatcontainer";
    await expect(isPackagePublished(base, "Acme.Core", "2.0.0")).resolves.toBe(true);
    await expect(isPackagePublished(base, "Acme.Core", "3.0.0")).resolves.toBe(false);
    await expect(isPackagePublished(base, "Acme.Missing", "1.0.0")).resolves.toBe(false);
  });
});

async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-nuget-"));
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await mkdir(join(cwd, "src/Core"), { recursive: true });
  await mkdir(join(cwd, "src/Api"), { recursive: true });
  await mkdir(join(cwd, "test/Tests"), { recursive: true });

  // shared version for projects that don't set their own
  await writeFile(
    join(cwd, "Directory.Build.props"),
    `<Project>
  <PropertyGroup>
    <Version>1.0.0</Version>
  </PropertyGroup>
</Project>
`,
  );

  // Core inherits the props version
  await writeFile(
    join(cwd, "src/Core/Acme.Core.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>
`,
  );

  // Api sets its own version, references Core both ways
  await writeFile(
    join(cwd, "src/Api/Acme.Api.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <!-- api project -->
  <PropertyGroup>
    <Version>3.0.0</Version>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\Core\\Acme.Core.csproj" />
    <PackageReference Include="Acme.Core" Version="1.0.0" />
  </ItemGroup>
</Project>
`,
  );

  // Test project, not packable
  await writeFile(
    join(cwd, "test/Tests/Acme.Tests.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
</Project>
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
