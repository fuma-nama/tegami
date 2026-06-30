import { beforeEach, describe, expect, test, vi } from "vitest";
import { x } from "tinyexec";
import { hasGitChanges } from "../src/utils/version-request";

vi.mock("tinyexec", () => ({
  x: vi.fn(),
}));

const exec = vi.mocked(x);

beforeEach(() => {
  exec.mockReset();
});

describe("hasGitChanges", () => {
  test("returns whether git status has output", async () => {
    exec.mockResolvedValueOnce(execResult({ stdout: " M package.json\n" }));

    await expect(hasGitChanges("/repo")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"], {
      nodeOptions: { cwd: "/repo" },
    });
  });

  test("throws when git status fails", async () => {
    exec.mockResolvedValueOnce(execResult({ exitCode: 128, stderr: "fatal: not a git repository" }));

    await expect(hasGitChanges("/repo")).rejects.toThrow("Failed to check for git changes.");
  });
});

type ExecResult = Awaited<ReturnType<typeof x>>;

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  } as ExecResult;
}
