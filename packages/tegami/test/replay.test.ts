import { describe, expect, test } from "vitest";
import { generateReplays } from "../src/changelog/generate";
import { parseChangelogFile } from "../src/changelog/parse";
import { renderChangelog } from "../src/changelog/shared";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import type { BumpType } from "../src/utils/semver";
import { bumpVersion } from "../src/utils/semver";

function renderChangelogForTest(
  graph: PackageGraph,
  packageBumpMap: Record<string, BumpType>,
  message: string,
) {
  const packages = generateReplays(graph, packageBumpMap);
  return renderChangelog({ packages }, `## ${message}`);
}

describe("changelog replay", () => {
  test("adds replay when tegami prerelease config produces a prerelease bump", () => {
    const graph = createGraph([
      testPackage("tegami", "1.0.0", { prerelease: "alpha" }),
      testPackage("@acme/core", "1.0.0"),
    ]);

    const entry = parseChangelogFile(
      "change.md",
      renderChangelogForTest(graph, { tegami: "minor", "@acme/core": "minor" }, "Notes"),
    );

    expect(entry?.packages.get("npm:tegami")).toEqual({
      type: "minor",
      replay: ["exit prerelease: tegami"],
    });
    expect(entry?.packages.get("@acme/core")).toEqual({ type: "minor" });
  });

  test("adds replay for packages already on a prerelease line", () => {
    const graph = createGraph([testPackage("tegami", "1.1.0-alpha.2", { prerelease: "alpha" })]);

    const entry = parseChangelogFile(
      "change.md",
      renderChangelogForTest(graph, { tegami: "patch" }, "Notes"),
    );

    expect(entry?.packages.get("npm:tegami")).toEqual({
      type: "patch",
      replay: ["exit prerelease: tegami"],
    });
    expect(bumpVersion("1.1.0-alpha.2", "patch")).toBe("1.1.0");
  });

  test("inherits group prerelease config", () => {
    const graph = createGraph([
      testPackage("@acme/core", "1.0.0", { group: "acme" }),
      testPackage("@acme/ui", "1.0.0", { group: "acme" }),
    ]);
    graph.registerGroup("acme", { prerelease: "alpha" });
    graph.addGroupMember("acme", "npm:@acme/core");
    graph.addGroupMember("acme", "npm:@acme/ui");

    const entry = parseChangelogFile(
      "change.md",
      renderChangelogForTest(graph, { "@acme/core": "minor", "@acme/ui": "minor" }, "Notes"),
    );

    expect(entry?.packages.get("npm:@acme/core")).toEqual({
      type: "minor",
      replay: ["exit prerelease: @acme/core"],
    });
    expect(entry?.packages.get("npm:@acme/ui")).toEqual({
      type: "minor",
      replay: ["exit prerelease: @acme/ui"],
    });
  });

  test("expands groups and adds replay per package", () => {
    const graph = createGraph([testPackage("tegami", "1.0.0", { group: "acme" })]);
    graph.registerGroup("acme", { prerelease: "alpha" });
    graph.addGroupMember("acme", "npm:tegami");

    const content = renderChangelogForTest(
      graph,
      { "group:acme": "minor" },
      "Support replay in changelog files",
    );

    expect(content).toContain("npm:tegami:");
    expect(content).toContain("type: minor");
    expect(content).toContain("replay:");
    expect(content).toContain("exit prerelease: tegami");
    expect(content).toContain("## Support replay in changelog files");
  });
});

function createGraph(packages: TestPackage[]): PackageGraph {
  return new PackageGraph(packages);
}

function testPackage(
  name: string,
  version: string,
  options: { prerelease?: string; group?: string } = {},
): TestPackage {
  return new TestPackage(name, version, options);
}

class TestPackage extends WorkspacePackage {
  readonly manager = "npm";

  constructor(
    readonly name: string,
    readonly version: string,
    options: { prerelease?: string; group?: string } = {},
  ) {
    super();
    if (options.prerelease) {
      this.setPackageOptions({ prerelease: options.prerelease });
    }
    this.path = `/repo/packages/${name.replace("@", "").replace("/", "-")}`;
    this.group = options.group;
  }

  readonly path: string;
  readonly group?: string;
}
