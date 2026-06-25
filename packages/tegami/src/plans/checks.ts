import type { TegamiContext } from "../context";
import { handlePluginError } from "../utils/error";
import { PublishPlan, initPublishPlan, runPreflights } from "./publish";

export type PublishPlanStatus = "success" | "pending";

export async function publishPlanStatus(
  plan: PublishPlan,
  context: TegamiContext,
): Promise<PublishPlanStatus> {
  for (const pkg of plan.packages.values()) {
    if (!pkg.preflight) throw new Error("Should perform preflight before checking plan status.");

    const shouldPublish = pkg.preflight.publish ?? true;
    if (shouldPublish) return "pending";
  }

  try {
    await Promise.all(
      context.plugins.map(async (plugin) => {
        const status = await handlePluginError(plugin, "resolvePlanStatus", () =>
          plugin.resolvePlanStatus?.call(context, { plan }),
        );

        if (status === "pending") throw "pending";
      }),
    );

    return "success";
  } catch (e) {
    if (e === "pending") return "pending";
    throw e;
  }
}

export async function assertPublishPlanFinished(context: TegamiContext): Promise<void> {
  const plan = await initPublishPlan(context, {});
  if (!plan) return;

  await runPreflights(context, plan);
  const status = await publishPlanStatus(plan, context);

  if (status === "pending") {
    throw new Error(
      `Publish lock at ${context.lockPath} is still pending. Publish it before applying a new draft.`,
    );
  }
}
