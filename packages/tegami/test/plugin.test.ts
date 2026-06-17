import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { tegami } from "../src";
import type { TegamiPlugin } from "../src/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("tegami plugins", () => {
  test("runs lifecycle hooks in enforce order", async () => {
    const cwd = await createWorkspace();
    tempDirs.push(cwd);
    const calls: string[] = [];

    const plugins = [
      plugin("default-a", calls),
      plugin("post-a", calls, "post"),
      plugin("pre-a", calls, "pre"),
      plugin("default-b", calls, "default"),
      plugin("pre-b", calls, "pre"),
      plugin("post-b", calls, "post"),
    ];

    await tegami({ cwd, plugins }).draft();
    await writePublishPlan(cwd);
    await tegami({ cwd, plugins }).publish({
      dryRun: true,
    });

    expect(calls).toMatchInlineSnapshot(`
      [
        "initPlan:pre-a",
        "initPlan:pre-b",
        "initPlan:default-a",
        "initPlan:default-b",
        "initPlan:post-a",
        "initPlan:post-b",
      ]
    `);
  });
});

function plugin(name: string, calls: string[], enforce?: TegamiPlugin["enforce"]): TegamiPlugin {
  return {
    name,
    enforce,
    initPlan() {
      calls.push(`initPlan:${name}`);
    },
    afterPublish() {
      calls.push(`afterPublish:${name}`);
    },
  };
}

async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-plugin-"));
  const packagePath = join(cwd, "packages/core");

  await mkdir(packagePath, { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeJson(join(packagePath, "package.json"), {
    name: "@acme/core",
    version: "1.0.0",
  });
  await writeFile(
    join(cwd, ".tegami/change.md"),
    `---
packages: ["@acme/core"]
---

### Patch
`,
  );

  return cwd;
}

async function writePublishPlan(cwd: string): Promise<void> {
  const changelog = await readFile(join(cwd, ".tegami/change.md"), "utf8").catch(() => undefined);

  await writeJson(join(cwd, ".tegami/publish-plan"), {
    id: "tegami-plugin-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    changelogs: changelog
      ? {
          "change.md": {
            filename: "change.md",
            packages: { "@acme/core": "patch" },
            sections: [{ title: "Patch", content: "" }],
          },
        }
      : {},
    packages: {
      "@acme/core": {
        type: "patch",
        changelogIds: changelog ? ["change.md"] : [],
        npm: { distTag: "latest" },
        publish: true,
      },
    },
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
