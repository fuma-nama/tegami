import type { TegamiContext } from "./context";
import type { Awaitable, DependencySpec } from "./types";
import * as semver from "semver";

/** Package discovered in the workspace. */
export abstract class WorkspacePackage {
  abstract readonly name: string;
  abstract readonly path: string;
  abstract readonly manager: string;
  abstract readonly version: string;
  abstract readonly publish: boolean;

  get distTag(): string | undefined {
    return undefined;
  }

  get id(): string {
    return `${this.manager}:${this.name}`;
  }

  setVersion?(version: string): void;
  updateDependency?(
    target: WorkspacePackage,
    version: string,
    context: TegamiContext,
  ): Awaitable<void>;
  write?(): Awaitable<void>;

  protected async updateRange(
    context: TegamiContext,
    spec: DependencySpec,
    next: semver.SemVer,
  ): Promise<DependencySpec> {
    for (const plugin of context.plugins) {
      const result = await plugin.onUpdateRange?.call(context, this, spec, next);
      if (result) return result;
    }

    // Ignore special syntax like "latest".
    if (!semver.validRange(spec.range)) return spec;
    const range = new semver.Range(spec.range);
    if (range.test(next)) return spec;

    spec.range = next.format();
    return spec;
  }
}

/** Dependency graph for discovered workspace packages. */
export class PackageGraph {
  private readonly byId = new Map<string, WorkspacePackage>();
  private readonly byName = new Map<string, WorkspacePackage[]>();

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

  /** Get packages by id, or every package matching a name. */
  getByName(nameOrId: string): WorkspacePackage[] {
    const exact = this.byId.get(nameOrId);
    if (exact) return [exact];

    return this.byName.get(nameOrId) ?? [];
  }

  /** scan package into graph, if the package id already exists, replace the existing one in graph */
  add(pkg: WorkspacePackage): void {
    const existing = this.byId.get(pkg.id);
    if (existing) this.delete(existing);

    this.byId.set(pkg.id, pkg);
    const named = this.byName.get(pkg.name);

    if (named) named.push(pkg);
    else this.byName.set(pkg.name, [pkg]);
  }

  delete(pkg: WorkspacePackage): void {
    this.byId.delete(pkg.id);
    const named = this.byName.get(pkg.name);
    if (!named) return;

    const index = named.findIndex((item) => item.id === pkg.id);
    if (index !== -1) {
      named.splice(index, 1);
    }
  }
}
