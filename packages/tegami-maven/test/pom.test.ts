import { describe, expect, test } from "vitest";
import {
  applyPatches,
  child,
  children,
  elementText,
  parsePom,
  resolvePath,
  setElementText,
} from "../src/pom";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!-- top comment -->
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>parent</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>child</artifactId>
  <version>2.3.4</version>
  <properties>
    <revision>9.9.9</revision>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>lib</artifactId>
      <version>1.0.0</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.1.2</version>
      </plugin>
    </plugins>
  </build>
</project>
`;

describe("pom editor", () => {
  test("resolves elements by path from the document root", () => {
    const doc = parsePom(SAMPLE);
    const root = doc.root!;

    expect(root.name).toBe("project");
    expect(elementText(doc, resolvePath(root, "version")!)).toBe("2.3.4");
    expect(elementText(doc, resolvePath(root, "parent", "version")!)).toBe("1.0.0");
    expect(elementText(doc, resolvePath(root, "properties", "revision")!)).toBe("9.9.9");
    expect(elementText(doc, resolvePath(root, "artifactId")!)).toBe("child");
  });

  test("distinguishes the project version from parent/dependency/plugin versions", () => {
    const doc = parsePom(SAMPLE);
    const root = doc.root!;

    const dependency = child(child(root, "dependencies")!, "dependency")!;
    const plugin = resolvePath(root, "build", "plugins", "plugin")!;

    expect(elementText(doc, child(root, "version")!)).toBe("2.3.4");
    expect(elementText(doc, child(dependency, "version")!)).toBe("1.0.0");
    expect(elementText(doc, child(plugin, "version")!)).toBe("3.1.2");
  });

  test("splices only the targeted element, preserving everything else", () => {
    const doc = parsePom(SAMPLE);
    const root = doc.root!;

    setElementText(doc, child(root, "version")!, "3.0.0");
    const result = applyPatches(doc);

    expect(result).toContain("<version>3.0.0</version>");
    // parent, dependency, and plugin versions are untouched
    expect(result).toContain("<version>1.0.0</version>");
    expect(result).toContain("<version>3.1.2</version>");
    // structure, comments, and namespaces are preserved
    expect(result).toContain("<!-- top comment -->");
    expect(result).toContain('xmlns="http://maven.apache.org/POM/4.0.0"');
    expect(result.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  test("applies multiple non-overlapping patches in one pass", () => {
    const doc = parsePom(SAMPLE);
    const root = doc.root!;
    const dependency = child(child(root, "dependencies")!, "dependency")!;

    setElementText(doc, child(root, "version")!, "3.0.0");
    setElementText(doc, resolvePath(root, "parent", "version")!, "1.1.0");
    setElementText(doc, child(dependency, "version")!, "1.2.0");
    const result = applyPatches(doc);

    const parent = child(parsePom(result).root!, "parent")!;
    expect(elementText(parsePom(result), child(parsePom(result).root!, "version")!)).toBe("3.0.0");
    expect(elementText(parsePom(result), child(parent, "version")!)).toBe("1.1.0");
    expect(result).toContain("<version>1.2.0</version>");
    // plugin version stays put
    expect(result).toContain("<version>3.1.2</version>");
  });

  test("returns all matching children and skips comments/self-closing tags", () => {
    const doc = parsePom(`<project>
  <modules>
    <module>a</module>
    <!-- skip me -->
    <module>b</module>
    <module>c</module>
  </modules>
  <empty/>
</project>`);
    const modules = children(child(doc.root!, "modules")!, "module");

    expect(modules.map((m) => elementText(doc, m))).toEqual(["a", "b", "c"]);
    expect(child(doc.root!, "empty")?.selfClosing).toBe(true);
  });

  test("ignores '>' inside attribute values", () => {
    const doc = parsePom(`<project><name attr="a>b">value</name></project>`);
    expect(elementText(doc, child(doc.root!, "name")!)).toBe("value");
  });
});
