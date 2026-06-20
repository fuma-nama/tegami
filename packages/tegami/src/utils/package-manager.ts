import { detect, resolveCommand } from "package-manager-detector";
import type { AgentName } from "package-manager-detector";

export async function formatRunScriptCommand(
  cwd: string,
  script: string,
  agent?: AgentName,
): Promise<string> {
  const resolvedAgent = agent ?? (await detect({ cwd }))?.agent ?? "npm";
  const resolved = resolveCommand(resolvedAgent, "run", [script]);

  if (!resolved) return `npm run ${script}`;

  return [resolved.command, ...resolved.args].join(" ");
}
