import type { LogGenerator } from "../types";

export function simpleGenerator(): LogGenerator {
  return {
    generate({ changelogs, version }) {
      const lines = [
        `## ${version}`,
        "",
        ...changelogs.flatMap((entry) => [`### ${entry.title}`, "", entry.content, ""]),
      ];

      return lines.join("\n").trim();
    },
  };
}
