import { x } from "tinyexec";
import type { PackageGraph } from "../workspace";
import type { NpmClient } from "../types";
import type { PlanStore } from "../schemas";

export interface PublishPlanStatus {
  state: "pending" | "success";
  error?: string;
}

export interface RegistryClient {
  packageVersionExists(name: string, version: string): Promise<boolean>;
  publish(pkg: { path: string; distTag?: string }): Promise<void>;
  publishPlanStatus(plan: PlanStore): Promise<PublishPlanStatus>;
}

export class NpmRegistryClient implements RegistryClient {
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

  async publish(pkg: { path: string; distTag?: string }) {
    const args = ["publish"];
    if (pkg.distTag) args.push("--tag", pkg.distTag);

    await x(this.npmClient, args, {
      nodeOptions: {
        cwd: pkg.path,
      },
      throwOnError: true,
    });
  }

  async publishPlanStatus(plan: PlanStore): Promise<PublishPlanStatus> {
    for (const [name, pkgPlan] of Object.entries(plan.packages)) {
      const pkg = this.graph.get(name);
      if (!pkg || !pkgPlan.publish || !pkg.manifest.version) continue;

      const exists = await this.packageVersionExists(name, pkg.manifest.version);
      if (!exists) return { state: "pending" };
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
