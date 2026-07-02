import typia from "typia";

export interface PnpmWorkspace {
  packages?: string[];
}

export interface PackageManifest {
  name: string;
  version?: string;
  private?: boolean;
  publishConfig?: {
    access?: "public" | "restricted";
    registry?: string;
    tag?: string;
  };
  scripts?: Record<string, string>;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export const assertPnpmWorkspace = typia.createAssert<PnpmWorkspace>();
export const assertPackageManifest = typia.createAssert<PackageManifest>();
