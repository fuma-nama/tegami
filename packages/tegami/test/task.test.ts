import { describe, expect, test } from "vitest";
import type { TegamiContext } from "../src/context";
import type { PublishPlan } from "../src/plans/publish";
import {
  PublishTask,
  runPublishTasks,
  type PublishTaskRunContext,
  type PublishTaskState,
} from "../src/utils/task";

class TestTask extends PublishTask<string> {
  constructor(
    public name: string,
    private readonly fn?: (opts: PublishTaskRunContext) => Promise<string> | string,
  ) {
    super();
  }

  async run(opts: PublishTaskRunContext): Promise<string> {
    return (await this.fn?.(opts)) ?? this.name;
  }
}

function testTask(name: string, run?: (opts: PublishTaskRunContext) => Promise<string> | string) {
  return new TestTask(name, run);
}

function base() {
  return {
    context: {} as TegamiContext,
    plan: {} as PublishPlan,
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("publish tasks", () => {
  test("runs tasks after their waits", async () => {
    const order: string[] = [];
    const record = (name: string) => {
      order.push(name);
      return name;
    };

    const a = testTask("a", async () => {
      await sleep(10);
      return record("a");
    });
    const b = testTask("b", () => record("b"));
    const c = testTask("c", () => record("c"));
    b.wait = [a];
    c.wait = [b];

    const states = await runPublishTasks([c, b, a], base());
    expect(order).toEqual(["a", "b", "c"]);
    expect([...states.values()].every((state) => state.status === "success")).toBe(true);
  });

  test("limits concurrently running tasks", async () => {
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 6 }, (_, i) => {
      return testTask(`task-${i}`, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(10);
        active--;
        return "done";
      });
    });

    await runPublishTasks(tasks, { ...base(), concurrency: 2 });
    expect(maxActive).toBe(2);
  });

  test("throws on circular waits", async () => {
    const a = testTask("a");
    const b = testTask("b");
    a.wait = [b];
    b.wait = [a];

    await expect(runPublishTasks([a, b], base())).rejects.toThrow(
      /circular reference of deps: a -> b -> a|circular reference of deps: b -> a -> b/,
    );
  });

  test("throws when a wait is not part of the tasks", async () => {
    const missing = testTask("missing");
    const a = testTask("a");
    a.wait = [missing];

    await expect(runPublishTasks([a], base())).rejects.toThrow(/not part of the publish tasks/);
  });

  test("breaks circular optional waits", async () => {
    const a = testTask("a");
    const b = testTask("b");
    a.optionalWait = [b];
    b.optionalWait = [a];

    const states = await runPublishTasks([a, b], base());
    expect(states.get(a)).toEqual({ status: "success", result: "a" });
    expect(states.get(b)).toEqual({ status: "success", result: "b" });
  });

  test("preserves ordering of the honored edge in circular optional waits", async () => {
    const order: string[] = [];
    const a = testTask("a", () => {
      order.push("a");
      return "a";
    });
    const b = testTask("b", () => {
      order.push("b");
      return "b";
    });
    a.optionalWait = [b];
    b.optionalWait = [a];

    // only the edge closing the cycle (b -> a) is dropped, a still prefers running after b
    await runPublishTasks([a, b], base());
    expect(order).toEqual(["b", "a"]);
  });

  test("rejects cycles closed through a wait edge", async () => {
    const a = testTask("a");
    const b = testTask("b");
    a.wait = [b];
    b.optionalWait = [a];

    await expect(runPublishTasks([a, b], base())).rejects.toThrow(/circular reference of deps/);
  });

  test("still runs dependents of failed tasks, exposing the failure", async () => {
    const failing = testTask("failing", () => {
      throw new Error("task failed");
    });

    let observed: PublishTaskState<string> | undefined;
    const dependent = testTask("dependent", ({ getTaskResult }) => {
      observed = getTaskResult(failing);
      return "dependent";
    });
    dependent.wait = [failing];

    const states = await runPublishTasks([failing, dependent], base());
    expect(states.get(failing)).toMatchObject({
      status: "failed",
      error: new Error("task failed"),
    });
    expect(states.get(dependent)).toEqual({ status: "success", result: "dependent" });
    expect(observed).toMatchObject({ status: "failed", error: new Error("task failed") });
  });

  test("exposes results of finished tasks through getTaskResult", async () => {
    const producer = testTask("producer", () => "produced value");

    let received: PublishTaskState<string> | undefined;
    const consumer = testTask("consumer", ({ getTaskResult }) => {
      received = getTaskResult(producer);
      return "consumer";
    });
    consumer.wait = [producer];

    await runPublishTasks([producer, consumer], base());
    expect(received).toEqual({ status: "success", result: "produced value" });
  });
});
