import { x } from "tinyexec";
import type { PublishPlan } from "../schemas";
import type { PackageGraph } from "../workspace";
import type { NpmClient } from "../types";

export interface PublishPlanStatus {
  state: "pending" | "success" | "failed";
  error?: string;
}

export class RegistryClient {
  // package@version -> if published
  #versionMap = new Map<string, Promise<boolean>>();

  constructor(
    private readonly cwd: string,
    private readonly npmClient: NpmClient = "npm",
    private readonly graph: PackageGraph,
  ) {}

  async packageVersionExists(name: string, version: string): Promise<boolean> {
    let info = this.#versionMap.get(`${name}@${version}`);
    if (!info) {
      const run = async () => {
        const pkg = this.graph.get(name);
        const registry = pkg?.manifest.publishConfig?.registry;
        const args = ["view", `${name}@${version}`, "version", "--json"];
        if (registry) args.push("--registry", registry);

        const result = await x(this.npmClient, args, {
          nodeOptions: {
            cwd: this.cwd,
          },
        });
        if (result.exitCode === 0) return true;

        const output = commandOutput(result);
        if (isMissingRegistryEntry(output)) return false;

        throw new Error(
          `Unable to validate ${name}@${version} against the npm registry${registry ? ` "${registry}"` : ""}: ${output.trim() || `command exited with code ${result.exitCode}`}`,
        );
      };

      info = run();
      this.#versionMap.set(`${name}@${version}`, info);
    }

    return info;
  }

  async publishPlanStatus(plan: PublishPlan): Promise<PublishPlanStatus> {
    for (const pkg of plan.packages) {
      if (!pkg.publish) continue;

      try {
        const exists = await this.packageVersionExists(pkg.name, pkg.version);

        if (!exists) return { state: "pending" };
      } catch (error) {
        return {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return { state: "success" };
  }
}

function commandOutput(result: Awaited<ReturnType<typeof x>>): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function isMissingRegistryEntry(output: string): boolean {
  const normalized = output.toLowerCase();

  return (
    normalized.includes("e404") ||
    normalized.includes("404") ||
    normalized.includes("no match") ||
    normalized.includes("no matching version") ||
    normalized.includes("not found")
  );
}
