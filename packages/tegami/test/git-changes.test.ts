import { x } from "tinyexec";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { PackageGraph, WorkspacePackage } from "../src/graph";
import {
  getChangedFilePaths,
  getChangedPackages,
  resolveChangedPackages,
} from "../src/utils/git-changes";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const exec = vi.mocked(x);
const cwd = "/repo";

beforeEach(() => {
  exec.mockReset();
});

describe("resolveChangedPackages", () => {
  const graph = new PackageGraph([
    testPackage("@acme/root", "/repo"),
    testPackage("@acme/core", "/repo/packages/core"),
    testPackage("@acme/ui", "/repo/packages/ui"),
  ]);

  test("maps changed files to the most specific package", () => {
    const changed = resolveChangedPackages(
      graph,
      ["packages/core/src/index.ts", "package.json"],
      cwd,
    );

    expect(changed.map((pkg) => pkg.name)).toEqual(["@acme/core", "@acme/root"]);
  });

  test("returns an empty list when no files match packages", () => {
    const scopedGraph = new PackageGraph([
      testPackage("@acme/core", "/repo/packages/core"),
      testPackage("@acme/ui", "/repo/packages/ui"),
    ]);

    expect(resolveChangedPackages(scopedGraph, ["README.md"], cwd)).toEqual([]);
  });
});

describe("getChangedFilePaths", () => {
  test("merges unstaged and staged changes", async () => {
    exec.mockImplementation((_command, args = []) => {
      if (args[0] === "diff" && args[1] === "--name-only" && args.length === 2) {
        return commandResult({ stdout: "packages/core/src/index.ts\n" });
      }
      if (args[0] === "diff" && args[1] === "--cached") {
        return commandResult({ stdout: "packages/ui/src/button.tsx\n" });
      }
      return commandResult({ exitCode: 1 });
    });

    const files = await getChangedFilePaths(cwd);

    expect(files).toEqual(["packages/core/src/index.ts", "packages/ui/src/button.tsx"]);
  });
});

describe("getChangedPackages", () => {
  test("resolves changed packages from git output", async () => {
    const graph = new PackageGraph([testPackage("@acme/core", "/repo/packages/core")]);

    exec.mockImplementation((_command, args = []) => {
      if (args[0] === "diff" && args[1] === "--name-only" && args.length === 2) {
        return commandResult({ stdout: "packages/core/src/index.ts\n" });
      }
      return commandResult({ exitCode: 1 });
    });

    const changed = await getChangedPackages(graph, cwd);

    expect(changed.map((pkg) => pkg.name)).toEqual(["@acme/core"]);
  });
});

function commandResult(
  overrides: Partial<Awaited<ReturnType<typeof x>>> = {},
): ReturnType<typeof x> {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  } as unknown as ReturnType<typeof x>;
}

function testPackage(name: string, path: string): WorkspacePackage {
  return new GitChangesTestPackage(name, path);
}

class GitChangesTestPackage extends WorkspacePackage {
  readonly manager = "npm";
  readonly version = "1.0.0";

  constructor(
    readonly name: string,
    readonly path: string,
  ) {
    super();
  }
}
