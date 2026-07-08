import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as semver from "semver";
import { glob } from "tinyglobby";
import { x } from "tinyexec";
import { parseDocument, type Document } from "yaml";
import type { BumpType, DraftPolicy, PackageGraph, TegamiContext, TegamiPlugin } from "tegami";
import { WorkspacePackage } from "tegami";
import { execFailure, fetchFailure, isCI, joinPath } from "tegami/utils";
import { assertHostedPackage, assertPubspec, type DartDependency, type Pubspec } from "./schema";

const DEP_FIELDS = ["dependencies", "dev_dependencies", "dependency_overrides"] as const;
const DEFAULT_HOSTED_URL = "https://pub.dev";

interface PubspecFile {
  path: string;
  doc: Document;
  data: Pubspec;
}

export class DartPackage extends WorkspacePackage {
  readonly manager = "dart";

  constructor(
    readonly path: string,
    readonly file: PubspecFile,
  ) {
    super();
  }

  get name(): string {
    return this.file.data.name!;
  }

  get version(): string | undefined {
    return this.file.data.version;
  }

  get publishTo(): string | undefined {
    return this.file.data.publish_to;
  }

  setVersion(version: string): void {
    this.file.data.version = version;
    this.file.doc.setIn(["version"], version);
  }

  async write(): Promise<void> {
    await writeFile(path.join(this.path, "pubspec.yaml"), this.file.doc.toString({ lineWidth: 0 }));
  }
}

interface DependentRef {
  dependent: DartPackage;
  kind: (typeof DEP_FIELDS)[number];
  name: string;
  spec: DartDependency;
  table: Record<string, DartDependency>;
  linked: DartPackage;
}

export interface DartPluginOptions {
  /**
   * Update the pub workspace resolution after versioning.
   *
   * @default true
   */
  updateLockFile?: boolean;

  /**
   * Decide how to bump the dependents of a bumped package.
   */
  bumpDep?: (opts: DependentRef) => BumpType | false;
}

export function dart({
  updateLockFile = true,
  bumpDep: getBumpDepType,
}: DartPluginOptions = {}): TegamiPlugin {
  let active = false;

  return {
    name: "dart",
    async resolve() {
      const packages = await discoverDartPackages(this.cwd);
      for (const pkg of packages) this.graph.add(pkg);
      active = packages.length > 0;
    },
    initDraft(draft) {
      if (!active) return;
      draft.addPolicy(depsPolicy(this, getBumpDepType));
    },
    publishPreflight({ pkg }) {
      if (!(pkg instanceof DartPackage)) return;

      const wait = dependencyRefs(this.graph, pkg)
        .filter((ref) => ref.kind === "dependencies")
        .map((ref) => ref.linked.id);

      return {
        shouldPublish: pkg.version !== undefined && pkg.publishTo !== "none",
        wait,
      };
    },
    resolvePlanStatus({ plan }) {
      return Array.from(plan.packages, async ([id, { preflight }]) => {
        if (!preflight!.shouldPublish) return;
        const pkg = this.graph.get(id)!;
        if (!(pkg instanceof DartPackage) || !pkg.version) return;
        if (!(await isPackagePublished(pkg.name, pkg.version, pkg.publishTo ?? DEFAULT_HOSTED_URL)))
          return "pending";
      });
    },
    async publish({ pkg }) {
      if (!(pkg instanceof DartPackage)) return;

      const result = await x("dart", ["pub", "publish", ...(isCI() ? ["--force"] : [])], {
        nodeOptions: { cwd: pkg.path },
      });

      if (result.exitCode !== 0) {
        if (
          /already exists|already published|version already exists/i.test(
            `${result.stdout}\n${result.stderr}`,
          )
        ) {
          return { type: "skipped" };
        }

        return {
          type: "failed",
          error: execFailure(`Failed to publish ${pkg.name}@${pkg.version}.`, result).message,
        };
      }

      return { type: "published" };
    },
    async applyDraft(draft) {
      if (!active) return;

      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof DartPackage)) continue;

        const bumped = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
        if (bumped) pkg.setVersion(bumped);
      }

      const writes: Promise<void>[] = [];
      for (const pkg of this.graph.getPackages()) {
        if (!(pkg instanceof DartPackage)) continue;

        for (const ref of dependencyRefs(this.graph, pkg)) {
          if (!ref.linked.version) continue;

          const range = getDependencyRange(ref.spec);
          if (!range || satisfiesDartRange(ref.linked.version, range)) continue;

          const nextRange = updateConstraintRange(range, ref.linked.version);
          ref.table[ref.name] = setDependencyRange(ref.spec, nextRange);
          ref.dependent.file.doc.setIn(
            typeof ref.spec === "object" && ref.spec !== null
              ? [ref.kind, ref.name, "version"]
              : [ref.kind, ref.name],
            nextRange,
          );
        }

        writes.push(pkg.write());
      }

      await Promise.all(writes);
    },
    async applyCliDraft() {
      if (!active || !updateLockFile) return;

      const result = await x("dart", ["pub", "get"], {
        nodeOptions: { cwd: this.cwd },
      });

      if (result.exitCode !== 0) {
        throw execFailure("Failed to update Dart pub resolution.", result);
      }
    },
  };
}

function depsPolicy(
  { graph }: TegamiContext,
  getBumpDepType: DartPluginOptions["bumpDep"] = ({ kind }) => {
    switch (kind) {
      case "dependencies":
      case "dependency_overrides":
        return "patch";
      case "dev_dependencies":
        return false;
    }
  },
): DraftPolicy {
  const dependentMap = new Map<string, DependentRef[]>();

  for (const pkg of graph.getPackages()) {
    if (!(pkg instanceof DartPackage)) continue;

    for (const ref of dependencyRefs(graph, pkg)) {
      const refs = dependentMap.get(ref.linked.id);
      if (refs) refs.push(ref);
      else dependentMap.set(ref.linked.id, [ref]);
    }
  }

  return {
    id: "dart:deps",
    onUpdate({ pkg, packageDraft: plan }) {
      if (!(pkg instanceof DartPackage)) return;
      const deps = dependentMap.get(pkg.id);
      if (!deps) return;

      const bumped = plan.bumpVersion(pkg);
      if (!bumped) return;

      for (const dep of deps) {
        if (pkg.group?.options.syncBump && dep.dependent.group === pkg.group) {
          continue;
        }

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

function dependencyRefs(graph: PackageGraph, pkg: DartPackage): DependentRef[] {
  const refs: DependentRef[] = [];

  for (const { kind, table } of dependencyTables(pkg.file.data)) {
    for (const [name, spec] of Object.entries(table)) {
      const linked = resolveLinkedPackage(graph, name);
      if (!linked || linked === pkg) continue;

      refs.push({ dependent: pkg, kind, name, spec, table, linked });
    }
  }

  return refs;
}

function resolveLinkedPackage(graph: PackageGraph, name: string): DartPackage | undefined {
  return graph
    .getPackages()
    .find(
      (candidate): candidate is DartPackage =>
        candidate instanceof DartPackage && candidate.name === name,
    );
}

function dependencyTables(manifest: Pubspec) {
  const tables: {
    kind: (typeof DEP_FIELDS)[number];
    table: Record<string, DartDependency>;
  }[] = [];

  for (const kind of DEP_FIELDS) {
    const table = manifest[kind];
    if (table) tables.push({ kind, table });
  }

  return tables;
}

function getDependencyRange(spec: DartDependency): string | undefined {
  if (typeof spec === "string") return spec;
  return spec.version;
}

function setDependencyRange(spec: DartDependency, range: string): DartDependency {
  if (typeof spec !== "object" || spec === null) return range;
  spec.version = range;
  return spec;
}

export function updateConstraintRange(range: string, version: string): string {
  const trimmed = range.trim();

  if (trimmed.startsWith("^")) return `^${version}`;
  if (trimmed.startsWith("~")) return `~${version}`;

  const lowerBound = /^(>=|>)\s*([0-9A-Za-z.+-]+)/.exec(trimmed);
  if (lowerBound) return trimmed.replace(lowerBound[0], `${lowerBound[1]}${version}`);

  return version;
}

function satisfiesDartRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === "any") return true;
  if (!semver.validRange(trimmed, { loose: true })) return false;
  return semver.satisfies(version, trimmed, { includePrerelease: true, loose: true });
}

async function discoverDartPackages(cwd: string): Promise<DartPackage[]> {
  const out: DartPackage[] = [];
  const root = await readPubspec(cwd);
  if (!root?.data.workspace?.length) return out;

  const files = new Map<string, PubspecFile>();
  files.set(root.path, root);
  await collectWorkspaceFiles(root, files);
  for (const file of files.values()) {
    if (!file.data.name) continue;

    out.push(new DartPackage(path.dirname(file.path), file));
  }
  return out;
}

async function collectWorkspaceFiles(
  root: PubspecFile,
  files: Map<string, PubspecFile>,
): Promise<void> {
  const rootDir = path.dirname(root.path);
  const members = root.data.workspace;
  if (!members?.length) return;

  const paths = await glob(members, {
    absolute: true,
    cwd: rootDir,
    onlyDirectories: true,
    onlyFiles: false,
    ignore: ["**/.dart_tool/**", "**/build/**"],
  });

  await Promise.all(
    paths.map(async (dir) => {
      const file = await readPubspec(dir);
      if (!file || files.has(file.path)) return;

      files.set(file.path, file);
      await collectWorkspaceFiles(file, files);
    }),
  );
}

async function readPubspec(dir: string): Promise<PubspecFile | undefined> {
  const filePath = path.join(dir, "pubspec.yaml");

  try {
    const content = await readFile(filePath, "utf8");
    const doc = parseDocument(content);
    return {
      path: filePath,
      doc,
      data: assertPubspec(doc.toJS()),
    };
  } catch {
    return;
  }
}

export async function isPackagePublished(
  name: string,
  version: string,
  hostedUrl: string,
): Promise<boolean> {
  const url = joinPath(hostedUrl, "api/packages", encodeURIComponent(name));
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.pub.v2+json",
      "User-Agent": "tegami-dart",
    },
  });

  if (response.status === 404) return false;
  if (!response.ok) {
    throw await fetchFailure(`Unable to validate ${name}@${version} on ${hostedUrl}`, response);
  }

  const body = assertHostedPackage(await response.json());
  return body.versions?.some((entry) => entry.version === version) ?? false;
}
