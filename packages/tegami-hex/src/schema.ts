import typia from "typia";

/** Subset of the Hex registry package API response we care about. */
export interface HexRegistryPackage {
  releases?: {
    version: string;
  }[];
}

export const assertHexRegistryPackage = typia.createAssert<HexRegistryPackage>();
