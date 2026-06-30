import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { x } from "tinyexec";
import { tegami } from "../src";
import { createCli } from "../src/cli";
import { github } from "../src/plugins/github";
import { gitlab } from "../src/plugins/gitlab";
import { writePublishLock } from "./helpers/lock";
import {
  fetchMock,
  installRegistryFetchMock,
  mockRegistryMissing,
  uninstallRegistryFetchMock,
} from "./helpers/registry-fetch";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const tempDirs: string[] = [];
const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockReset();
  installRegistryFetchMock();
  mockRegistryMissing();
});

afterEach(async () => {
  uninstallRegistryFetchMock();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("npm pretrust", () => {
  test("publishes placeholders and configures npm trust for new packages", async () => {
    const cwd = await createFixture();
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));
    exec.mockResolvedValue(execResult());

    await createCli(
      tegami({
        cwd,
        npm: { trustedPublish: { provider: "github", workflow: "publish.yml" } },
        plugins: [github({ repo: "acme/widgets" })],
      }),
    ).parseAsync(["npm", "pretrust"]);

    expect(exec).toHaveBeenCalledTimes(4);
    expect(exec).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["publish"]),
      expect.anything(),
    );
    expect(exec).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["trust", "github", "@acme/core", "--repo", "acme/widgets"]),
      expect.anything(),
    );
  });

  test("uses gitlab project and npm trust gitlab", async () => {
    const cwd = await createFixture();
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));
    exec.mockResolvedValue(execResult());

    await createCli(
      tegami({
        cwd,
        npm: { trustedPublish: { provider: "gitlab", workflow: ".gitlab-ci.yml" } },
        plugins: [gitlab({ repo: "acme/widgets" })],
      }),
    ).parseAsync(["npm", "pretrust"]);

    expect(exec).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining([
        "trust",
        "gitlab",
        "@acme/core",
        "--project",
        "acme/widgets",
        "--file",
        ".gitlab-ci.yml",
      ]),
      expect.anything(),
    );
  });

  test("skips packages already on the registry", async () => {
    const cwd = await createFixture();
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("@acme/core")) {
        return new Response(JSON.stringify({ name: "@acme/core" }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });
    exec.mockResolvedValue(execResult());

    await createCli(
      tegami({
        cwd,
        npm: { trustedPublish: { provider: "github", workflow: "publish.yml" } },
        plugins: [github({ repo: "acme/widgets" })],
      }),
    ).parseAsync(["npm", "pretrust"]);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["trust", "github", "@acme/ui"]),
      expect.anything(),
    );
  });

  test("does not publish in dry run mode", async () => {
    const cwd = await createFixture();
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));

    await createCli(
      tegami({
        cwd,
        npm: { trustedPublish: { provider: "github", workflow: "publish.yml" } },
        plugins: [github({ repo: "acme/widgets" })],
      }),
    ).parseAsync(["npm", "pretrust", "--dry-run"]);

    expect(exec).not.toHaveBeenCalled();
  });

  test("requires a publish lock", async () => {
    const cwd = await createFixture({ lock: false });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(
      createCli(
        tegami({
          cwd,
          npm: { trustedPublish: { provider: "github", workflow: "publish.yml" } },
          plugins: [github({ repo: "acme/widgets" })],
        }),
      ).parseAsync(["npm", "pretrust"]),
    ).rejects.toThrow("exit");

    exit.mockRestore();
  });

  test("requires the matching version control plugin repo", async () => {
    const cwd = await createFixture();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(
      createCli(
        tegami({
          cwd,
          npm: { trustedPublish: { provider: "github", workflow: "publish.yml" } },
        }),
      ).parseAsync(["npm", "pretrust"]),
    ).rejects.toThrow("exit");

    exit.mockRestore();
  });
});

async function createFixture(options: { lock?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "tegami-npm-pretrust-"));
  tempDirs.push(cwd);

  await mkdir(join(cwd, "packages/core"), { recursive: true });
  await mkdir(join(cwd, "packages/ui"), { recursive: true });
  await mkdir(join(cwd, ".tegami"), { recursive: true });
  await writeFile(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`);
  await writeFile(
    join(cwd, "packages/core/package.json"),
    `${JSON.stringify(
      {
        name: "@acme/core",
        version: "1.0.0",
        publishConfig: { access: "public" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(cwd, "packages/ui/package.json"),
    `${JSON.stringify(
      {
        name: "@acme/ui",
        version: "1.0.0",
        publishConfig: { access: "public" },
      },
      null,
      2,
    )}\n`,
  );

  if (options.lock !== false) {
    await writePublishLock(cwd, {
      packages: [
        { id: "npm:@acme/core", updated: true },
        { id: "npm:@acme/ui", updated: true },
      ],
    });
  }

  return cwd;
}

type ExecResult = Awaited<ReturnType<typeof x>>;

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  } as ExecResult;
}
