import { describe, expect, test } from "vitest";
import { getField, parseZon, parseZonObject } from "../src/zon";

describe("ZON parser", () => {
  test("parses ZON primitive literals", () => {
    expect(parseZon("true")).toMatchObject({ kind: "literal", value: "true" });
    expect(parseZon("false")).toMatchObject({ kind: "literal", value: "false" });
    expect(parseZon("null")).toMatchObject({ kind: "literal", value: "null" });
    expect(parseZon("123_456")).toMatchObject({ kind: "literal", value: "123_456" });
    expect(parseZon("-42")).toMatchObject({ kind: "literal", value: "-42" });
    expect(parseZon("- 42")).toMatchObject({ kind: "literal", value: "-42" });
    expect(parseZon("1.5e-2")).toMatchObject({ kind: "literal", value: "1.5e-2" });
    expect(parseZon("0x1.fp10")).toMatchObject({ kind: "literal", value: "0x1.fp10" });
    expect(parseZon("nan")).toMatchObject({ kind: "literal", value: "nan" });
    expect(parseZon("inf")).toMatchObject({ kind: "literal", value: "inf" });
  });

  test("parses enum literals and quoted identifiers", () => {
    expect(parseZon(".release_fast")).toMatchObject({ kind: "enum", value: "release_fast" });
    expect(parseZon('.@"core-lib"')).toMatchObject({ kind: "enum", value: "core-lib" });
    expect(parseZon('. @"core-lib"')).toMatchObject({ kind: "enum", value: "core-lib" });
  });

  test("parses string, multiline string, and character literals", () => {
    expect(parseZon(String.raw`"hello\n\u{1f44b}"`)).toMatchObject({
      kind: "string",
      value: "hello\n👋",
    });
    expect(parseZon(String.raw`'a'`)).toMatchObject({ kind: "char", value: "a" });
    expect(parseZon(String.raw`'👋'`)).toMatchObject({ kind: "char", value: "👋" });
    expect(parseZon(String.raw`'\n'`)).toMatchObject({ kind: "char", value: "\n" });
    expect(
      parseZon(String.raw`\\first
        \\second`),
    ).toMatchObject({
      kind: "multiline-string",
      value: "first\nsecond",
    });
  });

  test("parses anonymous struct and tuple literals", () => {
    const struct = parseZonObject(`\uFEFF. {
      . name = .@"core-lib",
      .version = "1.0.0",
      .dependencies = .{
        .api = .{
          .path = "packages/api",
        },
      },
    }`);

    expect(getField(struct, "name")?.value).toMatchObject({ kind: "enum", value: "core-lib" });
    const dependencies = getField(struct, "dependencies")?.value;
    expect(dependencies?.kind).toBe("object");
    expect(dependencies?.kind === "object" && getField(dependencies, "api")?.value).toMatchObject({
      kind: "object",
    });

    const tuple = parseZon(`.{ true, false, null, "src/main.zig" }`);
    expect(tuple).toMatchObject({
      kind: "object",
      fields: [],
      items: [
        { kind: "literal", value: "true" },
        { kind: "literal", value: "false" },
        { kind: "literal", value: "null" },
        { kind: "string", value: "src/main.zig" },
      ],
    });

    expect(parseZon(".{}")).toMatchObject({ kind: "object", fields: [], items: [] });
  });

  test("accepts comments and trailing commas", () => {
    const parsed = parseZonObject(`.{
      // regular Zig comments are trivia
      .paths = .{
        "build.zig",
        "build.zig.zon",
      },
    }`);

    const paths = getField(parsed, "paths")?.value;
    expect(paths).toMatchObject({
      kind: "object",
      items: [
        { kind: "string", value: "build.zig" },
        { kind: "string", value: "build.zig.zon" },
      ],
    });
  });

  test("rejects syntax outside the supported ZON subset", () => {
    expect(() => parseZonObject(`.{ .name = .root .version = "1.0.0" }`)).toThrow(/Expected ","/);
    expect(() => parseZon(`.{ .name = .root, "tuple item" }`)).toThrow(/cannot mix/);
    expect(() => parseZonObject(`"primitive root"`)).toThrow(/root .\{\} object/);
    expect(() => parseZon(String.raw`"bad \q escape"`)).toThrow(/Invalid escape/);
    expect(() =>
      parseZon(`"bad
string"`),
    ).toThrow(/Unterminated string/);
    expect(() => parseZon(String.raw`'\u{110000}'`)).toThrow(/Invalid unicode escape/);
    expect(() => parseZon("+42")).toThrow(/Unsupported ZON literal/);
    expect(() => parseZon("identifier")).toThrow(/Unsupported ZON literal/);
    expect(() => parseZon(".{ .value = SomeType }")).toThrow(/Unsupported ZON literal/);
  });
});
