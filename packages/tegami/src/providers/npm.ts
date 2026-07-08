import path from "node:path";
import * as semver from "semver";
import { x } from "tinyexec";
import { detect, type AgentName } from "package-manager-detector";
import typia from "typia";
import type { TegamiContext } from "../context";
import type { PackagePublishResult } from "../plans/publish";
import type { Awaitable, TegamiPlugin } from "../types";
import { execFailure, fetchFailure } from "../utils/error";
import type { BumpType } from "../utils/semver";
import type { DraftPolicy } from "../plans/draft";
import { registerNpmCli, type TrustedPublishOptions } from "./npm/cli";
import { joinPath } from "../utils/common";
import {
  type DependencySpec,
  type DepField,
  formatDependencySpec,
  NpmPackage,
  type ResolvedNpmDependency,
  resolveNpmGraph,
} from "./npm/graph";

export { type NpmGraph, type DependencySpec, NpmPackage } from "./npm/graph";

interface DependentRef {
  dependent: NpmPackage;
  kind: DepField;
  name: string;
  spec: DependencySpec;
  resolved: ResolvedNpmDependency;
}

export interface NpmPluginOptions {
  /** Package manager command used for npm registry operations. */
  client?: AgentName;

  /**
   * Decide how to bump the dependents of a bumped package.
   */
  bumpDep?: (opts: DependentRef) => BumpType | false;

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

interface NpmPackageLock {
  id: string;
  distTag?: string;
}

interface NpmMarkLatestLock {
  id: string;
}

const validateNpmPackageLock: (input: unknown) => typia.IValidation<NpmPackageLock> =
  typia.createValidate<NpmPackageLock>();
const validateNpmMarkLatestLock: (input: unknown) => typia.IValidation<NpmMarkLatestLock> =
  typia.createValidate<NpmMarkLatestLock>();

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
  return {
    name: "npm",
    async init() {
      if (defaultClient) {
        this.npm = { client: defaultClient, agent: defaultClient };
      } else {
        const result = await detect({ cwd: this.cwd });
        this.npm = { client: result?.name ?? "npm", agent: result?.agent ?? "npm" };
      }
    },
    async resolve() {
      if (!this.npm) return;
      const graph = await resolveNpmGraph(this.cwd, this.npm.client);
      if (graph.packages.size === 0) return;

      this.npm.graph = graph;
      for (const pkg of graph.packages.values()) this.graph.add(pkg);
    },
    async publishPreflight({ pkg }) {
      if (!(pkg instanceof NpmPackage) || !this.npm?.graph) return;

      const optionalWait: string[] = [];
      for (const { linked } of pkg.listDependencies(this.npm.graph)) {
        if (linked) optionalWait.push(linked.id);
      }

      return {
        shouldPublish: pkg.version !== undefined && pkg.manifest.private !== true,
        optionalWait: optionalWait.length > 0 ? optionalWait : undefined,
      };
    },
    resolvePlanStatus({ plan }) {
      if (!this.npm?.graph) return;

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
        } satisfies NpmPackageLock);
      }
    },
    initPublishPlan({ lock, plan }) {
      let data: unknown;

      while ((data = lock.read("npm:packages"))) {
        const validated = validateNpmPackageLock(data);
        if (!validated.success) continue;
        const parsed = validated.data;
        const packagePlan = plan.packages.get(parsed.id);
        if (!packagePlan) continue;

        packagePlan.npm = { distTag: parsed.distTag };
      }

      while ((data = lock.read("npm:mark-latest"))) {
        const validated = validateNpmMarkLatestLock(data);
        if (!validated.success) continue;
        const parsed = validated.data;
        const packagePlan = plan.packages.get(parsed.id);
        if (!packagePlan) continue;

        packagePlan.npm ??= {};
        packagePlan.npm.markLatest = true;
      }
    },
    async publish({ pkg, plan }) {
      if (!(pkg instanceof NpmPackage) || !this.npm) return;
      const { distTag, markLatest } = plan.packages.get(pkg.id)?.npm ?? {};

      const result = await publish(this.npm.client, pkg, distTag);
      if (result.type === "published" && markLatest) {
        const tagResult = await x(
          "npm",
          [
            "dist-tag",
            "add",
            `${pkg.name}@${pkg.version}`,
            "latest",
            "--registry",
            pkg.getRegistry(),
          ],
          { nodeOptions: { cwd: pkg.path } },
        );

        if (tagResult.exitCode !== 0) {
          return {
            type: "failed",
            error: execFailure("Failed to mark package as latest", tagResult).message,
          };
        }
      }

      return result;
    },
    initDraft(plan) {
      if (!this.npm?.graph) return;
      plan.addPolicy(depsPolicy(this, getBumpDepType));
    },
    async applyDraft(draft) {
      if (!this.npm?.graph) return;

      const npmGraph = this.npm.graph;
      const writes: Awaitable<void>[] = [];

      for (const pkg of npmGraph.packages.values()) {
        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped) pkg.manifest.version = bumped;
      }

      for (const pkg of npmGraph.packages.values()) {
        for (const dep of pkg.listDependencies(npmGraph)) {
          if (!dep.linked?.version || !dep.range || !dep.setRange) continue;
          if (
            semver.satisfies(dep.linked.version, dep.range, {
              includePrerelease: dep.spec.protocol === "workspace",
            })
          )
            continue;

          const isPeer = dep.field === "peerDependencies";
          if (isPeer && onBreakPeerDep === "ignore") continue;

          let updatedRange: string;
          if (isPeer && onBreakPeerDep === "set") {
            updatedRange = dep.linked.version;
          } else if (isPeer && onBreakPeerDep === "error") {
            throw new Error(
              `[Tegami] the version of "${dep.linked.name}" is beyond its peer dependency constraint "${formatDependencySpec(dep.spec)}" in package "${pkg.name}", please update the constraint to satisfy.`,
            );
          } else if (dep.range.startsWith("^")) {
            updatedRange = `^${dep.linked.version}`;
          } else if (dep.range.startsWith("~")) {
            updatedRange = `~${dep.linked.version}`;
          } else {
            updatedRange = dep.linked.version;
          }

          dep.setRange(updatedRange);
        }

        writes.push(pkg.write());
      }

      for (const source of npmGraph.catalogs) {
        writes.push(source.write?.());
      }

      await Promise.all(writes);
    },
    async applyCliDraft() {
      if (!this.npm?.graph || !updateLockFile) return;

      let args: string[];
      switch (this.npm.agent) {
        case "pnpm":
        case "pnpm@6":
        case "aube":
        case "nub":
          args = ["install", "--lockfile-only", "--no-frozen-lockfile"];
          break;
        case "npm":
          args = ["install", "--package-lock-only"];
          break;
        case "bun":
          args = ["install", "--lockfile-only"];
          break;
        case "yarn@berry":
          args = ["install", "--mode=update-lockfile", "--no-immutable"];
          break;
        default:
          args = ["install"];
      }

      const result = await x(this.npm.client, args, { nodeOptions: { cwd: this.cwd } });
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
  const npmGraph = context.npm?.graph;
  if (!npmGraph) throw new Error("npm graph is missing");

  const dependentMap = new Map<string, DependentRef[]>();

  for (const pkg of npmGraph.packages.values()) {
    for (const resolved of pkg.listDependencies(npmGraph)) {
      if (!resolved.linked) continue;

      const refs = dependentMap.get(resolved.linked.id);
      const ref: DependentRef = {
        dependent: pkg,
        kind: resolved.field,
        name: resolved.name,
        spec: resolved.spec,
        resolved,
      };
      if (refs) refs.push(ref);
      else dependentMap.set(resolved.linked.id, [ref]);
    }
  }

  function needsDependencyUpdate(resolved: ResolvedNpmDependency, target: string): boolean {
    if (!resolved.linked) return false;

    switch (resolved.spec.protocol) {
      case "file":
      case "portal":
        return true;
      case "workspace":
        switch (resolved.spec.range) {
          case "":
          case "*":
            return true;
          case "^":
          case "~":
            return !semver.satisfies(
              target,
              `${resolved.spec.range}${resolved.linked.version ?? "0.0.0"}`,
              {
                includePrerelease: true,
              },
            );
        }
    }

    if (!resolved.range || !semver.validRange(resolved.range)) return false;
    return !semver.satisfies(target, resolved.range);
  }

  return {
    id: "npm:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof NpmPackage)) return;
      const deps = dependentMap.get(pkg.id);
      if (!deps) return;

      const bumped = plan.bumpVersion(pkg);
      if (!bumped) return;

      for (const dep of deps) {
        if (pkg.group?.options.syncBump && dep.dependent.group === pkg.group) continue;
        if (!needsDependencyUpdate(dep.resolved, bumped)) continue;

        const bumpType = getBumpDepType(dep);
        if (bumpType === false) continue;

        this.bumpPackage(dep.dependent, {
          type: bumpType,
          reason: `update dependency "${dep.name}"`,
        });
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

      const result = await x("bun", ["run", script], { nodeOptions: { cwd: pkg.path } });
      if (result.exitCode === 0) continue;

      return {
        type: "failed",
        error: execFailure(`Failed to run ${script} script for ${pkg.name}@${pkg.version}.`, result)
          .message,
      };
    }

    const tarballPath = path.resolve(pkg.path, "pkg.tgz");
    const packResult = await x("bun", ["pm", "pack", "--filename", tarballPath], {
      nodeOptions: { cwd: pkg.path },
    });
    if (packResult.exitCode !== 0) {
      return {
        type: "failed",
        error: execFailure(`Failed to pack ${pkg.name}@${pkg.version}.`, packResult).message,
      };
    }

    const publishArgs = ["publish", tarballPath];
    if (distTag) publishArgs.push("--tag", distTag);

    const publishResult = await x("npm", publishArgs, { nodeOptions: { cwd: pkg.path } });
    if (publishResult.exitCode !== 0) {
      return {
        type: "failed",
        error: execFailure(
          `Failed to publish ${pkg.name}@${pkg.version}${distTag ? ` with dist-tag "${distTag}"` : ""}.`,
          publishResult,
        ).message,
      };
    }
    return { type: "published" };
  }

  let command: string;
  const args = ["publish"];
  if (distTag) args.push("--tag", distTag);

  switch (client) {
    case "pnpm":
      command = "pnpm";
      args.push("--no-git-checks");
      break;
    case "aube":
    case "nub":
    case "yarn":
      command = client;
      break;
    default:
      command = "npm";
      break;
  }

  const result = await x(command, args, { nodeOptions: { cwd: pkg.path } });
  if (result.exitCode !== 0) {
    return {
      type: "failed",
      error: execFailure(
        `Failed to publish ${pkg.name}@${pkg.version}${distTag ? ` with dist-tag "${distTag}"` : ""}.`,
        result,
      ).message,
    };
  }

  return { type: "published" };
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
    throw await fetchFailure(
      `Unable to validate ${name}@${version} against the npm registry${registry ? ` "${registry}"` : ""}`,
      response,
    );
  }

  return true;
}
