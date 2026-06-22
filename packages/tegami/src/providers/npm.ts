import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import { packageManifestSchema, pnpmWorkspaceSchema, type PackageManifest } from "../schemas";
import type { Awaitable, RegistryClient, TegamiPlugin } from "../types";
import { execFailure, isNodeError } from "../utils/error";
import { PackageGraph, WorkspacePackage } from "../graph";
import { detect } from "package-manager-detector";
import type { PackagePlanStore, PlanStore } from "../plans/store";
import type { BumpType } from "../utils/semver";
import type { PlanPolicy } from "../plans/draft";
import type { AgentName } from "package-manager-detector";

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export class NpmPackage extends WorkspacePackage {
  readonly manager = "npm";

  constructor(
    readonly path: string,
    readonly manifest: PackageManifest,
  ) {
    super();
  }

  get name(): string {
    return this.manifest.name;
  }

  get version(): string {
    return this.manifest.version ?? "0.0.0";
  }

  async write(): Promise<void> {
    await writeFile(
      path.join(this.path, "package.json"),
      `${JSON.stringify(this.manifest, null, 2)}\n`,
    );
  }

  onPlan(context: TegamiContext) {
    const defaults = super.onPlan(context);
    defaults.publish ??= this.manifest.private !== true;

    if (this.manifest.publishConfig?.tag) {
      defaults.npm ??= {};
      defaults.npm.distTag ??= this.manifest.publishConfig.tag;
    }

    return defaults;
  }
}

export class NpmRegistryClient implements RegistryClient {
  readonly id = "npm";

  // package@version -> if published
  #versionMap = new Map<string, Promise<boolean>>();

  constructor(
    private readonly cwd: string,
    private readonly client: AgentName,
    _graph: PackageGraph,
  ) {}

  supports(pkg: WorkspacePackage): boolean {
    return pkg instanceof NpmPackage;
  }

  async isPackagePublished(pkg: NpmPackage): Promise<boolean> {
    const cacheKey = `${pkg.id}@${pkg.version}`;
    let info = this.#versionMap.get(cacheKey);
    if (!info) {
      const run = async () => {
        const registry = pkg.manifest.publishConfig?.registry;
        const args = ["view", `${pkg.name}@${pkg.version}`, "version", "--json"];
        if (registry) args.push("--registry", registry);

        const client = this.client === "pnpm" ? "pnpm" : "npm";
        const result = await x(client, args, {
          nodeOptions: {
            cwd: this.cwd,
          },
        });
        if (result.exitCode === 0) return true;

        const output = commandOutput(result);
        if (isMissingRegistryEntry(output)) return false;

        throw execFailure(
          `Unable to validate ${pkg.name}@${pkg.version} against the npm registry${registry ? ` "${registry}"` : ""}.`,
          result,
        );
      };

      info = run();
      this.#versionMap.set(cacheKey, info);
    }

    return info;
  }

  async publish(
    pkg: NpmPackage,
    { packageStore }: { store: PlanStore; packageStore: PackagePlanStore },
  ) {
    const args = ["publish"];
    const distTag = packageStore.npm?.distTag;
    if (distTag) args.push("--tag", distTag);
    const client = this.client === "pnpm" ? "pnpm" : "npm";

    if (client === "pnpm") args.push("--no-git-checks");
    const result = await x(client, args, {
      nodeOptions: {
        cwd: pkg.path,
      },
    });
    if (result.exitCode !== 0) {
      throw execFailure(
        `Failed to publish ${pkg.name}@${pkg.version}${distTag ? ` with dist-tag "${distTag}"` : ""}.`,
        result,
      );
    }
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

type DependencySpec =
  | {
      protocol: "npm";
      alias: string;
      range: string;
      linked?: WorkspacePackage;
    }
  | {
      protocol: "workspace";
      range: string;
      linked?: WorkspacePackage;
    }
  | {
      protocol: "file";
      raw: string;
      linked?: WorkspacePackage;
    }
  | {
      range: string;
      linked?: WorkspacePackage;
      protocol?: undefined;
    };

function parseDependencySpec(
  context: TegamiContext,
  dependent: NpmPackage,
  name: string,
  range: string,
): DependencySpec | undefined {
  const { graph } = context;

  if (range.startsWith("workspace:")) {
    return {
      range: range.slice("workspace:".length),
      linked: graph.get(`npm:${name}`),
      protocol: "workspace",
    };
  }

  if (range.startsWith("file:")) {
    let target = path.resolve(dependent.path, range.slice("file:".length));
    if (path.basename(target) === "package.json") {
      target = path.dirname(target);
    }

    return {
      protocol: "file",
      raw: range,
      linked: graph.getPackages().find((pkg) => pkg instanceof NpmPackage && pkg.path === target),
    };
  }

  if (range.startsWith("npm:")) {
    const spec = range.slice("npm:".length);
    const separator = spec.lastIndexOf("@");
    if (separator <= 0) return;
    const alias = spec.slice(0, separator);

    return {
      alias,
      linked: graph.get(`npm:${alias}`),
      range: spec.slice(separator + 1),
      protocol: "npm",
    };
  }

  return { linked: graph.get(`npm:${name}`), range: range };
}

function formatDependencySpec(spec: DependencySpec): string {
  if (spec.protocol === "workspace") {
    return `workspace:${spec.range}`;
  }

  if (spec.protocol === "file") {
    return spec.raw;
  }

  if (spec.protocol === "npm") {
    return `npm:${spec.alias}@${spec.range}`;
  }

  return spec.range;
}

export interface NpmPluginOptions {
  /** Package manager command used for npm registry operations. */
  client?: AgentName;

  /**
   * Decide how to bump the dependents of a bumped package.
   */
  bumpDep?: (opts: {
    kind: (typeof DEP_FIELDS)[number];
    name: string;
    spec: DependencySpec;
  }) => BumpType | false;

  /**
   * What to do when a workspace dependency's version has gone beyond peer dependency constraints:
   *
   * - `set` (default): set to the current version (won't preserve prefix).
   * - `error`: throw error.
   * - `ignore`: do nothing.
   *
   * Note: `workspace:` protocols are not included.
   */
  onBreakPeerDep?: "set" | "error" | "ignore";

  /** update lockfile after appling publish plan */
  updateLockFile?: boolean;
}

export function npm({
  client: defaultClient,
  onBreakPeerDep = "set",
  updateLockFile = false,
  bumpDep: getBumpDepType = ({ kind }) => {
    switch (kind) {
      case "dependencies":
      case "optionalDependencies":
        return "patch";
      case "devDependencies":
        return false;
      case "peerDependencies":
        if (onBreakPeerDep === "ignore") return false;
        return "major";
    }
  },
}: NpmPluginOptions = {}): TegamiPlugin {
  let client: AgentName;

  function depsPolicy(context: TegamiContext): PlanPolicy {
    const { graph } = context;

    function needsUpdate(dependent: NpmPackage, spec: DependencySpec, target: string): boolean {
      if (spec.linked) {
        const group = graph.getPackageGroup(dependent.id);

        if (group?.options.syncBump && graph.getPackageGroup(spec.linked.id) === group) {
          // they will always bump together
          return false;
        }

        if (spec.protocol === "workspace") {
          switch (spec.range) {
            case "":
            case "*":
              return true;
            case "^":
            case "~":
              return !semver.satisfies(target, `${spec.range}${spec.linked.version}`);
          }
        }

        if (spec.protocol === "file") {
          return true;
        }
      }

      // Ignore special syntax like "latest".
      if (spec.protocol === "file" || !semver.validRange(spec.range)) return false;
      return !semver.satisfies(target, spec.range);
    }

    return {
      id: "npm:deps",
      onUpdate({ pkg, plan }) {
        if (!(pkg instanceof NpmPackage)) return;

        for (const dependent of graph.getPackages()) {
          if (!(dependent instanceof NpmPackage)) continue;

          for (const field of DEP_FIELDS) {
            const dependencies = dependent.manifest[field];
            if (!dependencies) continue;

            for (const [k, v] of Object.entries(dependencies)) {
              const spec = parseDependencySpec(context, dependent, k, v);
              if (!spec || spec.linked !== pkg) continue;
              if (!needsUpdate(dependent, spec, plan.bumpVersion(pkg))) continue;

              const bumpType = getBumpDepType({ kind: field, spec, name: k });
              if (bumpType === false) continue;

              this.bumpPackage(dependent, { type: bumpType, reason: `update dependency "${k}"` });
            }
          }
        }
      },
    };
  }

  return {
    name: "npm",
    enforce: "pre",
    async init() {
      if (defaultClient) {
        client = defaultClient;
        return;
      }

      const result = await detect({
        cwd: this.cwd,
      });
      if (result?.name === "pnpm") client = "pnpm";
      else client = "npm";
    },
    async resolve() {
      await discoverNpmPackages(this.cwd, (pkg) => this.graph.add(pkg));
    },
    createRegistryClient() {
      return new NpmRegistryClient(this.cwd, client, this.graph);
    },
    initPlan(plan) {
      plan.addPolicy(depsPolicy(this));
    },
    async applyPlan(draft) {
      const { graph } = this;
      const writes: Awaitable<void>[] = [];

      for (const pkg of graph.getPackages()) {
        if (!(pkg instanceof NpmPackage)) continue;
        const plan = draft.getPackagePlan(pkg.id);
        if (plan) {
          pkg.manifest.version = plan.bumpVersion(pkg);
        }
      }

      for (const pkg of graph.getPackages()) {
        if (!(pkg instanceof NpmPackage)) continue;

        for (const field of DEP_FIELDS) {
          const dependencies = pkg.manifest[field];
          if (!dependencies) continue;

          for (const [k, v] of Object.entries(dependencies)) {
            const spec = parseDependencySpec(this, pkg, k, v);

            if (!spec?.linked || spec.protocol === "workspace" || spec.protocol === "file")
              continue;
            // Ignore special syntax like "latest"
            if (!semver.validRange(spec.range)) continue;
            if (semver.satisfies(spec.linked.version, spec.range)) continue;

            let updatedRange: string;
            const isPeer = field === "peerDependencies";
            if (isPeer && onBreakPeerDep === "ignore") {
              continue;
            } else if (isPeer && onBreakPeerDep === "set") {
              updatedRange = spec.linked.version;
            } else if (isPeer && onBreakPeerDep === "error") {
              throw new Error(
                `[Tegami] the version of "${spec.linked.name}" is beyond its peer dependency constraint "${v}" in package "${pkg.name}", please update the constraint to satisfy.`,
              );
            } else if (spec.range.startsWith("^")) {
              updatedRange = `^${spec.linked.version}`;
            } else if (spec.range.startsWith("~")) {
              updatedRange = `~${spec.linked.version}`;
            } else {
              updatedRange = spec.linked.version;
            }

            dependencies[k] = formatDependencySpec({ ...spec, range: updatedRange });
          }
        }

        writes.push(pkg.write());
      }

      await Promise.all(writes);
    },
    cli: {
      async publishPlanApplied() {
        if (!updateLockFile) return;

        let args: string[];
        if (client === "npm") {
          args = ["ci"];
        } else if (client === "yarn") {
          args = ["install", "--immutable"];
        } else {
          args = ["install", "--frozen-lockfile"];
        }

        const result = await x(client, args, {
          nodeOptions: {
            cwd: this.cwd,
          },
        });
        if (result.exitCode !== 0) {
          throw execFailure("Failed to update lockfile.", result);
        }
      },
    },
  };
}

async function discoverNpmPackages(cwd: string, add: (pkg: NpmPackage) => void): Promise<void> {
  let patterns: string[];
  const rootManifest = await readManifest(cwd).catch(() => undefined);
  const pnpmPatterns = await readFile(path.join(cwd, "pnpm-workspace.yaml"), "utf8")
    .then((content) => pnpmWorkspaceSchema.parse(load(content) ?? {}))
    .catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });

  if (pnpmPatterns) {
    patterns = pnpmPatterns.packages ?? [];
  } else {
    patterns = rootManifest?.workspaces ?? [];
  }

  const candidatePaths = await expandWorkspacePatterns(cwd, patterns);
  const manifests = await Promise.all(
    candidatePaths.map((path) =>
      readManifest(path)
        .then((manifest) => ({ path, manifest }))
        .catch(() => undefined),
    ),
  );

  if (rootManifest) {
    add(new NpmPackage(cwd, rootManifest));
  }

  for (const entry of manifests) {
    if (!entry?.manifest) continue;
    add(new NpmPackage(entry.path, entry.manifest));
  }
}

async function expandWorkspacePatterns(cwd: string, patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];

  const results = await glob(patterns, {
    absolute: true,
    cwd,
    ignore: ["**/node_modules/**", "**/dist/**"],
    onlyDirectories: true,
    onlyFiles: false,
  });

  return results.map((item) => {
    return item.endsWith(path.sep) ? item.slice(0, -1) : item;
  });
}

async function readManifest(packagePath: string): Promise<PackageManifest> {
  const content = await readFile(path.join(packagePath, "package.json"), "utf8");
  const parsed = JSON.parse(content);

  // validation only
  packageManifestSchema.parse(parsed);
  return parsed;
}
