import type { Result } from "tinyexec";
import type { Awaitable, TegamiPlugin } from "../types";

export function execFailure(
  context: string,
  result: Pick<Awaited<Result>, "exitCode" | "stdout" | "stderr">,
): Error {
  const lines = [context, `(exit ${result.exitCode})`];
  const out = result.stdout.trim();
  const err = result.stderr.trim();
  if (out) lines.push(out);
  if (err) lines.push(err);
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
