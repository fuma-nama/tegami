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
} as const;

const PRE = {
  major: "premajor",
  minor: "preminor",
  patch: "prepatch",
} as const;

export function maxBump(a: BumpType, b: BumpType): BumpType {
  if (WEIGHTS[a] > WEIGHTS[b]) return a;
  return b;
}

export function bumpVersion(version: string, type?: BumpType, prerelease?: string): string {
  let next: string | null = version;

  if (prerelease) {
    const parsed = parse(version);
    if (parsed?.prerelease[0] === prerelease) {
      next = inc(version, "prerelease", prerelease);
    } else if (type) {
      next = inc(version, PRE[type], prerelease);
    }
  } else if (type) {
    next = inc(version, type);
  }

  if (!next) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return next;
}
