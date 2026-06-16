import { readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { load } from "js-yaml";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import { packageManifestSchema, pnpmWorkspaceSchema, type PackageManifest } from "../schemas";
import type { Awaitable, PublishPlanStatus, RegistryClient, TegamiPlugin } from "../types";
import { execFailure, isNodeError } from "../utils/error";
import { WorkspacePackage } from "../graph";
import { detect } from "package-manager-detector";
import type { PackagePlanStore, PlanStore } from "../plans/store";

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
    return this.manifest.name!;
  }

  get version(): string {
    return this.manifest.version ?? "0.0.0";
  }

  async write(): Promise<void> {
    await writeFile(join(this.path, "package.json"), `${JSON.stringify(this.manifest, null, 2)}\n`);
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

type NpmClient = "npm" | "pnpm";

export class NpmRegistryClient implements RegistryClient {
  readonly id = "npm";

  // package@version -> if published
  #versionMap = new Map<string, Promise<boolean>>();

  constructor(
    private readonly cwd: string,
    private readonly client: NpmClient,
    private readonly graph: { get(id: string): WorkspacePackage | undefined },
  ) {}

  supports(pkg: WorkspacePackage): boolean {
    return pkg instanceof NpmPackage;
  }

  async packageVersionExists(pkg: WorkspacePackage, version: string): Promise<boolean> {
    const cacheKey = `${pkg.id}@${version}`;
    let info = this.#versionMap.get(cacheKey);
    if (!info) {
      const run = async () => {
        if (!(pkg instanceof NpmPackage)) return false;

        const registry = pkg.manifest.publishConfig?.registry;
        const args = ["view", `${pkg.name}@${version}`, "version", "--json"];
        if (registry) args.push("--registry", registry);

        const result = await x(this.client, args, {
          nodeOptions: {
            cwd: this.cwd,
          },
        });
        if (result.exitCode === 0) return true;

        const output = commandOutput(result);
        if (isMissingRegistryEntry(output)) return false;

        throw new Error(
          `Unable to validate ${pkg.name}@${version} against the npm registry${registry ? ` "${registry}"` : ""}: ${output.trim() || `command exited with code ${result.exitCode}`}`,
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
    if (this.client === "pnpm") args.push("--no-git-checks");

    const result = await x(this.client, args, {
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

  async publishPlanStatus(plan: PlanStore): Promise<PublishPlanStatus> {
    for (const [name, pkgPlan] of Object.entries(plan.packages)) {
      const pkg = this.graph.get(name);
      if (!(pkg instanceof NpmPackage) || !pkgPlan.publish) continue;

      const exists = await this.packageVersionExists(pkg, pkg.version);
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

interface NpmDependencySpec {
  name: string;
  range: string;
  protocol?: "npm" | "workspace";
}

function parseNpmDependency(rawName: string, rawRange: string): NpmDependencySpec | undefined {
  if (rawRange.startsWith("workspace:")) {
    return {
      name: rawName,
      range: rawRange.slice("workspace:".length),
      protocol: "workspace",
    };
  }

  if (rawRange.startsWith("npm:")) {
    const spec = rawRange.slice("npm:".length);
    const separator = spec.lastIndexOf("@");
    if (separator <= 0) return undefined;

    return {
      name: spec.slice(0, separator),
      range: spec.slice(separator + 1),
      protocol: "npm",
    };
  }

  return { name: rawName, range: rawRange };
}

function formatNpmDependency(spec: NpmDependencySpec): string {
  if (spec.protocol === "workspace") {
    return `workspace:${spec.range}`;
  }

  if (spec.protocol === "npm") {
    return `npm:${spec.name}@${spec.range}`;
  }

  return spec.range;
}

export interface NpmPluginOptions {
  /** Package manager command used for npm registry operations. */
  client?: NpmClient;
}

export function npm({ client: defaultClient }: NpmPluginOptions = {}): TegamiPlugin {
  let client: NpmClient;

  function updateRange(spec: NpmDependencySpec, next: semver.SemVer): string | false {
    // Ignore special syntax like "latest".
    if (!semver.validRange(spec.range)) return false;
    const range = new semver.Range(spec.range);
    if (range.test(next)) return false;

    spec.range = next.format();
    return formatNpmDependency(spec);
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
    async applyPlan(draft) {
      const { graph } = this;
      const bumpedPackages = new Map<NpmPackage, { $updateVersion: string | null }>();
      const writes: Awaitable<void>[] = [];

      function bumpDeps(pkg: NpmPackage) {
        const existing = bumpedPackages.get(pkg);
        if (existing) return existing;

        for (const field of DEP_FIELDS) {
          const dependencies = pkg.manifest[field];
          if (!dependencies) continue;

          for (const [k, v] of Object.entries(dependencies)) {
            const spec = parseNpmDependency(k, v);
            if (!spec) continue;

            const linked = graph.get(`npm:${spec.name}`);
            if (!linked || !(linked instanceof NpmPackage)) continue;
            const next = semver.parse(bumpDeps(linked).$updateVersion);
            if (!next) continue;

            const result = updateRange(spec, next);
            if (result === false) continue;

            dependencies[k] = result;

            // TODO: allow user config
            draft.bumpPackage(pkg, { type: "patch", reason: `update dependency "${k}"` });
          }
        }

        const bumpedVersion = draft.getPackagePlan(pkg.id)?.bumpVersion(pkg);
        const result = {
          $updateVersion: bumpedVersion && bumpedVersion !== pkg.version ? bumpedVersion : null,
        };

        bumpedPackages.set(pkg, result);
        if (result.$updateVersion) {
          pkg.manifest.version = result.$updateVersion;
        }

        writes.push(pkg.write());
        return result;
      }

      for (const pkg of graph.getPackages()) {
        if (pkg instanceof NpmPackage) bumpDeps(pkg);
      }

      await Promise.all(writes);
    },
  };
}

async function discoverNpmPackages(cwd: string, add: (pkg: NpmPackage) => void): Promise<void> {
  let patterns: string[];
  const rootManifest = await readManifest(cwd).catch(() => undefined);
  const pnpmPatterns = await readFile(join(cwd, "pnpm-workspace.yaml"), "utf8")
    .then((content) => pnpmWorkspaceSchema.parse(load(content) ?? {}))
    .catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });

  if (pnpmPatterns) {
    patterns = pnpmPatterns.packages ?? ["."];
  } else {
    patterns = rootManifest?.workspaces ?? ["."];
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
  const paths = patterns.includes(".") ? [cwd] : [];
  const globPatterns = patterns.filter((pattern) => pattern !== ".");

  if (globPatterns.length > 0) {
    paths.push(
      ...(await glob(globPatterns, {
        absolute: true,
        cwd,
        ignore: ["**/node_modules/**"],
        onlyDirectories: true,
        onlyFiles: false,
      })),
    );
  }

  return paths.map(normalize);
}

async function readManifest(packagePath: string): Promise<PackageManifest> {
  const content = await readFile(join(packagePath, "package.json"), "utf8");
  const parsed = JSON.parse(content);

  // validation only
  packageManifestSchema.parse(parsed);
  return parsed;
}
