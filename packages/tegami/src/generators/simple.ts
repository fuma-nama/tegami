import type { LogGenerator } from "../types";
import { formatPackageVersion } from "../utils/semver";

export function simpleGenerator(): LogGenerator {
  return {
    generate({ changelogs, version, packageName, plan }) {
      const lines = [`## ${formatPackageVersion(packageName, version, plan.npm?.distTag)}`, ""];

      for (const entry of changelogs) {
        let sectionDepth = 4;
        if (entry.subject) lines.push(`### ${entry.subject}`, "");
        else sectionDepth--;

        for (const section of entry.sections) {
          const prefix = "#".repeat(sectionDepth);
          lines.push(`${prefix} ${section.title}`, "", section.content, "");
        }
      }

      return lines.join("\n").trim();
    },
  };
}
