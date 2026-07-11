import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x } from "tinyexec";
import { afterEach, describe, expect, test } from "vitest";
import { tegami } from "tegami";
import { git } from "tegami/plugins/git";
import { isTagCreated, swift } from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("swift plugin", () => {
  test("discovers packages and resolves versions from git tags", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const graph = (await tegami({ cwd, plugins: [git(), swift()] })._internal.context()).graph;
    const packages = graph
      .getPackages()
      .filter((pkg) => pkg.manager === "swift")
      .map((pkg) => ({ id: pkg.id, name: pkg.name, version: pkg.version }));

    expect(packages).toEqual(
      expect.arrayContaining([
        { id: "swift:Root", name: "Root", version: "1.2.0" },
        { id: "swift:Foo", name: "Foo", version: "1.0.0" },
        { id: "swift:Bar", name: "Bar", version: "1.0.0" },
      ]),
    );
  });

  test("requires a git/github/gitlab plugin when swift packages are present", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    await expect(tegami({ cwd, plugins: [swift()] })._internal.context()).rejects.toThrow(
      /requires the git plugin/,
    );
  });

  test("patch-bumps local path dependents on draft", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "Foo", "minor");

    const paper = tegami({ cwd, plugins: [git(), swift()] });
    const context = await paper._internal.context();
    const draft = await paper.draft();

    const versions = Object.fromEntries(
      context.graph
        .getPackages()
        .filter((pkg) => pkg.manager === "swift")
        .map((pkg) => [pkg.id, draft.getPackageDraft(pkg.id)?.bumpVersion(pkg)]),
    );

    expect(versions).toEqual({
      "swift:Foo": "1.1.0",
      "swift:Bar": "1.0.1",
      "swift:Root": "1.2.1",
    });
  });

  test("honors a custom bumpDep strategy", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "Foo", "minor");

    const paper = tegami({ cwd, plugins: [git(), swift({ bumpDep: () => "minor" })] });
    const context = await paper._internal.context();
    const draft = await paper.draft();

    const bar = context.graph.get("swift:Bar")!;
    expect(draft.getPackageDraft("swift:Bar")?.bumpVersion(bar)).toBe("1.1.0");
  });

  test("computes tag names for root and subdirectory packages and creates git tags", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "Foo", "minor");

    await tegami({ cwd, plugins: [git(), swift()] })
      .draft()
      .then((draft) => draft.apply());

    const result = await tegami({
      cwd,
      plugins: [git({ pushTags: false }), swift()],
    }).publish();

    expect(result).not.toBe("skipped");
    if (result === "skipped") return;

    expect(result.packages.get("swift:Foo")?.git?.tag).toBe("packages/foo/1.1.0");
    expect(result.packages.get("swift:Bar")?.git?.tag).toBe("packages/bar/1.0.1");
    expect(result.packages.get("swift:Root")?.git?.tag).toBe("1.2.1");

    const published = [...result.packages.entries()]
      .filter(([, plan]) => plan.publishResult?.type === "published")
      .map(([id]) => id)
      .sort();
    expect(published).toEqual(["swift:Bar", "swift:Foo", "swift:Root"]);

    const tags = new Set((await gitTags(cwd)).map((tag) => tag.trim()));
    expect(tags).toContain("packages/foo/1.1.0");
    expect(tags).toContain("packages/bar/1.0.1");
    expect(tags).toContain("1.2.1");
  });

  test("orders publishing after local path dependencies", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "Foo", "minor");

    await tegami({ cwd, plugins: [git(), swift()] })
      .draft()
      .then((draft) => draft.apply());

    const result = await tegami({
      cwd,
      plugins: [git({ pushTags: false }), swift()],
    }).publish();

    expect(result).not.toBe("skipped");
    if (result === "skipped") return;

    expect(result.packages.get("swift:Bar")?.preflight?.wait).toEqual(["swift:Foo"]);
    expect(result.packages.get("swift:Root")?.preflight?.wait?.sort()).toEqual([
      "swift:Bar",
      "swift:Foo",
    ]);
  });

  test("skips publishing when the git tag already exists", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "Foo", "minor");

    await tegami({ cwd, plugins: [git(), swift()] })
      .draft()
      .then((draft) => draft.apply());

    // pre-create every target tag so the plan is already fully published.
    for (const tag of ["packages/foo/1.1.0", "packages/bar/1.0.1", "1.2.1"]) {
      await run(cwd, "git", ["tag", tag]);
    }

    const result = await tegami({
      cwd,
      plugins: [git({ pushTags: false }), swift()],
    }).publish();

    expect(result).toBe("skipped");
  });

  test("respects the publish option for individual packages", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "Foo", "minor");

    await tegami({ cwd, plugins: [git(), swift()] })
      .draft()
      .then((draft) => draft.apply());

    const result = await tegami({
      cwd,
      plugins: [git({ pushTags: false }), swift({ publish: (pkg) => pkg.name !== "Root" })],
    }).publish();

    expect(result).not.toBe("skipped");
    if (result === "skipped") return;

    expect(result.packages.get("swift:Root")?.preflight?.shouldPublish).toBe(false);
    expect(result.packages.get("swift:Foo")?.preflight?.shouldPublish).toBe(true);

    const tags = new Set((await gitTags(cwd)).map((tag) => tag.trim()));
    expect(tags).toContain("packages/foo/1.1.0");
    expect(tags).not.toContain("1.2.1");
  });

  test("skips manifests that lack a package name", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-swift-noname-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, ".tegami"), { recursive: true });
    await writeFile(
      join(cwd, "Package.swift"),
      `// swift-tools-version:5.9
import PackageDescription
let package = Package(products: [])
`,
    );
    await initGitRepo(cwd);

    const graph = (await tegami({ cwd, plugins: [git(), swift()] })._internal.context()).graph;
    expect(graph.getPackages().filter((pkg) => pkg.manager === "swift")).toHaveLength(0);
  });
});

test("isTagCreated falls back to the remote when the tag is not local", async () => {
  // upstream repo owning the tag
  const upstream = await mkdtemp(join(tmpdir(), "tegami-swift-upstream-"));
  tempDirs.push(upstream);
  await writeFile(join(upstream, "Package.swift"), `let package = Package(name: "Foo")\n`);
  await initGitRepo(upstream);
  await run(upstream, "git", ["tag", "1.2.3"]);

  // fresh clone without tags — simulates a shallow CI checkout
  const clone = await mkdtemp(join(tmpdir(), "tegami-swift-clone-"));
  tempDirs.push(clone);
  await run(clone, "git", ["clone", "-q", "--no-tags", upstream, "."]);

  expect(await gitTags(clone)).toEqual([]);
  expect(await isTagCreated(clone, "1.2.3")).toBe(true);
  expect(await isTagCreated(clone, "9.9.9")).toBe(false);
});

async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-swift-"));
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await mkdir(join(cwd, "packages/foo"), { recursive: true });
  await mkdir(join(cwd, "packages/bar"), { recursive: true });

  await writeFile(
    join(cwd, "Package.swift"),
    `// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Root",
    dependencies: [
        .package(path: "packages/foo"),
        .package(path: "packages/bar"),
    ],
    targets: [
        .target(name: "Root"),
    ]
)
`,
  );
  await writeFile(
    join(cwd, "packages/foo/Package.swift"),
    `// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Foo",
    targets: [.target(name: "Foo")]
)
`,
  );
  await writeFile(
    join(cwd, "packages/bar/Package.swift"),
    `// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Bar",
    dependencies: [
        .package(name: "Foo", path: "../foo"),
        .package(url: "https://github.com/apple/swift-log", from: "1.0.0"),
    ],
    targets: [.target(name: "Bar")]
)
`,
  );

  await initGitRepo(cwd);
  await run(cwd, "git", ["tag", "1.2.0"]);
  await run(cwd, "git", ["tag", "packages/foo/1.0.0"]);
  await run(cwd, "git", ["tag", "packages/bar/1.0.0"]);

  return cwd;
}

async function initGitRepo(cwd: string): Promise<void> {
  await run(cwd, "git", ["init", "-q"]);
  await run(cwd, "git", ["config", "user.email", "test@example.com"]);
  await run(cwd, "git", ["config", "user.name", "Tegami Test"]);
  await run(cwd, "git", ["config", "commit.gpgsign", "false"]);
  await run(cwd, "git", ["add", "."]);
  await run(cwd, "git", ["commit", "-q", "-m", "init", "--no-gpg-sign"]);
}

async function gitTags(cwd: string): Promise<string[]> {
  const result = await x("git", ["tag", "--list"], { nodeOptions: { cwd } });
  return result.stdout.split("\n").filter(Boolean);
}

async function run(cwd: string, command: string, args: string[]): Promise<void> {
  const result = await x(command, args, { nodeOptions: { cwd } });
  if (result.exitCode !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` failed: ${result.stderr || result.stdout}`);
  }
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
