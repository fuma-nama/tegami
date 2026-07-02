import type { PackageDraft } from "./plans/draft";
import type { GroupOptions, PackageOptions } from "./types";
import { bumpVersion } from "./utils/semver";

/** Package discovered in the workspace. */
export abstract class WorkspacePackage {
  abstract readonly name: string;
  /** absolute path */
  abstract readonly path: string;
  abstract readonly manager: string;
  abstract readonly version: string | undefined;
  /** note: this will only be available after package graph is resolved */
  group?: PackageGroup;
  /** note: this will only be available after package graph is resolved */
  options: PackageOptions = {};

  get id(): string {
    return `${this.manager}:${this.name}`;
  }

  /** create the initial draft. */
  initDraft(): PackageDraft {
    return {
      bumpVersion(pkg) {
        if (!pkg.version) return;
        return bumpVersion(pkg.version, this.type, this.prerelease);
      },
    };
  }

  /** configure an initial draft to match script-level configs. */
  configureDraft({ draft }: { draft: PackageDraft }): void {
    const { prerelease = this.group?.options?.prerelease } = this.options;

    if (prerelease !== undefined) draft.prerelease = prerelease;
  }
}

export interface PackageGroup {
  name: string;
  options: GroupOptions;
  packages: WorkspacePackage[];
}

/**
 * Unified graph for discovered workspace packages.
 *
 * This is only used as a storage for all indexed packages.
 * For registry-specific relationships (e.g. virtual workspaces), they are stored in the provider plugin internally.
 */
export class PackageGraph {
  private readonly packages = new Map<string, WorkspacePackage>();
  private readonly groups = new Map<string, PackageGroup>();

  constructor(packages: WorkspacePackage[] = []) {
    for (const pkg of packages) {
      this.add(pkg);
    }
  }

  getPackages(): WorkspacePackage[] {
    return Array.from(this.packages.values());
  }

  /** Get a package by exact id. */
  get(id: string): WorkspacePackage | undefined {
    return this.packages.get(id);
  }

  /** Get packages by id, `group:name`, or every package matching a name. */
  getByName(nameOrId: string): WorkspacePackage[] {
    const exact = this.packages.get(nameOrId);
    if (exact) return [exact];

    if (nameOrId.startsWith("group:")) {
      return this.getGroup(nameOrId.slice("group:".length))?.packages ?? [];
    }

    const out: WorkspacePackage[] = [];
    for (const value of this.packages.values()) {
      if (value.name === nameOrId) out.push(value);
    }
    return out;
  }

  /** scan package into graph, if the package id already exists, replace the existing one in graph */
  add(pkg: WorkspacePackage): void {
    this.delete(pkg.id);
    this.packages.set(pkg.id, pkg);
  }

  delete(id: string): void {
    this.packages.delete(id);

    for (const group of this.groups.values()) {
      const index = group.packages.findIndex((pkg) => pkg.id === id);
      if (index >= 0) group.packages.splice(index, 1);
    }
  }

  getPackageGroup(pkgId: string) {
    return this.packages.get(pkgId)?.group;
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

  addGroupMember(groupId: string, id: string): void {
    const group = this.groups.get(groupId);
    const pkg = this.packages.get(id);
    if (!group || !pkg || pkg.group) return;

    pkg.group = group;
    group.packages.push(pkg);
  }

  removeGroupMember(group: string, id: string): void {
    const entry = this.groups.get(group);
    const pkg = this.packages.get(id);
    if (!entry || !pkg || pkg.group !== entry) return;

    const index = entry.packages.findIndex((pkg) => pkg.id === id);
    if (index >= 0) entry.packages.splice(index, 1);
    pkg.group = undefined;
  }

  unregisterGroup(name: string): void {
    const group = this.groups.get(name);
    if (!group) return;

    for (const pkg of group.packages) {
      const entry = this.packages.get(pkg.id);
      if (entry?.group === group) entry.group = undefined;
    }

    this.groups.delete(name);
  }
}
