import typia from "typia";

interface CargoDepBase {
  package?: string;
  features?: string[];
  optional?: boolean;
  "default-features"?: boolean;
}

interface CargoWorkspaceDependency extends CargoDepBase {
  workspace: true;
}

interface CargoPathDependency extends CargoDepBase {
  path: string;
  version?: string;
}

interface CargoGitDependency extends CargoDepBase {
  git: string;
  branch?: string;
  tag?: string;
  rev?: string;
  version?: string;
}

interface CargoRegistryDependency extends CargoDepBase {
  version: string;
  registry?: string;
}

export type CargoDependency =
  | string
  | CargoWorkspaceDependency
  | CargoPathDependency
  | CargoGitDependency
  | CargoRegistryDependency;

interface CargoInherit {
  workspace: true;
}

interface CargoTargetSection {
  dependencies?: Record<string, CargoDependency>;
  "dev-dependencies"?: Record<string, CargoDependency>;
  "build-dependencies"?: Record<string, CargoDependency>;
}

interface CargoWorkspace {
  members?: string[];
  exclude?: string[];
  package?: {
    version?: string;
    publish?: boolean;
  };
  dependencies?: Record<string, CargoDependency>;
  "dev-dependencies"?: Record<string, CargoDependency>;
  "build-dependencies"?: Record<string, CargoDependency>;
}

export interface CargoManifest {
  package?: {
    name: string;
    version: string | CargoInherit;
    publish?: boolean | CargoInherit;
  };
  workspace?: CargoWorkspace;
  dependencies?: Record<string, CargoDependency>;
  "dev-dependencies"?: Record<string, CargoDependency>;
  "build-dependencies"?: Record<string, CargoDependency>;
  target?: Record<string, CargoTargetSection>;
}

export const assertCargoManifest = typia.createAssert<CargoManifest>();
