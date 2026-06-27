import path from "node:path";
import type { PackageOptions, TegamiOptions, TegamiPlugin, TegamiPluginOption } from "./types";
import { cargo } from "./providers/cargo";
import { npm } from "./providers/npm";
import { handlePluginError } from "./utils/error";
import { PackageGraph, type WorkspacePackage } from "./graph";
import type { AgentName } from "package-manager-detector";

export interface TegamiContext {
  /** absolute path */
  cwd: string;
  /** absolute path */
  changelogDir: string;
  /** absolute path */
  lockPath: string;
  options: TegamiOptions;
  plugins: TegamiPlugin[];
  graph: PackageGraph;

  /** additional context when GitHub plugin is configured */
  github?: {
    repo?: string;
    token?: string;
  };
  /** additional context when npm plugin is configured */
  npm?: {
    client: AgentName;
  };
}

export async function createTegamiContext(options: TegamiOptions = {}): Promise<TegamiContext> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const changelogDir = path.resolve(cwd, options.changelogDir ?? ".tegami");
  const graph = new PackageGraph();
  const ctx: TegamiContext = {
    cwd,
    changelogDir,
    lockPath: options.lockPath
      ? path.resolve(cwd, options.lockPath)
      : path.join(changelogDir, "publish-lock.yaml"),
    options,
    plugins: resolvePlugins([npm(options.npm), cargo(options.cargo), ...(options.plugins ?? [])]),
    graph,
  };

  for (const plugin of ctx.plugins) {
    await handlePluginError(plugin, "init", () => plugin.init?.call(ctx));
  }

  for (const plugin of ctx.plugins) {
    await handlePluginError(plugin, "resolve", () => plugin.resolve?.call(ctx));
  }

  const ignoreMatchers = options.ignore?.map((pattern): ((pkg: WorkspacePackage) => boolean) => {
    if (pattern instanceof RegExp) {
      return (pkg) => pattern.test(pkg.name) || pattern.test(pkg.id);
    }

    return (pkg) => pkg.name === pattern || pkg.id === pattern;
  });

  for (const [name, groupOptions] of Object.entries(options.groups ?? {})) {
    graph.registerGroup(name, groupOptions);
  }

  let getPackageOptions: ((pkg: WorkspacePackage) => PackageOptions | undefined) | undefined;
  if (typeof options.packages === "function") {
    getPackageOptions = options.packages;
  } else if (options.packages) {
    const packages = options.packages;
    getPackageOptions = (pkg) => packages[pkg.id] ?? packages[pkg.name];
  }

  for (const pkg of graph.getPackages()) {
    if (ignoreMatchers && ignoreMatchers.some((matcher) => matcher(pkg))) {
      graph.delete(pkg.id);
      continue;
    }

    const packageOptions = getPackageOptions?.(pkg);
    if (!packageOptions) continue;

    pkg.setPackageOptions(packageOptions);

    if (packageOptions.group) {
      graph.addGroupMember(packageOptions.group, pkg.id);
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
