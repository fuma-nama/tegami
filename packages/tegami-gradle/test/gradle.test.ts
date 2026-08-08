import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { x } from "tinyexec";
import { afterEach, describe, expect, test } from "vitest";
import { tegami } from "tegami";
import { git } from "tegami/plugins/git";
import { gradle } from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("gradle plugin", () => {
  test("discovers projects with vanniktech coordinates", async () => {
    const cwd = await createWorkspace();

    const graph = (await tegami({ cwd, plugins: [gradle()] })._internal.context()).graph;
    const packages = graph
      .getPackages()
      .filter((pkg) => pkg.manager === "gradle")
      .map((pkg) => ({ id: pkg.id, version: pkg.version }))
      .sort((a, b) => a.id.localeCompare(b.id));

    // the root project has a GROUP but no version, so it is not a releasable artifact
    expect(packages).toEqual([
      { id: "gradle:com.acme:acme-api", version: "1.0.0" },
      { id: "gradle:com.acme:acme-app", version: "1.0.0" },
      { id: "gradle:com.acme:acme-core", version: "1.0.0" },
    ]);
  });

  test("bumps dependents through project() dependencies", async () => {
    const cwd = await createWorkspace();
    await writeChangelog(cwd, "gradle:com.acme:acme-core", "major");

    await tegami({ cwd, plugins: [gradle()] })
      .draft()
      .then((draft) => draft.apply());

    expect(await read(cwd, "core/gradle.properties")).toContain("VERSION_NAME=2.0.0");
    // api depends on :core with `implementation`, so it is patch-bumped
    expect(await read(cwd, "api/gradle.properties")).toContain("VERSION_NAME=1.0.1");
    // app only depends on :core for tests, so it is left alone
    expect(await read(cwd, "app/gradle.properties")).toContain("VERSION_NAME=1.0.0");
  });

  test("writes versions authored in the build script", async () => {
    const cwd = await createWorkspace({
      "settings.gradle.kts": `rootProject.name = "tools"\n\ninclude(":cli")\n`,
      "build.gradle.kts": `allprojects {\n    group = "com.acme.tools"\n}\n`,
      "cli/build.gradle.kts": `plugins {\n    id("maven-publish")\n}\n\nversion = "0.3.0"\n`,
    });

    const graph = (await tegami({ cwd, plugins: [gradle()] })._internal.context()).graph;
    expect(graph.getPackages().map((pkg) => pkg.id)).toEqual(["gradle:com.acme.tools:cli"]);

    await writeChangelog(cwd, "gradle:com.acme.tools:cli", "minor");
    await tegami({ cwd, plugins: [gradle()] })
      .draft()
      .then((draft) => draft.apply());

    const script = await read(cwd, "cli/build.gradle.kts");
    expect(script).toContain(`version = "0.4.0"`);
    // the rest of the script is untouched
    expect(script).toContain(`id("maven-publish")`);
  });

  test("follows projectDir and name overrides from settings", async () => {
    const cwd = await createWorkspace({
      "settings.gradle": `include ':core'

project(':core').projectDir = file('libs/core')
project(':core').name = 'renamed-core'
`,
      "gradle.properties": `GROUP=com.acme\n`,
      "libs/core/gradle.properties": `VERSION_NAME=1.0.0\n`,
      "libs/core/build.gradle": `apply plugin: 'maven-publish'\n`,
    });

    const graph = (await tegami({ cwd, plugins: [gradle()] })._internal.context()).graph;
    expect(graph.getPackages().map((pkg) => pkg.id)).toEqual(["gradle:com.acme:renamed-core"]);

    await writeChangelog(cwd, "gradle:com.acme:renamed-core", "patch");
    await tegami({ cwd, plugins: [gradle()] })
      .draft()
      .then((draft) => draft.apply());

    expect(await read(cwd, "libs/core/gradle.properties")).toContain("VERSION_NAME=1.0.1");
  });

  test("collapses a shared root version into one edit", async () => {
    const cwd = await createWorkspace({
      "settings.gradle.kts": `include(":core", ":api")\n`,
      "gradle.properties": `GROUP=com.acme\nVERSION_NAME=1.0.0\n`,
      "core/build.gradle.kts": `plugins {\n    id("maven-publish")\n}\n`,
      "api/build.gradle.kts": `plugins {\n    id("maven-publish")\n}\n\ndependencies {\n    implementation(project(":core"))\n}\n`,
    });

    await writeChangelog(cwd, "gradle:com.acme:core", "major");
    await tegami({ cwd, plugins: [gradle()] })
      .draft()
      .then((draft) => draft.apply());

    // both projects read the same property, so the highest bump wins for both
    expect(await read(cwd, "gradle.properties")).toBe(`GROUP=com.acme\nVERSION_NAME=2.0.0\n`);
  });

  test("surfaces malformed scripts instead of dropping the project", async () => {
    const cwd = await createWorkspace();
    await writeFile(join(cwd, "core/build.gradle.kts"), `version = "1.0.0\n`);

    await expect(tegami({ cwd, plugins: [gradle()] })._internal.context()).rejects.toThrow(
      /Failed to parse .*core\/build\.gradle\.kts/,
    );
  });

  test("publishes declared projects with colon-free git tags", async () => {
    const cwd = await createWorkspace();
    await initGitRepo(cwd);
    await writeChangelog(cwd, "gradle:com.acme:acme-core", "minor");

    await tegami({ cwd, plugins: [git(), gradle()] })
      .draft()
      .then((draft) => draft.apply());

    const result = await tegami({
      cwd,
      plugins: [
        git({ pushTags: false }),
        // `true` is a no-op stand-in for `./gradlew publish`
        gradle({ publishCommand: ["true"], registry: false }),
      ],
    }).publish();

    expect(result).not.toBe("skipped");
    if (result === "skipped") return;

    // the default `name@version` tag would be `com.acme:acme-core@…` — invalid for git
    expect(result.packages.get("gradle:com.acme:acme-core")?.git?.tag).toBe(
      "com.acme/acme-core@1.1.0",
    );

    const tags = await gitTags(cwd);
    expect(tags).toContain("com.acme/acme-core@1.1.0");
    for (const tag of tags) expect(tag).not.toContain(":");
  });

  test("skips projects that never declare publishing", async () => {
    const cwd = await releasedWorkspace();
    const tags = await gitTags(cwd);

    // app applies no publishing plugin, so it is versioned but never published
    expect(tags).toContain("com.acme/acme-core@1.1.0");
    expect(tags).not.toContain("com.acme/acme-app@1.1.0");
  });

  test("honours an explicit publish option for convention-plugin projects", async () => {
    const cwd = await releasedWorkspace({
      packages: { "com.acme:acme-app": { gradle: { publish: true } } },
    });

    // detection cannot see convention plugins, so the option is the contract
    expect(await gitTags(cwd)).toContain("com.acme/acme-app@1.1.0");
  });
});

/** version + publish a workspace where both `core` and `app` are bumped. */
async function releasedWorkspace(options: Record<string, unknown> = {}): Promise<string> {
  const cwd = await createWorkspace();
  await initGitRepo(cwd);
  await writeChangelog(cwd, {
    "gradle:com.acme:acme-core": "minor",
    "gradle:com.acme:acme-app": "minor",
  });

  await tegami({ cwd, plugins: [git(), gradle()], ...options })
    .draft()
    .then((draft) => draft.apply());

  await tegami({
    cwd,
    plugins: [git({ pushTags: false }), gradle({ publishCommand: ["true"], registry: false })],
    ...options,
  }).publish();

  return cwd;
}

const DEFAULT_FILES: Record<string, string> = {
  "settings.gradle.kts": `rootProject.name = "acme"

include(":core", ":api", ":app")
`,
  "gradle.properties": `GROUP=com.acme
`,
  "core/gradle.properties": `VERSION_NAME=1.0.0
POM_ARTIFACT_ID=acme-core
`,
  "core/build.gradle.kts": `plugins {
    id("com.vanniktech.maven.publish")
}
`,
  "api/gradle.properties": `VERSION_NAME=1.0.0
POM_ARTIFACT_ID=acme-api
`,
  "api/build.gradle.kts": `plugins {
    id("com.vanniktech.maven.publish")
}

dependencies {
    implementation(project(":core"))
}
`,
  "app/gradle.properties": `VERSION_NAME=1.0.0
POM_ARTIFACT_ID=acme-app
`,
  // no publishing plugin, and it only uses :core in tests
  "app/build.gradle.kts": `plugins {
    id("application")
}

dependencies {
    testImplementation(project(":core"))
}
`,
};

async function createWorkspace(files: Record<string, string> = DEFAULT_FILES): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-gradle-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, ".tegami"), { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    const file = join(cwd, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  return cwd;
}

function read(cwd: string, file: string): Promise<string> {
  return readFile(join(cwd, file), "utf8");
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

async function writeChangelog(cwd: string, bumps: Record<string, string> | string, type?: string) {
  const packages = typeof bumps === "string" ? { [bumps]: type! } : bumps;
  const entries = Object.entries(packages);

  await writeFile(
    join(cwd, ".tegami/change.md"),
    `---
packages:
${entries.map(([pkg, bump]) => `  "${pkg}": ${bump}`).join("\n")}
---

### Update ${entries.map(([pkg]) => pkg).join(", ")}

Release notes.
`,
  );
}
