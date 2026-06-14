import { inc } from "semver";

export type BumpType = "major" | "minor" | "patch";

export function maxBump(a: BumpType, b: BumpType): BumpType {
  if (a === "major" || b === "major") return "major";
  if (a === "minor" || b === "minor") return "minor";
  return "patch";
}

export function bumpVersion(version: string, type: BumpType): string {
  const next = inc(version, type);

  if (!next) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return next;
}
