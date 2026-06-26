import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { tegami } from "../src";
import type { TegamiPlugin } from "../src/types";
import {
  installRegistryFetchMock,
  mockRegistryMissing,
  uninstallRegistryFetchMock,
} from "./helpers/registry-fetch";

const tempDirs: string[] = [];

beforeEach(() => {
  installRegistryFetchMock();
  mockRegistryMissing();
});

afterEach(async () => {
  uninstallRegistryFetchMock();
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

    await tegami({ cwd, plugins })
      .draft()
      .then((draft) => draft.apply());
    await tegami({ cwd, plugins }).publish({
      dryRun: true,
    });

    expect(calls).toMatchInlineSnapshot(`
      [
        "initDraft:pre-a",
        "initDraft:pre-b",
        "initDraft:default-a",
        "initDraft:default-b",
        "initDraft:post-a",
        "initDraft:post-b",
        "initPublishPlan:pre-a",
        "initPublishPlan:pre-b",
        "initPublishPlan:default-a",
        "initPublishPlan:default-b",
        "initPublishPlan:post-a",
        "initPublishPlan:post-b",
        "afterPublish:pre-a",
        "afterPublish:pre-b",
        "afterPublish:default-a",
        "afterPublish:default-b",
        "afterPublish:post-a",
        "afterPublish:post-b",
        "afterPublishAll:pre-a",
        "afterPublishAll:pre-b",
        "afterPublishAll:default-a",
        "afterPublishAll:default-b",
        "afterPublishAll:post-a",
        "afterPublishAll:post-b",
      ]
    `);
  });
});

function plugin(name: string, calls: string[], enforce?: TegamiPlugin["enforce"]): TegamiPlugin {
  return {
    name,
    enforce,
    initDraft() {
      calls.push(`initDraft:${name}`);
    },
    initPublishPlan() {
      calls.push(`initPublishPlan:${name}`);
    },
    afterPublish() {
      calls.push(`afterPublish:${name}`);
    },
    afterPublishAll() {
      calls.push(`afterPublishAll:${name}`);
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
