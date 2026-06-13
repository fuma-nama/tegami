import { join, resolve } from "node:path";
import { detect } from "package-manager-detector";
import type { PublishOptions } from "./publish";
import type { NpmClient, TegamiOptions } from "./types";
import { RegistryClient } from "./utils/registry";
import { discoverWorkspace, type PackageGraph } from "./workspace";
import { ChangelogEntry } from "./schemas";

export interface TegamiContext {
  cwd: string;
  changelogDir: string;
  planPath: string;
  options: TegamiOptions;
  publish: Required<Pick<PublishOptions, "dryRun">> & PublishOptions;
  npmClient: NpmClient;
  graph: PackageGraph;
  registryClient: RegistryClient;
}

export async function createTegamiContext(options: TegamiOptions = {}): Promise<TegamiContext> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const publish = {
    ...options.publish,
    dryRun: options.publish?.dryRun ?? false,
  };
  const npmClient = await resolveNpmClient(cwd, publish.npmClient);
  const graph = await discoverWorkspace(cwd);
  const registryClient = new RegistryClient(cwd, npmClient, graph);

  return {
    cwd,
    changelogDir: options.changelogDir ?? ".tegami",
    planPath: resolve(cwd, options.planPath ?? join(".tegami", "publish-plan.json")),
    options,
    publish,
    npmClient,
    graph,
    registryClient,
  };
}

export function filterChangelogsByIds(all: ChangelogEntry[], ids: Set<string>): ChangelogEntry[] {
  return all.filter((entry) => ids.has(entry.id));
}

async function resolveNpmClient(cwd: string, npmClient: NpmClient | undefined): Promise<NpmClient> {
  if (npmClient) return npmClient;

  const result = await detect({
    cwd,
  });

  if (result?.name === "pnpm") return "pnpm";
  return "npm";
}
