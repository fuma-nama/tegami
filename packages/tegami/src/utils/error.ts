import type { x } from "tinyexec";

function commandOutput(result: { stdout?: string; stderr?: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

type ExecResult = Awaited<ReturnType<typeof x>>;

export function execFailure(
  context: string,
  result: Pick<ExecResult, "exitCode" | "stdout" | "stderr">,
): string {
  const lines = [context, `(exit ${result.exitCode})`];
  const output = commandOutput(result);
  if (output) lines.push(output);
  return lines.join("\n");
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
