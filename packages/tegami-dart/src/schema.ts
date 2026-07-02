import typia from "typia";

export type DartDependency =
  | string
  | {
      version?: string;
      hosted?: string | { name?: string; url: string };
      path?: string;
      git?: unknown;
      sdk?: string;
      [key: string]: unknown;
    };

export interface Pubspec {
  name?: string;
  version?: string;
  publish_to?: string;
  resolution?: string;
  workspace?: string[];
  dependencies?: Record<string, DartDependency>;
  dev_dependencies?: Record<string, DartDependency>;
  dependency_overrides?: Record<string, DartDependency>;
}

export interface HostedPackage {
  versions?: {
    version: string;
  }[];
}

export const assertPubspec = typia.createAssert<Pubspec>();
export const assertHostedPackage = typia.createAssert<HostedPackage>();
