import { describe, expect, test } from "vitest";
import { joinPath } from "../src/utils/common";

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
