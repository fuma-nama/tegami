import path from "node:path";
import type { TegamiOptions, RegistryClient, TegamiPlugin, TegamiPluginOption } from "./types";
import { cargo } from "./providers/cargo";
import { npm } from "./providers/npm";
import { handlePluginError } from "./utils/error";
import { PackageGraph, type WorkspacePackage } from "./graph";

export interface TegamiContext {
  cwd: string;
  changelogDir: string;
  planPath: string;
  options: TegamiOptions;
  plugins: TegamiPlugin[];
  graph: PackageGraph;
  /** error if doesn't exist */
  getRegistryClient(pkgOrId: WorkspacePackage | string): RegistryClient;
}

export async function createTegamiContext(options: TegamiOptions = {}): Promise<TegamiContext> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const changelogDir = path.resolve(cwd, options.changelogDir ?? ".tegami");
  const graph = new PackageGraph();
  const registryClients = new Map<string, RegistryClient>();
  const ctx: TegamiContext = {
    cwd,
    changelogDir,
    planPath: options.planPath
      ? path.resolve(cwd, options.planPath)
      : path.join(changelogDir, "publish-plan"),
    options,
    plugins: resolvePlugins([npm(options.npm), cargo(options.cargo), ...(options.plugins ?? [])]),
    graph,
    getRegistryClient(pkgOrId) {
      let client: RegistryClient | undefined;

      if (typeof pkgOrId === "string") {
        client = registryClients.get(pkgOrId);
      } else {
        for (const item of registryClients.values()) {
          if (item.supports && item.supports(pkgOrId)) {
            client = item;
            break;
          }
        }
      }

      if (!client) {
        const id = typeof pkgOrId === "string" ? pkgOrId : pkgOrId.manager;
        throw new Error(`No registry client is available for ${id}.`);
      }

      return client;
    },
  };

  for (const plugin of ctx.plugins) {
    await handlePluginError(plugin, "init", () => plugin.init?.call(ctx));
  }

  for (const plugin of ctx.plugins) {
    await handlePluginError(plugin, "resolve", () => plugin.resolve?.call(ctx));
  }

  for (const [name, groupOptions] of Object.entries(options.groups ?? {})) {
    graph.registerGroup(name, groupOptions);
  }

  for (const pkg of graph.getPackages()) {
    const packageOptions = options.packages?.[pkg.id] ?? options.packages?.[pkg.name];
    if (!packageOptions) continue;

    pkg.setPackageOptions(packageOptions);

    if (packageOptions.group) {
      graph.addGroupMember(packageOptions.group, pkg.id);
    }
  }

  for (const plugin of ctx.plugins) {
    const clients = await handlePluginError(plugin, "createRegistryClient", () =>
      plugin.createRegistryClient?.call(ctx),
    );
    if (!clients) continue;

    for (const client of Array.isArray(clients) ? clients : [clients]) {
      registryClients.set(client.id, client);
    }
  }

  return ctx;
}

const PLUGIN_ORDER = {
  pre: 0,
  default: 1,
  post: 2,
};

function resolvePlugins(plugins: TegamiPluginOption[] = []): TegamiPlugin[] {
  return (plugins as TegamiPlugin[])
    .flat(Infinity)
    .sort((a, b) => PLUGIN_ORDER[a.enforce ?? "default"] - PLUGIN_ORDER[b.enforce ?? "default"]);
}
