import type { PackageGraph } from "../../src/graph";
import type { Draft, PackageDraft } from "../../src/plans/draft";

export function getPendingPackageIds(draft: Draft, graph: PackageGraph): string[] {
  return graph
    .getPackages()
    .filter((pkg) => {
      const plan = draft.getPackageDraft(pkg.id);
      return plan && plan.bumpVersion(pkg) !== pkg.version;
    })
    .map((pkg) => pkg.id);
}

export function normalizePackagePlan(plan: PackageDraft | undefined) {
  if (!plan) return undefined;

  const { changelogs, ...rest } = plan;
  return {
    changelogIds: changelogs?.map((entry) => entry.id),
    ...rest,
  };
}
