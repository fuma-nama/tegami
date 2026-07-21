import * as semver from "semver";

/** Comparison operators supported in a RubyGems requirement. */
export type RequirementOperator = "~>" | ">=" | "<=" | "!=" | ">" | "<" | "=";

export interface Requirement {
  operator: RequirementOperator;
  /** the version literal, kept verbatim (e.g. `1.2`, `1.2.3`). */
  version: string;
  /** whether the source was a bare version without an explicit operator. */
  bare: boolean;
}

const OPERATOR_RE = /^(~>|>=|<=|!=|>|<|=)?\s*(.+)$/;

/** Parse a single Ruby requirement string such as `~> 1.0`, `>= 1.2.3`, or a bare `1.2.3`. */
export function parseRequirement(input: string): Requirement | undefined {
  const trimmed = input.trim();
  const match = OPERATOR_RE.exec(trimmed);
  if (!match) return;

  const version = (match[2] ?? "").trim();
  if (!version || !/\d/.test(version)) return;

  return {
    operator: (match[1] as RequirementOperator | undefined) ?? "=",
    version,
    bare: match[1] === undefined,
  };
}

/**
 * Compute the inclusive lower and exclusive upper bound of a pessimistic (`~>`) constraint.
 *
 * `~> 1.0` → `>= 1.0, < 2.0`; `~> 1.2.3` → `>= 1.2.3, < 1.3.0`; `~> 1` → `>= 1, < 2`.
 */
export function pessimisticBounds(version: string): { lower: string; upper: string } {
  const segments = version.split(".").map((segment) => parseInt(segment, 10) || 0);

  let upperSegments: number[];
  if (segments.length <= 1) {
    upperSegments = [(segments[0] ?? 0) + 1];
  } else {
    upperSegments = segments.slice(0, -1);
    upperSegments[upperSegments.length - 1] = (upperSegments[upperSegments.length - 1] ?? 0) + 1;
  }

  return { lower: version, upper: upperSegments.join(".") };
}

/** Whether `version` satisfies a single requirement. */
export function satisfiesRequirement(version: string, requirement: Requirement): boolean {
  // keep prerelease identifiers — `coerce` drops them by default, which would
  // make `1.1.0-alpha.0` compare as `1.1.0`.
  const current = semver.coerce(version, { loose: true, includePrerelease: true });
  const target = semver.coerce(requirement.version, { loose: true, includePrerelease: true });
  if (!current || !target) return false;

  switch (requirement.operator) {
    case "=":
      return semver.eq(current, target);
    case "!=":
      return !semver.eq(current, target);
    case ">":
      return semver.gt(current, target);
    case ">=":
      return semver.gte(current, target);
    case "<":
      return semver.lt(current, target);
    case "<=":
      return semver.lte(current, target);
    case "~>": {
      const { lower, upper } = pessimisticBounds(requirement.version);
      const low = semver.coerce(lower, { loose: true, includePrerelease: true });
      const high = semver.coerce(upper, { loose: true });
      if (!low || !high) return false;
      return semver.gte(current, low) && semver.lt(current, high);
    }
  }
}

/** Whether `version` satisfies every requirement (they are combined with AND). */
export function satisfiesRequirements(version: string, requirements: Requirement[]): boolean {
  return requirements.every((requirement) => satisfiesRequirement(version, requirement));
}

/**
 * Rewrite a requirement so it accepts `newVersion`, preserving the operator style and the
 * number of version segments (precision) of the original constraint.
 */
export function rewriteRequirement(requirement: Requirement, newVersion: string): Requirement {
  const precision = requirement.version.split(".").length;
  let version = truncate(newVersion, precision);

  // an exclusive upper bound must be widened past the new version to include it.
  if (requirement.operator === "<") version = incrementLast(version);

  return { operator: requirement.operator, version, bare: requirement.bare };
}

/** Serialize a requirement back into its Ruby source form. */
export function formatRequirement(requirement: Requirement): string {
  return requirement.bare ? requirement.version : `${requirement.operator} ${requirement.version}`;
}

function truncate(version: string, segments: number): string {
  // prerelease identifiers contain dots (`1.1.0-alpha.0`); truncating would
  // drop or mangle them, so prerelease versions are always kept whole.
  if (version.includes("-")) return version;
  return version.split(".").slice(0, segments).join(".");
}

function incrementLast(version: string): string {
  // an exclusive bound only needs the numeric core (`< 1.1.1` accepts `1.1.0-alpha.0`)
  const segments = version.split("-")[0]!.split(".");
  const last = segments.length - 1;
  segments[last] = String((parseInt(segments[last] ?? "0", 10) || 0) + 1);
  return segments.join(".");
}
