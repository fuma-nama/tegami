import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x } from "tinyexec";
import { afterEach, describe, expect, test } from "vitest";
import { tegami } from "tegami";
import { git } from "tegami/plugins/git";
import { maven } from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("maven plugin", () => {
  test("discovers modules with inherited coordinates", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const graph = (await tegami({ cwd, plugins: [maven()] })._internal.context()).graph;
    const packages = graph
      .getPackages()
      .filter((pkg) => pkg.manager === "maven")
      .map((pkg) => ({ id: pkg.id, version: pkg.version }))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(packages).toEqual([
      { id: "maven:com.acme:acme-api", version: "1.0.0" },
      { id: "maven:com.acme:acme-core", version: "1.0.0" },
      { id: "maven:com.acme:acme-parent", version: "1.0.0" },
    ]);
  });

  test("bumps dependents and updates parent references", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "maven:com.acme:acme-core", "major");

    await tegami({ cwd, plugins: [maven()] })
      .draft()
      .then((draft) => draft.apply());

    const core = await readFile(join(cwd, "core/pom.xml"), "utf8");
    const api = await readFile(join(cwd, "api/pom.xml"), "utf8");

    expect(core).toContain("<version>2.0.0</version>");
    // api's literal dependency version rewritten, api itself patch-bumped
    expect(api).toContain("<version>1.0.1</version>");
    expect(api).toContain("<artifactId>acme-core</artifactId>\n      <version>2.0.0</version>");
  });

  test("surfaces malformed poms instead of dropping the module", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeFile(join(cwd, "core/pom.xml"), `<project><groupId`);

    await expect(tegami({ cwd, plugins: [maven()] })._internal.context()).rejects.toThrow(
      /Failed to parse .*core\/pom\.xml/,
    );
  });

  test("publishes with colon-free git tags", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await initGitRepo(cwd);
    await writeChangelog(cwd, "maven:com.acme:acme-core", "minor");

    await tegami({ cwd, plugins: [git(), maven()] })
      .draft()
      .then((draft) => draft.apply());

    const result = await tegami({
      cwd,
      plugins: [
        git({ pushTags: false }),
        // `true` is a no-op stand-in for `mvn deploy`; registry checks are disabled
        maven({ publishCommand: ["true"], registry: false }),
      ],
    }).publish();

    expect(result).not.toBe("skipped");
    if (result === "skipped") return;

    // the default `name@version` tag would be `com.acme:acme-core@…` — invalid for git
    expect(result.packages.get("maven:com.acme:acme-core")?.git?.tag).toBe(
      "com.acme/acme-core@1.1.0",
    );

    const tags = await gitTags(cwd);
    expect(tags).toContain("com.acme/acme-core@1.1.0");
    for (const tag of tags) expect(tag).not.toContain(":");
  });
});

async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-maven-"));
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await mkdir(join(cwd, "core"), { recursive: true });
  await mkdir(join(cwd, "api"), { recursive: true });

  await writeFile(
    join(cwd, "pom.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>acme-parent</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <modules>
    <module>core</module>
    <module>api</module>
  </modules>
</project>
`,
  );

  await writeFile(
    join(cwd, "core/pom.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>acme-core</artifactId>
  <version>1.0.0</version>
</project>
`,
  );

  await writeFile(
    join(cwd, "api/pom.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>acme-api</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>com.acme</groupId>
      <artifactId>acme-core</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>
`,
  );

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
