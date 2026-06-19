import type { PackageGraph } from "../graph";
import type { BumpType } from "./semver";

/**
 * Conventional commit header per conventionalcommits.org and semantic-release defaults.
 * @see https://www.conventionalcommits.org/en/v1.0.0/
 */
const CONVENTIONAL_COMMIT_HEADER =
  /^(?<type>\w+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?: (?<title>.+)$/;

const BREAKING_CHANGE_FOOTER = /^BREAKING[ -]CHANGE:/m;

export interface ParsedConventionalCommit {
  type: string;
  packages: string[];
  breaking: boolean;
  title: string;
}

/** Parse conventional commits and resolve scopes against the workspace graph. */
export function createConventionalCommitParser(graph: PackageGraph) {
  const byShortName = new Map<string, string[]>();

  for (const pkg of graph.getPackages()) {
    const slash = pkg.name.lastIndexOf("/");
    const short = slash >= 0 ? pkg.name.slice(slash + 1) : pkg.name;
    const names = byShortName.get(short);
    if (names) names.push(pkg.name);
    else byShortName.set(short, [pkg.name]);
  }

  function resolvePackages(scope: string | undefined): string[] {
    if (!scope) return [];

    const packages = new Set<string>();
    for (const item of scope.split(",")) {
      const name = item.trim();
      if (!name) continue;

      const direct = graph.getByName(name);
      if (direct.length > 0) {
        for (const pkg of direct) packages.add(pkg.name);
        continue;
      }

      const byShort = byShortName.get(name);
      if (byShort) {
        for (const pkgName of byShort) packages.add(pkgName);
        continue;
      }

      packages.add(name);
    }

    return Array.from(packages);
  }

  return function parseConventionalCommit(
    subject: string,
    body = "",
  ): ParsedConventionalCommit | undefined {
    const match = CONVENTIONAL_COMMIT_HEADER.exec(subject.trim());
    if (!match?.groups) return;

    const { type, scope, breaking, title } = match.groups;
    if (!type || !title) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    const trimmedScope = scope?.trim();
    return {
      type: type.toLowerCase(),
      packages: resolvePackages(trimmedScope || undefined),
      breaking: Boolean(breaking) || BREAKING_CHANGE_FOOTER.test(body),
      title: trimmedTitle,
    };
  };
}

/** Map releasable conventional commit types to semver bumps (semantic-release defaults). */
export function conventionalCommitToBump(type: string, breaking: boolean): BumpType | undefined {
  if (breaking) return "major";
  switch (type) {
    case "feat":
      return "minor";
    case "fix":
    case "perf":
    case "revert":
      return "patch";
    default:
      return;
  }
}
