import type { TegamiContext } from "../../src/context";
import {
  PackagePublishTask,
  collectPublishTasks,
  runPublishTasks,
  type PackagePublishTaskResult,
  type PublishPlan,
  type PublishTaskRunContext,
} from "../../src/plans/publish";
import type { TegamiPlugin } from "../../src/types";

/** Gives synthetic plans a no-op package task for their pre-populated plan-level result. */
class PresetPackagePublishTask extends PackagePublishTask {
  async publish({ plan }: PublishTaskRunContext): Promise<PackagePublishTaskResult> {
    const result = plan.packages.get(this.pkg.id)?.publishResult;
    if (result?.type === "published" || result?.type === "skipped") return result;
    return { type: "skipped" } satisfies PackagePublishTaskResult;
  }
}

const presetPackagePublisher: TegamiPlugin = {
  name: "test:preset-package-publisher",
  publishTasks({ plan }) {
    return plan
      .getPackagesToPublish()
      .filter(
        (pkg) =>
          !plan.tasks.some((task) => task instanceof PackagePublishTask && task.pkg.id === pkg.id),
      )
      .map((pkg) => new PresetPackagePublishTask(pkg));
  },
};

/** create & run the publish tasks of the given plugins, throwing the first task error */
export async function runPluginTasks(
  plugins: TegamiPlugin | TegamiPlugin[],
  context: TegamiContext,
  plan: PublishPlan,
): Promise<void> {
  const pluginList = Array.isArray(plugins) ? plugins : [plugins];
  const tasks = await collectPublishTasks(
    {
      ...context,
      plugins: [...pluginList, presetPackagePublisher],
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
