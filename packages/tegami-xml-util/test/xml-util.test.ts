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

  test("ignores '>' inside attribute values", () => {
    const doc = parseDocument(`<project><name attr="a>b">value</name></project>`);
    expect(doc.get("name")?.text).toBe("value");
    expect(doc.get("name")?.attr("attr")?.value).toBe("a>b");
  });

  test("throws on a mismatched closing tag instead of reparenting", () => {
    // `<b>` would otherwise swallow `</a>` and silently become a child of `a`
    expect(() => parseDocument("<a><b></a>")).toThrow(/Mismatched closing tag/);
  });

  test("throws on an element that is never closed", () => {
    expect(() => parseDocument("<a><b></b>")).toThrow(/Unclosed element "a"/);
  });

  test("decodes entities in text and attributes", () => {
    const doc = parseDocument(`<a href="x?p=1&amp;q=2">A &amp; B &lt;ok&gt; &#65;</a>`);
    expect(doc.root?.text).toBe("A & B <ok> A");
    expect(doc.root?.attr("href")?.value).toBe("x?p=1&q=2");
  });

  test("decodes entity references in a single pass", () => {
    // `&amp;lt;` is the literal text `&lt;`, not `<`
    const doc = parseDocument(`<a>&amp;lt;</a>`);
    expect(doc.root?.text).toBe("&lt;");
  });

  test("leaves unknown entities verbatim", () => {
    const doc = parseDocument(`<a>&nbsp;</a>`);
    expect(doc.root?.text).toBe("&nbsp;");
  });

  test("does not decode inside CDATA, which is literal by definition", () => {
    const doc = parseDocument(`<a><![CDATA[A &amp; B]]></a>`);
    expect(doc.root?.text).toBe("A &amp; B");
  });

  test("writing back what was read is a no-op, not a double-escape", () => {
    const source = `<r><a>A &amp; B</a></r>`;
    const doc = parseDocument(source);
    const a = doc.getIn(["a"])!;
    doc.setText(a, a.text);
    expect(doc.toString()).toBe(source);
  });

  test("attribute round-trip preserves the encoded value", () => {
    const source = `<a href="x?p=1&amp;q=2"/>`;
    const doc = parseDocument(source);
    const el = doc.root!;
    doc.setAttr(el, "href", el.attr("href")!.value);
    expect(doc.toString()).toBe(source);
  });
});

/**
 * Conformance to XML 1.0 (Fifth Edition), section numbers as cited.
 *
 * This reader parses only enough grammar to find and edit values, but what it
 * *does* parse has to mean what the spec says it means — a manifest that a
 * conforming parser reads one way and Tegami reads another is a corrupted
 * release. Each case below is a rule real manifests exercise.
 */
describe("XML 1.0 conformance", () => {
  test("§2.6 processing instructions are content, not just prolog", () => {
    // read as an element named `?pi`, this reports a mismatched `</a>`
    const doc = parseDocument(`<a><?pi data?><b>1.0.0</b><?pi?></a>`);
    expect(doc.get("b")?.text).toBe("1.0.0");
    expect(doc.root?.children).toHaveLength(1);
  });

  test("§2.8 a doctype's internal subset does not end at its first '>'", () => {
    const source = `<!DOCTYPE project [\n  <!ENTITY version "1.0.0">\n]>\n<project><v>1.0.0</v></project>`;
    const doc = parseDocument(source);
    expect(doc.root?.name).toBe("project");
    expect(doc.get("v")?.text).toBe("1.0.0");
  });

  test("§2.8 a doctype's '>' inside a quoted literal does not end it", () => {
    const doc = parseDocument(`<!DOCTYPE a SYSTEM "http://x/a>b.dtd">\n<a>1.0.0</a>`);
    expect(doc.root?.text).toBe("1.0.0");
  });

  test("§2.4 '>' is legal character data, '<' is not", () => {
    expect(parseDocument(`<a>1 > 0</a>`).root?.text).toBe("1 > 0");
    expect(() => parseDocument(`<a>1 < 2</a>`)).toThrow();
  });

  test("§3.1 an unquoted attribute value is rejected", () => {
    expect(() => parseDocument(`<a b=1/>`)).toThrow();
  });

  test("§3.3.3 each literal whitespace character in an attribute becomes one space", () => {
    // every whitespace character maps to a space; runs are *not* collapsed,
    // which needs a DTD to declare the attribute as something other than CDATA
    const doc = parseDocument(`<a b="x\n\ty  z"/>`);
    expect(doc.root?.attr("b")?.value).toBe("x  y  z");
  });

  test("§3.3.3 a CRLF in an attribute value collapses to one space, not two", () => {
    const doc = parseDocument(`<a b="x\r\ny"/>`);
    expect(doc.root?.attr("b")?.value).toBe("x y");
  });

  test("§3.3.3 normalization applies to literal characters, not referenced ones", () => {
    const doc = parseDocument(`<a b="x&#xA;y&#x9;z"/>`);
    expect(doc.root?.attr("b")?.value).toBe("x\ny\tz");
  });

  test("§4.1 a character reference outside Char is left verbatim", () => {
    // a lone surrogate cannot be encoded back to UTF-8, and NUL is not a Char
    expect(parseDocument(`<a>&#xD800;</a>`).root?.text).toBe("&#xD800;");
    expect(parseDocument(`<a>&#0;</a>`).root?.text).toBe("&#0;");
    expect(parseDocument(`<a>&#x110000;</a>`).root?.text).toBe("&#x110000;");
  });

  test("§4.1 CharRef is decimal or lowercase-x hex only", () => {
    expect(parseDocument(`<a>&#65;</a>`).root?.text).toBe("A");
    expect(parseDocument(`<a>&#x41;</a>`).root?.text).toBe("A");
    // `&#1F;` is not a reference: reading it as the decimal `1` would invent a
    // control character that the source never contained
    expect(parseDocument(`<a>&#1F;</a>`).root?.text).toBe("&#1F;");
    expect(parseDocument(`<a>&#X41;</a>`).root?.text).toBe("&#X41;");
  });

  test("§4.1 astral character references decode to a full code point", () => {
    expect(parseDocument(`<a>&#x1F600;</a>`).root?.text).toBe("\u{1F600}");
  });

  test("§2.11 line endings inside text are preserved, not normalized", () => {
    // a deliberate departure: normalizing would reformat CRLF files on write
    const doc = parseDocument(`<a>first\r\nsecond</a>`);
    expect(doc.root?.text).toBe("first\r\nsecond");
  });

  test("§2.7 CDATA ends at the first ']]>', and ']]' alone does not end it", () => {
    expect(parseDocument(`<a><![CDATA[x]]b]]></a>`).root?.text).toBe("x]]b");
  });

  test("§4.6 only the five predefined entities are recognized without a DTD", () => {
    const doc = parseDocument(`<a>&amp;&lt;&gt;&quot;&apos;&nbsp;&custom;</a>`);
    expect(doc.root?.text).toBe(`&<>"'&nbsp;&custom;`);
  });

  test("§2.8 a byte-order mark before the prolog is not part of the document", () => {
    const doc = parseDocument(`﻿<?xml version="1.0"?><a>1.0.0</a>`);
    expect(doc.root?.name).toBe("a");
    expect(doc.root?.text).toBe("1.0.0");
  });

  test("§2.3 names are matched case-sensitively, and prefixes are not part of the local name", () => {
    const doc = parseDocument(
      `<x:project xmlns:x="urn:x"><x:version>1.0.0</x:version></x:project>`,
    );
    expect(doc.root?.name).toBe("x:project");
    expect(doc.root?.localName).toBe("project");
    expect(doc.get("version")?.text).toBe("1.0.0");
    expect(doc.get("Version")).toBeUndefined();
  });
});
