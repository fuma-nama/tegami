import type { x } from "tinyexec";
import type { Awaitable, TegamiPlugin } from "../types";

function commandOutput(result: { stdout?: string; stderr?: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

type ExecResult = Awaited<ReturnType<typeof x>>;

export function execFailure(
  context: string,
  result: Pick<ExecResult, "exitCode" | "stdout" | "stderr">,
): Error {
  const lines = [context, `(exit ${result.exitCode})`];
  const output = commandOutput(result);
  if (output) lines.push(output);
  return new Error(lines.join("\n"));
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function handlePluginError<T>(
  plugin: TegamiPlugin,
  hookName: string,
  callback: () => Awaitable<T>,
): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Plugin "${plugin.name}" failed during ${hookName}:\n${details}`, {
      cause: error,
    });
  }
}
