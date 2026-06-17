import type { LogGenerator } from "../types";
import { formatPackageVersion } from "../utils/semver";

export function simpleGenerator(): LogGenerator {
  return {
    generate({ changelogs, version, packageName, plan }) {
      const lines = [`## ${formatPackageVersion(packageName, version, plan.npm?.distTag)}`, ""];

      for (const entry of changelogs) {
        if (entry.subject) lines.push(`### \`${entry.filename}\` (${entry.subject})`, "");
        else lines.push(`### \`${entry.filename}\``, "");

        for (const section of entry.sections) {
          lines.push(`#### ${section.title}`, "", section.content, "");
        }
      }

      return lines.join("\n").trim();
    },
  };
}
