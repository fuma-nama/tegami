import typia from "typia";

export interface UvSource {
  workspace?: boolean;
  path?: string;
}

export interface UvIndex {
  name: string;
  url: string;
  "publish-url"?: string;
}

interface UvConfig {
  workspace?: {
    members?: string[];
    exclude?: string[];
  };
  sources?: Record<string, UvSource>;
  index?: UvIndex[];
}

export interface PyprojectProject {
  name: string;
  version?: string;
  private?: boolean;
  dependencies?: string[];
  "optional-dependencies"?: Record<string, string[]>;
}

export interface PyprojectManifest {
  project?: PyprojectProject;
  "dependency-groups"?: Record<string, string[]>;
  tool?: {
    uv?: UvConfig;
  };
}

export interface SimpleIndexProject {
  files?: {
    filename: string;
  }[];
}

export const assertPyprojectManifest = typia.createAssert<PyprojectManifest>();
