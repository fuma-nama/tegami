import type { ChangelogEntry } from "../changelog/parse";
import type { TegamiContext } from "../context";
import type { LogGenerator } from "../types";
import { bumpName, BumpType, formatPackageVersion } from "../utils/semver";

export function simpleGenerator(): LogGenerator {
  return {
    generate({ changelogs, version, packageId, packageName, plan }) {
      const lines = [`## ${formatPackageVersion(packageName, version, plan.npm?.distTag)}`, ""];

      for (const entry of changelogs) {
        const bumpType = getPackageBumpType(this, packageId, entry);
        let sectionDepth = 4;
        if (entry.subject) lines.push(`### ${entry.subject}`, "");
        else if (bumpType) lines.push(`### ${bumpName(bumpType)}`, "");
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

function getPackageBumpType(
  context: TegamiContext,
  packageId: string,
  changelog: ChangelogEntry,
): BumpType | undefined {
  const { graph } = context;

  for (const [name, bumpType] of changelog.packages) {
    const entities = graph.getByName(name);

    if (entities.some((entity) => entity.id === packageId)) {
      return bumpType;
    }
  }
}
