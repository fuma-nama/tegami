import type { TegamiContext } from "../../src/context";
import { collectPublishTasks, runPublishTasks, type PublishPlan } from "../../src/plans/publish";
import type { TegamiPlugin } from "../../src/types";

/** create & run the publish tasks of the given plugins, throwing the first task error */
export async function runPluginTasks(
  plugins: TegamiPlugin | TegamiPlugin[],
  context: TegamiContext,
  plan: PublishPlan,
): Promise<void> {
  const tasks = await collectPublishTasks(
    {
      ...context,
      plugins: Array.isArray(plugins) ? plugins : [plugins],
    },
    plan,
  );
  await runPublishTasks(tasks, { context, plan });

  for (const task of tasks) {
    const state = task.getResult();
    if (state?.status === "failed") throw state.error;
  }
}

/** resolve the aggregated status of the given plugins' publish tasks */
export async function pluginTaskStatus(
  plugins: TegamiPlugin | TegamiPlugin[],
  context: TegamiContext,
  plan: PublishPlan,
): Promise<"pending" | undefined> {
  const tasks = await collectPublishTasks(
    {
      ...context,
      plugins: Array.isArray(plugins) ? plugins : [plugins],
    },
    plan,
  );

  for (const task of tasks) {
    if ((await task.status?.({ context, plan })) === "pending") return "pending";
  }
}
