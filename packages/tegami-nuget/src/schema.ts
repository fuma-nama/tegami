import typia from "typia";

/** Response shape of the NuGet flat container `index.json` endpoint. */
export interface FlatContainerIndex {
  versions: string[];
}

export const assertFlatContainerIndex = typia.createAssert<FlatContainerIndex>();
