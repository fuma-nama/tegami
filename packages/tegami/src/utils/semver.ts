import { inc, parse } from "semver";

export type BumpType = "major" | "minor" | "patch";

export function formatNpmDistTag(distTag?: string): string {
  return distTag && distTag !== "latest" ? ` (${distTag})` : "";
}

export function formatPackageVersion(name: string, version: string, distTag?: string): string {
  return `${name}@${version}${formatNpmDistTag(distTag)}`;
}

const WEIGHTS = {
  major: 3,
  minor: 2,
  patch: 1,
};

export function maxBump(a: BumpType, b: BumpType): BumpType {
  if (WEIGHTS[a] > WEIGHTS[b]) return a;
  return b;
}

export function bumpVersion(version: string, type: BumpType, prerelease?: string): string {
  let next: string | null;

  if (prerelease) {
    const parsed = parse(version);
    if (parsed?.prerelease[0] === prerelease) {
      next = inc(version, "prerelease", prerelease);
    } else {
      const preType = type === "major" ? "premajor" : type === "minor" ? "preminor" : "prepatch";
      next = inc(version, preType, prerelease);
    }
  } else {
    next = inc(version, type);
  }

  if (!next) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return next;
}
