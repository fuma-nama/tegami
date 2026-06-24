import { describe, expect, test } from "vitest";
import { bumpVersion, maxBump } from "../src/utils/semver";

describe("semver helpers", () => {
  test("chooses the highest bump type", () => {
    expect(maxBump("patch", "minor")).toBe("minor");
    expect(maxBump("minor", "major")).toBe("major");
    expect(maxBump("patch", "patch")).toBe("patch");
  });

  test("bumps versions with semver", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  test("bumps prerelease versions", () => {
    expect(bumpVersion("1.0.0", "minor", "alpha")).toBe("1.1.0-alpha.0");
    expect(bumpVersion("1.1.0-alpha.0", "minor", "alpha")).toBe("1.1.0-alpha.1");
    expect(bumpVersion("1.0.0-alpha.2", "major", "alpha")).toBe("1.0.0-alpha.3");
    expect(bumpVersion("1.0.0", "major", "alpha")).toBe("2.0.0-alpha.0");
  });

  test("does not bump when prerelease config matches without a bump type", () => {
    expect(bumpVersion("1.2.3-alpha.1", undefined, "alpha")).toBe("1.2.3-alpha.1");
    expect(bumpVersion("1.1.0-alpha.2", undefined, "alpha")).toBe("1.1.0-alpha.2");
  });

  test("rejects invalid versions", () => {
    expect(() => bumpVersion("not-a-version", "patch")).toThrow(/Invalid semver version/);
  });
});
