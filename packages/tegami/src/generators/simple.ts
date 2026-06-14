import type { LogGenerator } from "../types";
import { formatPackageVersion } from "../utils/semver";

export function simpleGenerator(): LogGenerator {
  return {
    generate({ changelogs, version, packageName, distTag }) {
      const lines = [
        `## ${formatPackageVersion(packageName, version, distTag)}`,
        "",
        ...changelogs.flatMap((entry) => [`### ${entry.title}`, "", entry.content, ""]),
      ];

      return lines.join("\n").trim();
    },
  };
}
