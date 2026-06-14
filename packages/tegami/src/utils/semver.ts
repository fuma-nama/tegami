import { inc, parse } from "semver";

export type BumpType = "major" | "minor" | "patch";

export function formatPackageVersion(name: string, version: string, distTag?: string): string {
  const tag = distTag ? ` (${distTag})` : "";
  return `${name}@${version}${tag}`;
}

// TODO: improve draft plan API such that it does not rely on this to obtain the original version before bump
export function previousVersion(version: string, type: BumpType): string {
  const parsed = parse(version);
  if (!parsed) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  if (type === "major") {
    parsed.major = Math.max(0, parsed.major - 1);
    parsed.minor = 0;
    parsed.patch = 0;
  } else if (type === "minor") {
    parsed.minor = Math.max(0, parsed.minor - 1);
    parsed.patch = 0;
  } else {
    parsed.patch = Math.max(0, parsed.patch - 1);
  }

  parsed.prerelease = [];
  parsed.build = [];
  return parsed.format();
}

export function formatVersionBump(
  name: string,
  from: string,
  to: string,
  distTag?: string,
): string {
  const tag = distTag ? ` (${distTag})` : "";
  return `${name}@${from} → ${name}@${to}${tag}`;
}

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
