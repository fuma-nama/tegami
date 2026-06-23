import type { Result } from "tinyexec";
import type { Awaitable, TegamiPlugin } from "../types";
import { isCI } from "./constants";

export class CancelledError extends Error {
  constructor() {
    super("Cancelled.");
  }
}

export function execFailure(context: string, result: Awaited<Result>): Error {
  const lines = [context, `(exit ${result.exitCode})`];
  const out = result.stdout.trim();
  const err = result.stderr.trim();
  if (out) lines.push(out);
  if (err) lines.push(err);
  return new Error(redactSensitiveTokens(lines.join("\n")));
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const SENSITIVE_TOKEN_PATTERNS = [
  /\b(npm_[a-zA-Z0-9]{36,})\b/g, // npm tokens
  /\b(gh[pousrsa]_[A-Za-z0-9_]{36,})\b/g, // GitHub tokens
  /\b(bearer\s+[a-z0-9\-_]{20,})\b/gi, // Bearer tokens
  /\b(glpat-[A-Za-z0-9-_]{20,})\b/g, // GitLab personal access tokens
];

function redactSensitiveTokens(text: string): string {
  // when running locally, allow secrets to be shown
  if (!isCI()) return text;
  let redacted = text;
  for (const pattern of SENSITIVE_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED_TOKEN]");
  }
  return redacted;
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

    throw new Error(
      `Plugin "${plugin.name}" failed during ${hookName}:\n${redactSensitiveTokens(details)}`,
      {
        cause: error,
      },
    );
  }
}
