import type { ChangelogEntry } from "../../src/changelog/parse";
import type { PackageGraph, WorkspacePackage } from "../../src/graph";
import type {
  PackagePublishPlan,
  PackagePublishResult,
  PublishPlan,
} from "../../src/plans/publish";
import type { PublishPreflight } from "../../src/types";

export function publishPlan(
  graph: PackageGraph,
  options: {
    dryRun?: boolean;
    packages?: Array<{
      pkg: WorkspacePackage;
      preflight?: PublishPreflight;
      publishResult?: PackagePublishResult;
      git?: { tag: string };
      npm?: { distTag?: string };
      changelogs?: ChangelogEntry[];
      updated?: boolean;
    }>;
  } = {},
): PublishPlan {
  const packages = new Map<string, PackagePublishPlan>();

  for (const entry of options.packages ?? []) {
    const { pkg } = entry;
    packages.set(pkg.id, {
      changelogs: entry.changelogs ?? [],
      updated: entry.updated ?? true,
      git: entry.git ?? { tag: `${pkg.name}@${pkg.version}` },
      npm: entry.npm,
      preflight: entry.preflight ?? { shouldPublish: true },
      publishResult: entry.publishResult ?? { type: "published" },
    });
  }

  if (packages.size === 0) {
    for (const pkg of graph.getPackages()) {
      packages.set(pkg.id, {
        changelogs: [],
        updated: true,
        git: { tag: `${pkg.name}@${pkg.version}` },
        npm: { distTag: "latest" },
        preflight: { shouldPublish: true },
        publishResult: { type: "published" },
      });
    }
  }

  return {
    options: { dryRun: options.dryRun },
    changelogs: new Map(),
    packages,
  };
}
