import type { PackageGraph } from "../../src/graph";
import type { DraftPlan, PackagePlan } from "../../src/plans/draft";

export function getPendingPackageIds(draft: DraftPlan, graph: PackageGraph): string[] {
  return graph
    .getPackages()
    .filter((pkg) => draft.getPackagePlan(pkg.id)?.type)
    .map((pkg) => pkg.id);
}

export function normalizePackagePlan(plan: PackagePlan | undefined) {
  if (!plan) return undefined;

  const { changelogs, ...rest } = plan;
  return {
    changelogIds: changelogs?.map((entry) => entry.id),
    ...rest,
  };
}
