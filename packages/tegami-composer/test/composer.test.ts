import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { tegami } from "tegami";
import { git } from "tegami/plugins/git";
import {
  composer,
  isPackagePublished,
  satisfiesConstraint,
  toSemverRange,
  updateConstraint,
} from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("composer plugin", () => {
  test("discovers path-repository members and the root", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    const graph = (await tegami({ cwd, plugins: [git(), composer()] })._internal.context()).graph;
    const packages = graph
      .getPackages()
      .filter((pkg) => pkg.manager === "composer")
      .map((pkg) => ({ id: pkg.id, name: pkg.name, version: pkg.version }))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(packages).toEqual([
      { id: "composer:acme/api", name: "acme/api", version: "1.0.0" },
      { id: "composer:acme/core", name: "acme/core", version: "1.0.0" },
      { id: "composer:acme/monorepo", name: "acme/monorepo", version: "0.0.0" },
      { id: "composer:acme/tool", name: "acme/tool", version: "1.0.0" },
    ]);
  });

  test("bumps dependents and rewrites constraints only when needed", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "composer:acme/core", "major");

    await tegami({ cwd, plugins: [git(), composer()] })
      .draft()
      .then((draft) => draft.apply());

    const api = JSON.parse(await readFile(join(cwd, "packages/api/composer.json"), "utf8"));
    // core released 2.0.0 → api's `^1.0` no longer accepts it → rewritten + api patch-bumped
    expect(api.version).toBe("1.0.1");
    expect(api.require["acme/core"]).toBe("^2.0.0");
    // require-dev tool constraint that still accepts is left alone
    expect(api["require-dev"]["acme/core"]).toBe("*");
  });

  test("preserves formatting and key order", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    await writeChangelog(cwd, "composer:acme/core", "major");

    await tegami({ cwd, plugins: [git(), composer()] })
      .draft()
      .then((draft) => draft.apply());

    const raw = await readFile(join(cwd, "packages/api/composer.json"), "utf8");
    // 2-space indent preserved and trailing newline retained
    expect(raw).toMatch(/\n {2}"name":/);
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("does not bump require-dev dependents by default", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    // only tool depends on core in require-dev; it should not be released
    await writeChangelog(cwd, "composer:acme/core", "minor");

    await tegami({ cwd, plugins: [git(), composer()] })
      .draft()
      .then((draft) => draft.apply());

    const tool = JSON.parse(await readFile(join(cwd, "packages/tool/composer.json"), "utf8"));
    expect(tool.version).toBe("1.0.0"); // untouched
  });

  test("constraint helpers", () => {
    expect(toSemverRange("1.2.*")).toBe("1.2.x");
    expect(toSemverRange(">=1.0, <2.0")).toBe(">=1.0  <2.0");
    expect(satisfiesConstraint("1.5.0", "^1.0")).toBe(true);
    expect(satisfiesConstraint("2.0.0", "^1.0")).toBe(false);
    expect(satisfiesConstraint("1.2.9", "1.2.*")).toBe(true);
    expect(updateConstraint("^1.0", "2.0.0")).toBe("^2.0.0");
    expect(updateConstraint("1.2.*", "2.3.4")).toBe("2.3.*");
    expect(updateConstraint(">=1.0", "2.0.0")).toBe(">=2.0.0");
  });

  test("tilde constraints use Composer semantics, not npm's", () => {
    // Composer `~1.2` means `>=1.2.0 <2.0.0` (npm reads `<1.3.0`)
    expect(satisfiesConstraint("1.9.0", "~1.2")).toBe(true);
    expect(satisfiesConstraint("2.0.0", "~1.2")).toBe(false);
    // three-segment tilde stays minor-scoped in both dialects
    expect(satisfiesConstraint("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfiesConstraint("1.3.0", "~1.2.3")).toBe(false);
    // rewrite preserves the original precision (`~1.0` stays two segments)
    expect(updateConstraint("~1.0", "2.0.0")).toBe("~2.0");
    expect(updateConstraint("~1.2.3", "2.5.0")).toBe("~2.5.0");
    // prerelease versions are never truncated
    expect(updateConstraint("~1.0", "2.0.0-beta.1")).toBe("~2.0.0-beta.1");
  });

  test("compound constraints are replaced whole, never made contradictory", () => {
    expect(satisfiesConstraint("2.5.0", ">=1.0 <2.0")).toBe(false);
    // rewriting only the lower bound would produce the unsatisfiable `>=2.5.0 <2.0`
    expect(updateConstraint(">=1.0 <2.0", "2.5.0")).toBe("^2.5.0");
    expect(updateConstraint(">=1.0, <2.0", "2.5.0")).toBe("^2.5.0");
    expect(updateConstraint("1.2 || 2.0", "3.0.0")).toBe("^3.0.0");
    // a single spaced comparator is still one term
    expect(updateConstraint(">= 1.0", "2.0.0")).toBe(">=2.0.0");
    // rewritten exclusive bounds must include the new version
    expect(updateConstraint(">1.0", "2.0.0")).toBe(">=2.0.0");
  });

  test("root package ignores subdirectory tags that happen to match its prefix", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    // a real repo where the only tags are a subdirectory package's — the root
    // pattern `v*` also fnmatch-es `vendor-lib/v2.5.0`, which must be rejected
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const run = async (...args: string[]) => {
      const { x } = await import("tinyexec");
      const result = await x("git", args, { nodeOptions: { cwd, env } });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    };
    await run("init", "-q");
    await run("add", ".");
    await run("commit", "-q", "-m", "init");
    await run("tag", "vendor-lib/v2.5.0");
    await run("tag", "packages/core/v3.0.0");

    const graph = (await tegami({ cwd, plugins: [git(), composer()] })._internal.context()).graph;
    // root falls back to its composer.json version, not the subdirectory tag
    expect(graph.get("composer:acme/monorepo")?.version).toBe("0.0.0");
    // the subdirectory package resolves its own tag
    expect(graph.get("composer:acme/core")?.version).toBe("3.0.0");
  });

  test("throws without the git plugin", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);

    await expect(tegami({ cwd, plugins: [composer()] })._internal.context()).rejects.toThrow(
      /requires the git plugin/,
    );
  });

  test("isPackagePublished checks the registry", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("acme/core.json")) {
        return new Response(
          JSON.stringify({ packages: { "acme/core": [{ version: "v2.0.0" }] } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      isPackagePublished("https://repo.packagist.org", "acme/core", "2.0.0"),
    ).resolves.toBe(true);
    await expect(
      isPackagePublished("https://repo.packagist.org", "acme/core", "3.0.0"),
    ).resolves.toBe(false);
    await expect(
      isPackagePublished("https://repo.packagist.org", "acme/missing", "1.0.0"),
    ).resolves.toBe(false);
  });
});

async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-composer-"));
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await mkdir(join(cwd, "packages/api"), { recursive: true });
  await mkdir(join(cwd, "packages/tool"), { recursive: true });

  await writeJson(join(cwd, "composer.json"), {
    name: "acme/monorepo",
    type: "project",
    repositories: [{ type: "path", url: "packages/*" }],
  });

  await writeJson(join(cwd, "packages/core/composer.json"), {
    name: "acme/core",
    version: "1.0.0",
    description: "core lib",
  });

  await writeJson(join(cwd, "packages/api/composer.json"), {
    name: "acme/api",
    version: "1.0.0",
    require: { "acme/core": "^1.0", php: ">=8.1" },
    "require-dev": { "acme/core": "*" },
  });

  await writeJson(join(cwd, "packages/tool/composer.json"), {
    name: "acme/tool",
    version: "1.0.0",
    "require-dev": { "acme/core": "^1.0" },
  });

  return cwd;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
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
