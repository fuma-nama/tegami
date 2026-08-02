import { describe, expect, test } from "vitest";
import { findPromiseIndex, joinPath } from "../src/utils/common";

describe("findPromiseIndex", () => {
  test("resolves the first matching index across sync and async values", async () => {
    await expect(findPromiseIndex([1, Promise.resolve(2), 3], (v) => v === 3)).resolves.toBe(2);
    await expect(findPromiseIndex([Promise.resolve(1), 2], (v) => v === 9)).resolves.toBe(-1);
    await expect(findPromiseIndex([], () => true)).resolves.toBe(-1);
  });

  test("rejects when a promise rejects before a match", async () => {
    await expect(
      findPromiseIndex([Promise.reject(new Error("boom")), 1], (v) => v === 9),
    ).rejects.toThrow("boom");
  });

  test("handles promise rejections after a synchronous match", async () => {
    let rejectLater!: (error: Error) => void;
    const later = new Promise<number>((_, reject) => {
      rejectLater = reject;
    });

    // a rejection after the sync match must not surface as an unhandled rejection
    await expect(findPromiseIndex([1, later], (v) => v === 1)).resolves.toBe(0);
    rejectLater(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

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
