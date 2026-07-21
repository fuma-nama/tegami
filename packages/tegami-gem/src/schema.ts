import typia from "typia";

export interface GemVersion {
  number: string;
}

export type GemVersions = GemVersion[];

export const assertGemVersions = typia.createAssert<GemVersions>();
