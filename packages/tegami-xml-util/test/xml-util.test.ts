import { describe, expect, test } from "vitest";
import { parseDocument } from "../src/index";

describe("parseDocument", () => {
  const pom = `<?xml version="1.0" encoding="UTF-8"?>
<!-- build config -->
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <groupId>com.acme</groupId>
  <artifactId>app</artifactId>
  <version>1.2.3</version>
  <parent>
    <groupId>com.acme</groupId>
    <version>1.0.0</version>
  </parent>
  <build>
    <plugins>
      <plugin>
        <version>9.9.9</version>
      </plugin>
    </plugins>
  </build>
</project>
`;

  test("navigates direct children and paths", () => {
    const doc = parseDocument(pom);
    expect(doc.get("version")?.text).toBe("1.2.3");
    expect(doc.getIn(["parent", "version"])?.text).toBe("1.0.0");
    expect(doc.get("missing")).toBeUndefined();
  });

  test("get returns the project-level version, not nested ones", () => {
    const doc = parseDocument(pom);
    // the plugin <version> is a descendant, must not be picked up by get()
    expect(doc.get("version")?.text).toBe("1.2.3");
    expect(doc.root?.findAll("version").map((v) => v.text)).toEqual(["1.2.3", "1.0.0", "9.9.9"]);
  });

  test("setIn edits only the target element, preserving every other byte", () => {
    const doc = parseDocument(pom);
    expect(doc.setIn(["version"], "2.0.0")).toBe(true);
    const out = doc.toString();

    expect(out).toContain("<version>2.0.0</version>");
    // the parent and plugin versions are untouched
    expect(out).toContain("<version>1.0.0</version>");
    expect(out).toContain("<version>9.9.9</version>");
    // comment, prolog, and namespace preserved
    expect(out).toContain("<!-- build config -->");
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(out).toContain('xmlns="http://maven.apache.org/POM/4.0.0"');
  });

  test("setIn returns false for an unknown path and leaves the source intact", () => {
    const doc = parseDocument(pom);
    expect(doc.setIn(["nope"], "x")).toBe(false);
    expect(doc.toString()).toBe(pom);
  });

  test("preserves whitespace around edited text", () => {
    const doc = parseDocument(`<a>\n  <b>  1.0.0  </b>\n</a>\n`);
    doc.setIn(["b"], "2.0.0");
    expect(doc.toString()).toBe(`<a>\n  <b>  2.0.0  </b>\n</a>\n`);
  });

  test("fills an empty element", () => {
    const doc = parseDocument(`<a><b></b></a>`);
    doc.setIn(["b"], "1.0.0");
    expect(doc.toString()).toBe(`<a><b>1.0.0</b></a>`);
  });

  test("escapes text special characters", () => {
    const doc = parseDocument(`<a><b>x</b></a>`);
    doc.setIn(["b"], "1 < 2 & 3");
    expect(doc.toString()).toBe(`<a><b>1 &lt; 2 &amp; 3</b></a>`);
  });

  test("reads and rewrites attributes", () => {
    const doc = parseDocument(
      `<ItemGroup><PackageReference Include="Acme.Lib" Version="1.0.0" /></ItemGroup>`,
    );
    const ref = doc.root?.find("PackageReference");
    expect(ref?.attr("Include")?.value).toBe("Acme.Lib");
    expect(ref?.attr("Version")?.value).toBe("1.0.0");

    expect(doc.setAttr(ref!, "Version", "2.0.0")).toBe(true);
    expect(doc.setAttr(ref!, "Missing", "x")).toBe(false);
    expect(doc.toString()).toBe(
      `<ItemGroup><PackageReference Include="Acme.Lib" Version="2.0.0" /></ItemGroup>`,
    );
  });

  test("case-insensitive navigation for MSBuild", () => {
    const doc = parseDocument(
      `<Project><PropertyGroup><Version>1.0.0</Version></PropertyGroup></Project>`,
      { caseInsensitive: true },
    );
    expect(doc.get("propertygroup")?.get("VERSION")?.text).toBe("1.0.0");
    // case-sensitive by default
    const cs = parseDocument(`<Project><Version>1.0.0</Version></Project>`);
    expect(cs.get("version")).toBeUndefined();
    expect(cs.get("Version")?.text).toBe("1.0.0");
  });

  test("throws when setting text on a self-closing element", () => {
    const doc = parseDocument(`<a><b/></a>`);
    const b = doc.get("b")!;
    expect(() => doc.setText(b, "x")).toThrow(/self-closing/);
  });

  test("reads CDATA text without markers", () => {
    const doc = parseDocument(`<a><b><![CDATA[1.0.0]]></b></a>`);
    expect(doc.get("b")?.text).toBe("1.0.0");
  });

  test("toJS produces a plain-data projection", () => {
    const doc = parseDocument(`<root><name>acme</name><item>a</item><item>b</item></root>`);
    expect(doc.toJS()).toEqual({ name: "acme", item: ["a", "b"] });
  });

  test("multiple non-overlapping edits apply together", () => {
    const doc = parseDocument(pom);
    doc.setIn(["version"], "2.0.0");
    doc.setIn(["parent", "version"], "1.5.0");
    const out = doc.toString();
    expect(out).toContain("<version>2.0.0</version>");
    expect(out).toContain("<version>1.5.0</version>");
    expect(out).toContain("<version>9.9.9</version>");
  });

  test("empty document has no root", () => {
    const doc = parseDocument("   \n  ");
    expect(doc.root).toBeUndefined();
    expect(doc.toString()).toBe("   \n  ");
  });

  test("throws on malformed markup instead of swallowing it", () => {
    expect(() => parseDocument("<project><groupId")).toThrow(/Unterminated tag/);
    expect(() => parseDocument("<")).toThrow(/Malformed tag/);
  });
});
