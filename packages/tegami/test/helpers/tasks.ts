import type { TegamiContext } from "../../src/context";
import { createPublishTasksContext, type PublishPlan } from "../../src/plans/publish";
import type { TegamiPlugin } from "../../src/types";
import { runPublishTasks, type PublishTask } from "../../src/utils/task";

async function createTasks(
  plugins: TegamiPlugin | TegamiPlugin[],
  context: TegamiContext,
  plan: PublishPlan,
): Promise<PublishTask[]> {
  const hookContext = createPublishTasksContext(context, plan);
  const tasks: PublishTask[] = [];
  for (const plugin of Array.isArray(plugins) ? plugins : [plugins]) {
    const created = await plugin.publishTasks?.call(context, hookContext);
    if (created) tasks.push(...created);
  }

  for (const task of tasks) task.link?.({ context, plan, tasks });
  return tasks;
}

/** create & run the publish tasks of the given plugins, throwing the first task error */
export async function runPluginTasks(
  plugins: TegamiPlugin | TegamiPlugin[],
  context: TegamiContext,
  plan: PublishPlan,
): Promise<void> {
  const tasks = await createTasks(plugins, context, plan);
  const states = await runPublishTasks(tasks, { context, plan });

  for (const state of states.values()) {
    if (state.status === "failed") throw state.error;
  }
}

/** resolve the aggregated status of the given plugins' publish tasks */
export async function pluginTaskStatus(
  plugins: TegamiPlugin | TegamiPlugin[],
  context: TegamiContext,
  plan: PublishPlan,
): Promise<"pending" | undefined> {
  const tasks = await createTasks(plugins, context, plan);

  for (const task of tasks) {
    if ((await task.status?.({ context, plan, tasks })) === "pending") return "pending";
  }
}
