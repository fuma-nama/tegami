import { describe, expect, test } from "vitest";
import {
  applyEdits,
  declaresPublishing,
  findInvocationStrings,
  findProjectRefs,
  findStringAssignments,
  normalizeProjectPath,
  tokenize,
} from "../src/script";

function topLevel(source: string, name: string) {
  return findStringAssignments(tokenize(source)).filter(
    (assignment) => assignment.name === name && assignment.blockPath.length === 0,
  );
}

describe("build script scanner", () => {
  test("reads top-level assignments in both DSLs", () => {
    expect(topLevel(`version = "1.0.0"`, "version")[0]?.value).toBe("1.0.0");
    // Groovy's parenthesis-free setter
    expect(topLevel(`version '2.0.0'`, "version")[0]?.value).toBe("2.0.0");
    expect(topLevel(`group = "com.acme"`, "group")[0]?.value).toBe("com.acme");
  });

  test("ignores versions declared inside blocks", () => {
    const source = `
plugins {
    id("com.example.thing") version "1.2.3"
}

dependencies {
    implementation("com.other:lib:9.9.9")
}

version = "1.0.0"
`;

    expect(topLevel(source, "version").map((entry) => entry.value)).toEqual(["1.0.0"]);
  });

  test("braces inside strings do not open blocks", () => {
    const source = `
val label = "count: \${values["}"]} done"
version = "1.0.0"
`;

    expect(topLevel(source, "version").map((entry) => entry.value)).toEqual(["1.0.0"]);
  });

  test("skips comments", () => {
    const source = `
// version = "9.9.9"
/* version = "8.8.8"
   still a comment { */
version = "1.0.0"
`;

    expect(topLevel(source, "version").map((entry) => entry.value)).toEqual(["1.0.0"]);
  });

  test("handles triple-quoted strings", () => {
    const kotlin = `
val notes = """
  a raw { block } with "quotes"
"""
version = "1.0.0"
`;
    expect(topLevel(kotlin, "version").map((entry) => entry.value)).toEqual(["1.0.0"]);

    const groovy = `
def notes = '''
  another { raw } block
'''
version = '1.0.0'
`;
    expect(topLevel(groovy, "version").map((entry) => entry.value)).toEqual(["1.0.0"]);
  });

  test("marks interpolated values as unwritable", () => {
    const [assignment] = topLevel(`version = "\${base}.1"`, "version");
    expect(assignment?.interpolated).toBe(true);
  });

  test("finds project dependencies in every call shape", () => {
    const source = `
dependencies {
    implementation(project(":core"))
    api project(':legacy')
    testImplementation(project(path = ":fixtures"))
    runtimeOnly project(path: ':runtime')
    testImplementation(testFixtures(project(":core")))
}
`;

    expect(findProjectRefs(tokenize(source))).toEqual([
      { path: ":core", configuration: "implementation", blockPath: ["dependencies"] },
      { path: ":legacy", configuration: "api", blockPath: ["dependencies"] },
      { path: ":fixtures", configuration: "testImplementation", blockPath: ["dependencies"] },
      { path: ":runtime", configuration: "runtimeOnly", blockPath: ["dependencies"] },
      // the wrapper call must not hide the real configuration
      { path: ":core", configuration: "testImplementation", blockPath: ["dependencies"] },
    ]);
  });

  test("detects publishing setups", () => {
    expect(declaresPublishing(tokenize(`plugins { id("maven-publish") }`))).toBe(true);
    expect(declaresPublishing(tokenize("plugins { `maven-publish` }"))).toBe(true);
    expect(declaresPublishing(tokenize(`plugins { alias(libs.plugins.mavenPublish) }`))).toBe(true);
    expect(declaresPublishing(tokenize(`apply plugin: "maven-publish"`))).toBe(true);
    expect(declaresPublishing(tokenize(`publishing { repositories { } }`))).toBe(true);

    expect(declaresPublishing(tokenize(`plugins { id("java-library") }`))).toBe(false);
    // a convention plugin hides the real setup — the `publish` option is the contract
    expect(declaresPublishing(tokenize(`plugins { id("acme.library-conventions") }`))).toBe(false);
  });

  test("collects settings includes in both DSLs", () => {
    const kotlin = `include(":core", ":api")`;
    expect(findInvocationStrings(tokenize(kotlin), "include").map((token) => token.value)).toEqual([
      ":core",
      ":api",
    ]);

    const groovy = `include ':core', ':api'`;
    expect(findInvocationStrings(tokenize(groovy), "include").map((token) => token.value)).toEqual([
      ":core",
      ":api",
    ]);
  });

  test("flags unterminated strings", () => {
    expect(tokenize(`version = "1.0.0`).some((token) => token.unterminated)).toBe(true);
    expect(tokenize(`version = "1.0.0"`).some((token) => token.unterminated)).toBe(false);
  });

  test("normalizes project paths", () => {
    expect(normalizeProjectPath("core")).toBe(":core");
    expect(normalizeProjectPath(":a:b:")).toBe(":a:b");
    expect(normalizeProjectPath(":")).toBe(":");
  });

  test("applies edits back-to-front", () => {
    const source = `a = "1"; b = "2"`;
    const edits = [
      { start: source.indexOf("1"), end: source.indexOf("1") + 1, text: "one" },
      { start: source.indexOf("2"), end: source.indexOf("2") + 1, text: "two" },
    ];

    expect(applyEdits(source, edits)).toBe(`a = "one"; b = "two"`);
  });
});
