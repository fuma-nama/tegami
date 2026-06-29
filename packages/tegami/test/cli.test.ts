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

    await createCli(tegami({ cwd, plugins: [github(), gitlab()] })).parseAsync(["--help"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("pr preview"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("mr preview"));
  });

  test("prints generated group help", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tegami-cli-group-help-"));
    tempDirs.push(cwd);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createCli(tegami({ cwd, plugins: [github()] })).parseAsync(["pr"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage: pr"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("GitHub pull request commands"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("pr comment <artifact>"));
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
