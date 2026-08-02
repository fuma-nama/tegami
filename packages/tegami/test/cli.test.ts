import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { tegami } from "../src";
import { createCli } from "../src/cli";
import { github } from "../src/plugins/github";
import { gitlab } from "../src/plugins/gitlab";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("cli registry", () => {
  test("prints plugin commands in root help", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-cli-help-"));
    tempDirs.push(cwd);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createCli(
      tegami({
        cwd,
        npm: { trustedPublish: { provider: "github", workflow: "publish.yml" } },
        plugins: [github(), gitlab()],
      }),
    ).parseAsync(["--help"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("pr preview"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("mr preview"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("npm pretrust"));
  });

  test("prints command options in subcommand help", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-cli-command-help-"));
    tempDirs.push(cwd);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createCli(tegami({ cwd, plugins: [gitlab()] })).parseAsync(["mr", "preview", "--help"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage: mr preview"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("--artifact <value>"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("--number <value>"));
  });

  test("parses string options that do not define short flags", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-cli-string-option-"));
    tempDirs.push(cwd);
    const action = vi.fn(async (_values: { artifact?: string }) => {});

    await createCli(
      tegami({
        cwd,
        plugins: [
          {
            name: "test",
            initCli(cli) {
              cli
                .command("test cmd", { resolve: false })
                .option("artifact", {
                  type: "string",
                  description: "output file",
                })
                .action(({ values }) => action(values));
            },
          },
        ],
      }),
    ).parseAsync(["test", "cmd", "--artifact", "preview.md"]);

    expect(action).toHaveBeenCalledWith({ artifact: "preview.md" });
  });

  test("reports every publish task failure and exits with code 1", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-cli-publish-"));
    tempDirs.push(cwd);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;

    try {
      await createCli(tegami({ cwd }), {
        publish() {
          throw new AggregateError(
            [new Error("Failed to publish @acme/core"), new Error("Failed to publish @acme/ui")],
            "2 publish tasks failed.",
          );
        },
      }).parseAsync(["publish"]);

      const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(output).toContain("Failed to publish @acme/core");
      expect(output).toContain("Failed to publish @acme/ui");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test("runs the registered root command without argv", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-cli-root-"));
    tempDirs.push(cwd);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createCli(tegami({ cwd })).parseAsync(["--help"]);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("create changelog files interactively"),
    );
  });
});
