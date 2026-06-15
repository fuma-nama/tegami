import type { TegamiContext } from "./context";
import type { PackagePlan } from "./draft";
import type { Awaitable, DependencySpec, GroupOptions, PackageOptions } from "./types";
import { handlePluginError } from "./utils/error";
import * as semver from "semver";

/** Package discovered in the workspace. */
export abstract class WorkspacePackage {
  abstract readonly name: string;
  abstract readonly path: string;
  abstract readonly manager: string;
  abstract readonly version: string;

  get id(): string {
    return `${this.manager}:${this.name}`;
  }

  abstract setVersion(version: string): void;
  abstract updateDependency(
    target: WorkspacePackage,
    version: string,
    context: TegamiContext,
  ): Awaitable<void>;
  abstract write(): Awaitable<void>;

  protected async updateRange(
    context: TegamiContext,
    spec: DependencySpec,
    next: semver.SemVer,
  ): Promise<DependencySpec> {
    for (const plugin of context.plugins) {
      const result = await handlePluginError(plugin, "onUpdateRange", () =>
        plugin.onUpdateRange?.call(context, this, spec, next),
      );
      if (result) return result;
    }

    // Ignore special syntax like "latest".
    if (!semver.validRange(spec.range)) return spec;
    const range = new semver.Range(spec.range);
    if (range.test(next)) return spec;

    spec.range = next.format();
    return spec;
  }

  private opts: PackageOptions = {};

  /** note: this will only be available after package graph is resolved */
  getPackageOptions(): PackageOptions {
    return this.opts;
  }

  setPackageOptions(options: PackageOptions) {
    this.opts = options;
  }

  /** Override defaults when building a draft plan. */
  onPlan(_context: TegamiContext): Partial<PackagePlan> {
    const { publish, npm } = this.opts;
    return {
      publish,
      npm: npm ? { distTag: npm.distTag } : undefined,
    };
  }
}

export interface PackageGroup {
  name: string;
  options: GroupOptions;
  packages: WorkspacePackage[];
}

/** Dependency graph for discovered workspace packages. */
export class PackageGraph {
  private readonly byId = new Map<string, WorkspacePackage>();
  private readonly groups = new Map<string, PackageGroup>();

  constructor(packages: WorkspacePackage[] = []) {
    for (const pkg of packages) {
      this.add(pkg);
    }
  }

  getPackages() {
    return Array.from(this.byId.values());
  }

  /** Get a package by exact id. */
  get(id: string): WorkspacePackage | undefined {
    return this.byId.get(id);
  }

  /** Get packages by id, `group:name`, or every package matching a name. */
  getByName(nameOrId: string): WorkspacePackage[] {
    const exact = this.byId.get(nameOrId);
    if (exact) return [exact];

    if (nameOrId.startsWith("group:")) {
      return this.getGroup(nameOrId.slice("group:".length))?.packages ?? [];
    }

    const out: WorkspacePackage[] = [];
    for (const pkg of this.byId.values()) {
      if (pkg.name === nameOrId) out.push(pkg);
    }
    return out;
  }

  /** scan package into graph, if the package id already exists, replace the existing one in graph */
  add(pkg: WorkspacePackage): void {
    this.delete(pkg.id);

    this.byId.set(pkg.id, pkg);
  }

  delete(id: string): void {
    this.byId.delete(id);

    for (const group of this.groups.values()) {
      const index = group.packages.findIndex((pkg) => pkg.id === id);
      if (index >= 0) group.packages.splice(index, 1);
    }
  }

  getGroups(): PackageGroup[] {
    return Array.from(this.groups.values());
  }

  getGroup(name: string): PackageGroup | undefined {
    return this.groups.get(name);
  }

  registerGroup(name: string, options: GroupOptions): PackageGroup {
    const existing = this.groups.get(name);
    if (existing) {
      existing.options = options;
      return existing;
    }

    const group: PackageGroup = { name, options, packages: [] };
    this.groups.set(name, group);
    return group;
  }

  addGroupMember(group: string, id: string): void {
    const entry = this.groups.get(group);
    const pkg = this.byId.get(id);
    if (!entry || !pkg || entry.packages.some((member) => member.id === id)) return;

    entry.packages.push(pkg);
  }

  removeGroupMember(group: string, id: string): void {
    const entry = this.groups.get(group);
    if (!entry) return;

    const index = entry.packages.findIndex((pkg) => pkg.id === id);
    if (index >= 0) entry.packages.splice(index, 1);
  }

  unregisterGroup(name: string): void {
    this.groups.delete(name);
  }
}
