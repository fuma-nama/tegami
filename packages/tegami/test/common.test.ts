import { describe, expect, test } from "vitest";
import { findConcurrent, joinPath, runConcurrent } from "../src/utils/common";

describe("joinPath", () => {
  test("joins segments with a single separator", () => {
    expect(joinPath("a", "b")).toBe("a/b");
    expect(joinPath("a/", "b")).toBe("a/b");
    expect(joinPath("a", "/b")).toBe("a/b");
  });

  test("collapses the separator when both sides carry a slash", () => {
    expect(joinPath("a/", "/b")).toBe("a/b");
    expect(joinPath("https://gitlab.com/api/v4/", "/projects/x")).toBe(
      "https://gitlab.com/api/v4/projects/x",
    );
  });

  test("skips empty segments", () => {
    expect(joinPath("a", "", "b")).toBe("a/b");
    expect(joinPath("", "a")).toBe("a");
  });
});

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** runs `fn` while tracking how many calls overlap */
function tracked<T, R>(fn: (item: T) => Promise<R>) {
  let active = 0;
  const state = { maxActive: 0, started: [] as T[] };

  return [
    async (item: T) => {
      state.started.push(item);
      active++;
      state.maxActive = Math.max(state.maxActive, active);
      try {
        return await fn(item);
      } finally {
        active--;
      }
    },
    state,
  ] as const;
}

describe("runConcurrent", () => {
  test("keeps the order of the items", async () => {
    const items = [30, 1, 20, 10];
    await expect(
      runConcurrent(items, 2, async (ms, index) => {
        await sleep(ms);
        return `${index}:${ms}`;
      }),
    ).resolves.toEqual(["0:30", "1:1", "2:20", "3:10"]);
  });

  test("runs at most `concurrency` items at a time", async () => {
    const [fn, state] = tracked(async () => sleep(10));

    await runConcurrent(
      Array.from({ length: 6 }, (_, i) => i),
      2,
      fn,
    );
    expect(state.maxActive).toBe(2);
    expect(state.started).toHaveLength(6);
  });

  test("rejects with the first failure", async () => {
    await expect(
      runConcurrent([1, 2, 3], 1, (item) => {
        if (item === 2) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
  });

  test("handles fewer items than the limit", async () => {
    await expect(runConcurrent([1], 5, (item) => item * 2)).resolves.toEqual([2]);
    await expect(runConcurrent([], 5, () => 1)).resolves.toEqual([]);
  });
});

describe("findConcurrent", () => {
  test("resolves the matching item and skips the ones left", async () => {
    const [fn, state] = tracked(async (item: number) => item === 1);

    await expect(findConcurrent([0, 1, 2, 3], 1, fn)).resolves.toBe(1);
    expect(state.started).toEqual([0, 1]);
  });

  test("resolves undefined when nothing matches", async () => {
    await expect(findConcurrent([0, 1, 2], 2, (item) => item === 9)).resolves.toBeUndefined();
    await expect(findConcurrent([], 2, () => true)).resolves.toBeUndefined();
  });

  test("runs at most `concurrency` items at a time", async () => {
    const [fn, state] = tracked(async () => {
      await sleep(10);
      return false;
    });

    await findConcurrent(
      Array.from({ length: 6 }, (_, i) => i),
      2,
      fn,
    );
    expect(state.maxActive).toBe(2);
  });

  test("rejects with the first failure", async () => {
    await expect(
      findConcurrent([1, 2, 3], 1, (item) => {
        if (item === 2) throw new Error("boom");
        return false;
      }),
    ).rejects.toThrow("boom");
  });
});
