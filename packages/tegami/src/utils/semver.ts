import { inc, parse } from "semver";

export type BumpType = "major" | "minor" | "patch";

export function formatNpmDistTag(distTag?: string): string {
  return distTag && distTag !== "latest" ? ` (${distTag})` : "";
}

export function formatPackageVersion(
  name: string,
  version: string | undefined,
  distTag?: string,
): string {
  let out = name;
  if (version) out += `@${version}`;
  out += formatNpmDistTag(distTag);
  return out;
}

const WEIGHTS = {
  major: 3,
  minor: 2,
  patch: 1,
} as const;

const DEPTH = {
  major: 1,
  minor: 2,
  patch: 3,
} as const;

const NAMES = {
  major: "Major",
  minor: "Minor",
  patch: "Patch",
};

const PRE = {
  major: "premajor",
  minor: "preminor",
  patch: "prepatch",
} as const;

export function maxBump(a: BumpType, b: BumpType): BumpType {
  if (WEIGHTS[a] > WEIGHTS[b]) return a;
  return b;
}

export function bumpName(bumpType: BumpType) {
  return NAMES[bumpType];
}

export function bumpDepth(type: BumpType) {
  return DEPTH[type];
}

export function bumpVersion(version: string, type?: BumpType, prerelease?: string): string {
  let next: string | null = version;

  const parsed = parse(version);

  if (!parsed) {
    next = null;
  } else if (prerelease) {
    if (parsed.prerelease[0] === prerelease) {
      next = type ? inc(parsed, "prerelease", prerelease) : version;
    } else if (parsed.prerelease[0]) {
      next = inc(parsed, "prerelease", prerelease);
    } else if (type) {
      next = inc(parsed, PRE[type], prerelease);
    }
  } else if (type) {
    next = inc(parsed, type);
  } else if (parsed.prerelease.length > 0) {
    next = inc(parsed, "release");
  }

  if (!next) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return next;
}
