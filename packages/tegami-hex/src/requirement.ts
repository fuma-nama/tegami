import * as semver from "semver";

/**
 * A small checker/rewriter for Elixir (Hex) version requirements.
 *
 * Elixir requirements are NOT semver ranges. Notably the pessimistic operator
 * `~>` depends on the precision of its operand:
 *
 * - `~> 2.0`   → `>= 2.0.0 and < 3.0.0`
 * - `~> 2.0.1` → `>= 2.0.1 and < 2.1.0`
 *
 * We translate a requirement into an equivalent semver range and evaluate it
 * with the `semver` package (we never feed `~>` to `semver` directly).
 *
 * Supported operators: `~>`, `>=`, `>`, `<`, `<=`, `==`, joined with `and` / `or`.
 * `!=` and other exotic forms are treated as "unknown" (see {@link satisfiesRequirement}).
 */

const OPERATOR_RE = /^(~>|>=|<=|==|!=|>|<)?\s*(.+)$/s;
const VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+][0-9A-Za-z.-]+)?$/;

interface ParsedVersion {
  major: number;
  minorPresent: boolean;
  patchPresent: boolean;
  minor: number;
  patch: number;
  /** prerelease/build suffix including the leading `-` or `+` */
  rest: string;
}

function parseVersion(raw: string): ParsedVersion | undefined {
  const m = VERSION_RE.exec(raw.trim());
  if (!m) return undefined;

  return {
    major: Number(m[1]),
    minorPresent: m[2] !== undefined,
    patchPresent: m[3] !== undefined,
    minor: m[2] !== undefined ? Number(m[2]) : 0,
    patch: m[3] !== undefined ? Number(m[3]) : 0,
    rest: m[4] ?? "",
  };
}

/** Normalize a (possibly partial) Elixir version into a full `x.y.z` semver version. */
function normalizeVersion(raw: string): string | undefined {
  const v = parseVersion(raw);
  if (!v) return undefined;
  return `${v.major}.${v.minor}.${v.patch}${v.rest}`;
}

/** Compute the `[>= lower, < upper]` bounds of a pessimistic (`~>`) operand. */
function pessimisticBounds(raw: string): [string, string] | undefined {
  const v = parseVersion(raw);
  if (!v) return undefined;

  const lower = `${v.major}.${v.minor}.${v.patch}${v.rest}`;
  // `~> x.y.z` (patch present) allows patch-level updates: `< x.(y+1).0`.
  // `~> x.y` (no patch) allows minor-level updates: `< (x+1).0.0`.
  const upper = v.patchPresent ? `${v.major}.${v.minor + 1}.0` : `${v.major + 1}.0.0`;
  return [lower, upper];
}

function convertAtom(atom: string): string | undefined {
  const m = OPERATOR_RE.exec(atom.trim());
  if (!m) return undefined;

  const op = m[1] ?? "==";
  const operand = m[2].trim();

  if (op === "~>") {
    const bounds = pessimisticBounds(operand);
    if (!bounds) return undefined;
    return `>=${bounds[0]} <${bounds[1]}`;
  }

  const version = normalizeVersion(operand);
  if (!version) return undefined;

  switch (op) {
    case "==":
      return `=${version}`;
    case ">=":
      return `>=${version}`;
    case "<=":
      return `<=${version}`;
    case ">":
      return `>${version}`;
    case "<":
      return `<${version}`;
    // `!=` has no semver-range equivalent; treat requirement as unknown.
    default:
      return undefined;
  }
}

/**
 * Translate an Elixir requirement string into an equivalent semver range.
 *
 * Returns `undefined` when the requirement contains a construct we cannot
 * translate (e.g. `!=`), so callers can fall back to a safe default.
 */
export function toSemverRange(requirement: string): string | undefined {
  const orGroups = requirement.trim().split(/\s+or\s+/);
  const converted: string[] = [];

  for (const group of orGroups) {
    const ands = group.split(/\s+and\s+/);
    const atoms: string[] = [];

    for (const atom of ands) {
      const c = convertAtom(atom);
      if (c === undefined) return undefined;
      atoms.push(c);
    }

    converted.push(atoms.join(" "));
  }

  return converted.join(" || ");
}

/**
 * Whether a concrete version satisfies an Elixir requirement.
 *
 * When the requirement cannot be translated (unsupported operator), we
 * conservatively return `true` so we never destructively rewrite something we
 * do not understand.
 */
export function satisfiesRequirement(version: string, requirement: string): boolean {
  const range = toSemverRange(requirement);
  if (range === undefined) return true;

  return semver.satisfies(version, range, { includePrerelease: true, loose: true });
}

function rewriteAtom(atom: string, version: string): string {
  const parsed = semver.parse(version, { loose: true });
  if (!parsed) return atom;

  const m = OPERATOR_RE.exec(atom.trim());
  if (!m || !m[1]) return version; // bare version: exact requirement

  const op = m[1];
  const operand = m[2].trim();

  switch (op) {
    case "~>": {
      // preserve `~>` precision (2 vs 3 segments)
      const segments = operand.split("-")[0]!.split(".").length;
      if (segments <= 2) return `~> ${parsed.major}.${parsed.minor}`;
      const pre = parsed.prerelease.length > 0 ? `-${parsed.prerelease.join(".")}` : "";
      return `~> ${parsed.major}.${parsed.minor}.${parsed.patch}${pre}`;
    }
    case "==":
      return `== ${version}`;
    case ">=":
      return `>= ${version}`;
    case ">":
      // widen a strict lower bound so the new version is accepted
      return `>= ${version}`;
    case "<=":
      return `<= ${version}`;
    case "<":
      // extend the upper bound past the new version's major
      return `< ${parsed.major + 1}.0.0`;
    default:
      return atom;
  }
}

/**
 * Rewrite a requirement so it accepts `version`, preserving operator style and
 * `~>` precision. Compound `and` requirements are rewritten conjunct-by-conjunct
 * (only the failing conjuncts change). `or` requirements are only best-effort.
 */
export function updateRequirement(requirement: string, version: string): string {
  const trimmed = requirement.trim();

  // best-effort for `or`: rewrite the whole thing as the first branch made to fit
  if (/\s+or\s+/.test(trimmed)) {
    const [first = trimmed] = trimmed.split(/\s+or\s+/);
    return updateRequirement(first, version);
  }

  const conjuncts = trimmed.split(/\s+and\s+/);
  const rewritten = conjuncts.map((atom) => {
    const t = atom.trim();
    return satisfiesRequirement(version, t) ? t : rewriteAtom(t, version);
  });

  return rewritten.join(" and ");
}
