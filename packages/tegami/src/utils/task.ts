import type { TegamiContext } from "../context";
import type { PublishPlan } from "../plans/publish";
import type { Awaitable } from "../types";

/** additional metadata of publish tasks, can be extended from other places */
export interface PublishTaskMetadata {}

export interface PublishTaskContext {
  context: TegamiContext;
  plan: PublishPlan;
  /** every publish task of the run */
  tasks: PublishTask[];
}

export interface PublishTaskRunContext extends PublishTaskContext {
  /** inspect the outcome of a settled task, `undefined` when the task has not settled */
  getTaskResult: <J>(task: PublishTask<J>) => PublishTaskState<J> | undefined;
}

// merge the optional metadata fields into the class, safe since every member is optional
// oxlint-disable-next-line no-unused-vars, no-unsafe-declaration-merging
export interface PublishTask<T = unknown> extends PublishTaskMetadata {}

export abstract class PublishTask<T = unknown> {
  /** a short title for the task */
  abstract name: string;
  /** describe the purpose of the task */
  description?: string;
  /**
   * Tasks that must settle before this one runs, they must be part of the publish tasks,
   * and circular `wait` relationships are rejected with an error. Duplicated items are allowed.
   *
   * Failed tasks don't prevent this task from running, inspect them with `getTaskResult`.
   */
  wait: PublishTask[] = [];
  /**
   * Like `wait`, but the waited tasks may not be part of the publish tasks (ignored),
   * and edges that close a dependency cycle are dropped to break the cycle.
   */
  optionalWait: PublishTask[] = [];

  abstract run(opts: PublishTaskRunContext): Awaitable<T>;

  /** link task-level dependencies, called after every task is created */
  link?(opts: PublishTaskContext): void;

  /**
   * Check if the task's effects are already applied (e.g. from a previous run), without running it.
   *
   * Used to resolve publish plan status, return nothing when the task has no opinion.
   */
  status?(opts: PublishTaskContext): Awaitable<"done" | "pending" | void | undefined>;
}

export type PublishTaskState<T = unknown> =
  | { status: "success"; result: T }
  | { status: "failed"; error: Error };

/**
 * Run tasks concurrently, respecting their `wait` & `optionalWait` relationships
 * (see {@link scheduleTasks} for how cycles are resolved).
 *
 * Failed tasks never prevent dependents from running, tasks can inspect the outcome of
 * their waited tasks with `getTaskResult` and decide on their own.
 *
 * Errors thrown by tasks are captured into the returned states, never thrown.
 */
export async function runPublishTasks(
  tasks: PublishTask[],
  {
    context,
    plan,
    concurrency = 5,
  }: {
    context: TegamiContext;
    plan: PublishPlan;
    /** max amount of concurrently running tasks */
    concurrency?: number;
  },
): Promise<Map<PublishTask, PublishTaskState>> {
  const schedule = scheduleTasks(tasks);
  const queue = [...schedule.keys()];

  const states = new Map<PublishTask, PublishTaskState>();
  const runContext: PublishTaskRunContext = {
    plan,
    context,
    tasks,
    getTaskResult<J>(task: PublishTask<J>) {
      return states.get(task) as PublishTaskState<J> | undefined;
    },
  };

  async function run(task: PublishTask) {
    try {
      states.set(task, { status: "success", result: await task.run(runContext) });
    } catch (e) {
      states.set(task, {
        status: "failed",
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }

  while (queue.length > 0) {
    // take the next tasks whose dependencies settled, the head is always ready
    const chunk: PublishTask[] = [];
    for (let i = 0; i < queue.length && chunk.length < concurrency;) {
      const task = queue[i]!;
      if (schedule.get(task)!.every((dep) => states.has(dep))) {
        chunk.push(task);
        queue.splice(i, 1);
      } else {
        i++;
      }
    }

    await Promise.all(chunk.map(run));
  }

  return states;
}

/**
 * Schedule tasks into execution order, resolving their dependencies in a single scan:
 *
 * - `wait` edges must reference known tasks, circular `wait` relationships throw.
 * - `optionalWait` edges referencing unknown tasks or closing a dependency cycle are dropped,
 *   so the resolved graph is always acyclic.
 *
 * The returned map iterates in execution order (a topological order of the dependency
 * graph), each task mapped to the dependencies it waits for at run-time.
 */
function scheduleTasks(tasks: PublishTask[]): Map<PublishTask, PublishTask[]> {
  const taskSet = new Set(tasks);
  const resolved = new Map<PublishTask, PublishTask[]>();
  /** task -> true while scanning `wait`, false while scanning `optionalWait` */
  const stack = new Map<PublishTask, boolean>();

  /** returns `false` when the edge to this task must be dropped to break a cycle */
  function scan(task: PublishTask): boolean {
    switch (stack.get(task)) {
      case true:
        throw new Error(
          `circular reference of deps: ${[...stack.keys(), task].map((t) => t.name).join(" -> ")}`,
        );
      case false:
        return false;
    }
    if (resolved.has(task)) return true;

    const deps: PublishTask[] = [];
    stack.set(task, true);
    for (const dep of task.wait) {
      if (!taskSet.has(dep)) {
        throw new Error(
          `Task "${task.name}" waits on task "${dep.name}" which is not part of the publish tasks.`,
        );
      }
      if (scan(dep)) deps.push(dep);
    }

    stack.set(task, false);
    for (const dep of task.optionalWait) {
      if (!taskSet.has(dep) || dep === task) continue;
      if (scan(dep)) deps.push(dep);
    }

    stack.delete(task);
    resolved.set(task, deps);
    return true;
  }

  for (const task of tasks) scan(task);
  return resolved;
}
