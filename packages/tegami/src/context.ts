import { join, resolve } from "node:path";
import { detect } from "package-manager-detector";
import type { NpmClient, TegamiOptions } from "./types";
import { NpmRegistryClient, type RegistryClient } from "./utils/registry";
import { discoverWorkspace, type PackageGraph } from "./workspace";

export interface TegamiContext {
  cwd: string;
  changelogDir: string;
  planPath: string;
  options: TegamiOptions;
  graph: PackageGraph;
  registryClient: RegistryClient;
}

export async function createTegamiContext(options: TegamiOptions = {}): Promise<TegamiContext> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const npmClient = options.npmClient ?? (await resolveNpmClient(cwd));
  const graph = await discoverWorkspace(cwd);
  const registryClient = new NpmRegistryClient(cwd, npmClient, graph);

  return {
    cwd,
    changelogDir: options.changelogDir ?? ".tegami",
    planPath: resolve(cwd, options.planPath ?? join(".tegami", "publish-plan.json")),
    options,
    graph,
    registryClient,
  };
}

async function resolveNpmClient(cwd: string): Promise<NpmClient> {
  const result = await detect({
    cwd,
  });

  if (result?.name === "pnpm") return "pnpm";
  return "npm";
}
