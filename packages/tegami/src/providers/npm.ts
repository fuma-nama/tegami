import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import type { TegamiContext } from "../context";
import { packageManifestSchema, pnpmWorkspaceSchema, type PackageManifest } from "./npm/schema";
import type { Awaitable, TegamiPlugin } from "../types";
import { execFailure, isNodeError } from "../utils/error";
import { PackageGroup, WorkspacePackage } from "../graph";
import { detect } from "package-manager-detector";
import type { BumpType } from "../utils/semver";
import type { DraftPolicy, PackageDraft } from "../plans/draft";
import type { AgentName } from "package-manager-detector";
import z from "zod";
import type { PackagePublishResult } from "../plans/publish";
import { registerNpmCli, type TrustedPublishOptions } from "./npm/cli";
import { joinPath } from "../utils/common";

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

  get version(): string | undefined {
    return this.manifest.version;
  }

  async write(): Promise<void> {
    await writeFile(
      path.join(this.path, "package.json"),
      `${JSON.stringify(this.manifest, null, 2)}\n`,
    );
  }

  initDraft() {
    const defaults = super.initDraft();
    defaults.npm = {
      distTag: this.manifest.publishConfig?.tag,
    };

    return defaults;
  }

  getRegistry(): string {
    return this.manifest.publishConfig?.registry ?? "https://registry.npmjs.org";
  }

  configureDraft(draft: PackageDraft, group?: PackageGroup): void {
    super.configureDraft(draft, group);

    const { distTag = group?.options?.npm?.distTag } = this.getPackageOptions().npm ?? {};

    if (distTag) {
      draft.npm ??= {};
      draft.npm.distTag = distTag;
    } else if (draft.prerelease) {
      draft.npm ??= {};
      // `npm publish` requires tag for prerelease versions
      draft.npm.distTag ??= draft.prerelease;
    }
  }
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
    dependent: NpmPackage;
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

  /** update lockfile after applying a draft @default true */
  updateLockFile?: boolean;

  /** Configure `tegami npm pretrust`, disabled by default. */
  trustedPublish?: TrustedPublishOptions;
}

const packageLockSchema = z.object({
  id: z.string(),
  distTag: z.string().optional(),
});

export function npm({
  client: defaultClient,
  onBreakPeerDep = "set",
  updateLockFile = true,
  trustedPublish,
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
  let active = false;
  let client: AgentName;

  return {
    name: "npm",
    enforce: "pre",
    async init() {
      if (defaultClient) {
        client = defaultClient;
      } else {
        const result = await detect({
          cwd: this.cwd,
        });
        client = result?.name ?? "npm";
      }

      this.npm = { client };
    },
    async resolve() {
      await discoverNpmPackages(this.cwd, (pkg) => this.graph.add(pkg));
      active = this.graph.getPackages().some((pkg) => pkg instanceof NpmPackage);
    },
    async publishPreflight({ pkg }) {
      if (!(pkg instanceof NpmPackage)) return;

      return {
        shouldPublish: pkg.version !== undefined && pkg.manifest.private !== true,
      };
    },
    resolvePlanStatus({ plan }) {
      return Array.from(plan.packages, async ([id, { preflight }]) => {
        if (!preflight!.shouldPublish) return;
        const pkg = this.graph.get(id)!;

        if (!(pkg instanceof NpmPackage) || !pkg.version) return;
        if (!(await isPackagePublished(pkg.name, pkg.version, pkg.getRegistry()))) return "pending";
      });
    },
    initPublishLock({ lock, draft }) {
      for (const [id, pkg] of draft.getPackageDrafts()) {
        if (!pkg.npm) continue;

        lock.write("npm:packages", {
          id,
          distTag: pkg.npm.distTag,
        } satisfies z.input<typeof packageLockSchema>);
      }
    },
    initPublishPlan({ lock, plan }) {
      let data: unknown;

      while ((data = lock.read("npm:packages"))) {
        const parsed = packageLockSchema.safeParse(data).data;
        if (!parsed) continue;
        const packagePlan = plan.packages.get(parsed.id);
        if (!packagePlan) continue;

        packagePlan.npm = {
          distTag: parsed.distTag,
        };
      }
    },
    async publish({ pkg, plan }) {
      if (!(pkg instanceof NpmPackage)) return;

      return publish(client, pkg, plan.packages.get(pkg.id)?.npm?.distTag);
    },
    initDraft(plan) {
      if (!active) return;
      plan.addPolicy(depsPolicy(this, getBumpDepType));
    },
    async applyDraft(draft) {
      if (!active) return;

      const { graph } = this;
      const writes: Awaitable<void>[] = [];

      for (const pkg of graph.getPackages()) {
        if (!(pkg instanceof NpmPackage)) continue;
        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped) pkg.manifest.version = bumped;
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
            if (!spec.linked.version || semver.satisfies(spec.linked.version, spec.range)) continue;

            let updatedRange: string;
            const isPeer = field === "peerDependencies";
            if (isPeer && onBreakPeerDep === "ignore") {
              continue;
            }

            if (isPeer && onBreakPeerDep === "set") {
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
    async applyCliDraft() {
      if (!active || !updateLockFile) return;

      let args: string[];
      if (client === "npm") {
        args = ["ci"];
      } else if (client === "yarn") {
        args = ["install", "--immutable"];
      } else if (client === "bun") {
        args = ["install", "--frozen-lockfile"];
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
    initCli(cli) {
      if (!trustedPublish) return;

      registerNpmCli(cli, trustedPublish);
    },
  };
}

function depsPolicy(
  context: TegamiContext,
  getBumpDepType: NonNullable<NpmPluginOptions["bumpDep"]>,
): DraftPolicy {
  const { graph } = context;

  function needsUpdate(spec: DependencySpec, target: string): boolean {
    if (spec.linked && spec.protocol === "workspace") {
      switch (spec.range) {
        case "":
        case "*":
          return true;
        case "^":
        case "~":
          return !semver.satisfies(target, `${spec.range}${spec.linked.version}`);
      }
    }

    if (spec.linked && spec.protocol === "file") {
      return true;
    }

    // Ignore special syntax like "latest".
    if (spec.protocol === "file" || !semver.validRange(spec.range)) return false;
    return !semver.satisfies(target, spec.range);
  }

  return {
    id: "npm:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof NpmPackage)) return;
      const group = graph.getPackageGroup(pkg.id);

      for (const dependent of graph.getPackages()) {
        if (!(dependent instanceof NpmPackage)) continue;

        for (const field of DEP_FIELDS) {
          const dependencies = dependent.manifest[field];
          if (!dependencies) continue;

          for (const [k, v] of Object.entries(dependencies)) {
            const spec = parseDependencySpec(context, dependent, k, v);
            if (!spec || spec.linked !== pkg) continue;
            if (group?.options.syncBump && graph.getPackageGroup(dependent.id) === group) {
              // they will always bump together
              continue;
            }

            const bumped = plan.bumpVersion(pkg);
            if (!bumped || !needsUpdate(spec, bumped)) continue;

            const bumpType = getBumpDepType({ kind: field, dependent, spec, name: k });
            if (bumpType === false) continue;

            this.bumpPackage(dependent, { type: bumpType, reason: `update dependency "${k}"` });
          }
        }
      }
    },
  };
}

async function publish(
  client: AgentName,
  pkg: NpmPackage,
  distTag?: string,
): Promise<PackagePublishResult> {
  if (!pkg.version || (await isPackagePublished(pkg.name, pkg.version, pkg.getRegistry()))) {
    return { type: "skipped" };
  }

  // TODO: remove it when https://github.com/oven-sh/bun/issues/15601 is merged
  if (client === "bun") {
    // `npm publish tarball.tgz` does not run lifecycle scripts, we must run it to align with default behaviours
    for (const script of ["prepublishOnly", "prepack", "prepare"]) {
      if (!pkg.manifest.scripts?.[script]) continue;

      const result = await x("bun", ["run", script], {
        nodeOptions: {
          cwd: pkg.path,
        },
      });

      if (result.exitCode === 0) continue;

      return {
        type: "failed",
        error: execFailure(`Failed to run ${script} script for ${pkg.name}@${pkg.version}.`, result)
          .message,
      };
    }

    const tarballPath = path.resolve(pkg.path, "pkg.tgz");
    const packResult = await x("bun", ["pm", "pack", "--filename", tarballPath], {
      nodeOptions: {
        cwd: pkg.path,
      },
    });
    if (packResult.exitCode !== 0) {
      return {
        type: "failed",
        error: execFailure(`Failed to pack ${pkg.name}@${pkg.version}.`, packResult).message,
      };
    }

    const publishArgs = ["publish", tarballPath];
    if (distTag) publishArgs.push("--tag", distTag);

    const publishResult = await x("npm", publishArgs, {
      nodeOptions: {
        cwd: pkg.path,
      },
    });
    if (publishResult.exitCode !== 0) {
      return {
        type: "failed",
        error: execFailure(
          `Failed to publish ${pkg.name}@${pkg.version}${distTag ? ` with dist-tag "${distTag}"` : ""}.`,
          publishResult,
        ).message,
      };
    }
    return {
      type: "published",
    };
  }

  let command: AgentName;
  const args = ["publish"];
  if (distTag) args.push("--tag", distTag);

  if (client === "pnpm") {
    command = "pnpm";
    args.push("--no-git-checks");
  } else if (client === "yarn") {
    command = "yarn";
  } else {
    command = "npm";
  }

  const result = await x(command, args, {
    nodeOptions: {
      cwd: pkg.path,
    },
  });

  if (result.exitCode !== 0) {
    return {
      type: "failed",
      error: execFailure(
        `Failed to publish ${pkg.name}@${pkg.version}${distTag ? ` with dist-tag "${distTag}"` : ""}.`,
        result,
      ).message,
    };
  }

  return {
    type: "published",
  };
}

async function isPackagePublished(
  name: string,
  version: string,
  registry: string,
): Promise<boolean> {
  const response = await fetch(joinPath(registry, name, version), {
    headers: { Accept: "application/json" },
  });

  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `Unable to validate ${name}@${version} against the npm registry${registry ? ` "${registry}"` : ""}.`,
    );
  }

  return true;
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

  if (rootManifest?.name) {
    add(new NpmPackage(cwd, rootManifest));
  }

  for (const entry of manifests) {
    if (!entry) continue;
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
