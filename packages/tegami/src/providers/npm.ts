import { readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { load } from "js-yaml";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import {
  packageManifestSchema,
  pnpmWorkspaceSchema,
  type PackageManifest,
  type PlanStore,
} from "../schemas";
import type {
  PublishPlanStatus,
  RegistryClient,
  DependencySpec,
  Awaitable,
  TegamiPlugin,
} from "../types";
import { execFailure, isNodeError } from "../utils/error";
import { WorkspacePackage } from "../graph";
import { detect } from "package-manager-detector";

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

  get publish(): boolean {
    return this.manifest.private !== true;
  }

  get distTag(): string | undefined {
    return this.manifest.publishConfig?.tag;
  }

  setVersion(version: string): void {
    this.manifest.version = version;
  }

  async updateDependency(target: WorkspacePackage, version: string, context: TegamiContext) {
    if (!(target instanceof NpmPackage)) return;

    const next = semver.parse(version);
    if (!next) return;

    for (const field of DEP_FIELDS) {
      const dependencies = this.manifest[field];
      if (!dependencies) continue;

      for (const [rawName, rawRange] of Object.entries(dependencies)) {
        const spec = parseNpmDependency(rawName, rawRange);
        if (!spec || spec.name !== target.name) continue;

        dependencies[rawName] = formatNpmDependency(await this.updateRange(context, spec, next));
      }
    }
  }

  async write(): Promise<void> {
    await writeFile(join(this.path, "package.json"), `${JSON.stringify(this.manifest, null, 2)}\n`);
  }
}

export type NpmClient = "npm" | "pnpm";

interface NpmDependencySpec extends DependencySpec {
  protocol?: "npm" | "workspace";
}

export class NpmRegistryClient implements RegistryClient {
  readonly id = "npm";

  // package@version -> if published
  #versionMap = new Map<string, Promise<boolean>>();
  #resolvedClient: Awaitable<NpmClient> | undefined;

  constructor(
    private readonly cwd: string,
    private readonly npmClient: NpmClient | undefined = undefined,
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

        const result = await x(await this.resolveClient(), args, {
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

  async publish(pkg: WorkspacePackage, options: { distTag?: string } = {}) {
    const client = await this.resolveClient();
    const args = ["publish"];
    const distTag = options.distTag ?? pkg.distTag;
    if (distTag) args.push("--tag", distTag);
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

  async publishPlanStatus(plan: PlanStore): Promise<PublishPlanStatus> {
    for (const [name, pkgPlan] of Object.entries(plan.packages)) {
      const pkg = this.graph.get(name);
      if (!(pkg instanceof NpmPackage) || !pkgPlan.publish) continue;

      const exists = await this.packageVersionExists(pkg, pkg.version);
      if (!exists) return { state: "pending" };
    }

    return { state: "success" };
  }

  private resolveClient(): Awaitable<NpmClient> {
    if (!this.#resolvedClient) {
      this.#resolvedClient =
        this.npmClient ??
        detect({
          cwd: this.cwd,
        }).then((result) => {
          if (result?.name === "pnpm") return "pnpm";
          return "npm";
        });
    }

    return this.#resolvedClient;
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

function formatNpmDependency(spec: DependencySpec): string {
  const npmSpec = spec as NpmDependencySpec;
  if (npmSpec.protocol === "workspace") {
    return `workspace:${spec.range}`;
  }

  if (npmSpec.protocol === "npm") {
    return `npm:${spec.name}@${spec.range}`;
  }

  return spec.range;
}

export function npm(client?: NpmClient): TegamiPlugin {
  return {
    name: "npm",
    enforce: "pre",
    async resolve() {
      await discoverNpmPackages(this.cwd, (pkg) => this.graph.add(pkg));
    },
    createRegistryClient() {
      return new NpmRegistryClient(this.cwd, client, this.graph);
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
