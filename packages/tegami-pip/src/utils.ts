import { RANGE_PATTERN } from "@renovatebot/pep440";
import { joinPath, fetchFailure } from "tegami/utils";
import typia from "typia";
import type { SimpleIndexProject } from "./schema";

const validateSimpleIndexProject: (input: unknown) => typia.IValidation<SimpleIndexProject> =
  typia.createValidate<SimpleIndexProject>();

const COMPARATOR = new RegExp(`^${RANGE_PATTERN}$`, "i");

/** PEP 503 name normalization for PyPI index URLs. */
export function normalizePyPiName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

export function updateConstraintRange(range: string, version: string): string {
  return range
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const match = COMPARATOR.exec(trimmed);
      if (!match?.groups?.operator) return trimmed;

      const op = match.groups.operator;
      if (op === ">=" || op === ">" || op === "~=" || op === "==") {
        return `${op}${version}`;
      }

      return trimmed;
    })
    .join(",");
}

export async function isPackagePublished(
  normalizedName: string,
  version: string,
  indexUrl: string,
) {
  const response = await fetch(joinPath(indexUrl, encodeURIComponent(normalizedName), "/"), {
    headers: { Accept: "application/vnd.pypi.simple.v1+json" },
  });

  if (response.status === 404) return false;
  if (!response.ok) {
    throw await fetchFailure(
      `Unable to validate ${normalizedName}@${version} on ${indexUrl}`,
      response,
    );
  }

  const validated = validateSimpleIndexProject(await response.json());
  const data = validated.success ? validated.data : undefined;
  if (!data?.files || data.files.length === 0) return false;

  const dist = escapeRegex(normalizedName);
  const ver = escapeRegex(version);
  const wheel = new RegExp(`^${dist}-${ver}(?:-\\d[^-]*)?-.+\\.whl$`, "i");
  const sdist = new RegExp(`^${dist}-${ver}\\.(?:tar\\.gz|tar\\.bz2|tar\\.xz|tar|zip)$`, "i");

  return data.files.some(({ filename }) =>
    filename.endsWith(".whl") ? wheel.test(filename) : sdist.test(filename),
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
