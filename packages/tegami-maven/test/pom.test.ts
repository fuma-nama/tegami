import { describe, expect, test } from "vitest";
import { parseDocument } from "@tegami/xml-util";

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

/**
 * A pom exercises the trickiest part of the shared XML reader: several sibling
 * `<version>` elements at different depths, where editing the wrong one silently
 * corrupts a release. These assert the Maven-shaped behaviour the plugin relies
 * on; generic reader behaviour is covered by `@tegami/xml-util`'s own tests.
 */
describe("pom editing", () => {
  test("distinguishes the project version from parent/dependency/plugin versions", () => {
    const root = parseDocument(SAMPLE).root!;

    expect(root.name).toBe("project");
    expect(root.get("version")?.text).toBe("2.3.4");
    expect(root.getIn(["parent", "version"])?.text).toBe("1.0.0");
    expect(root.getIn(["properties", "revision"])?.text).toBe("9.9.9");
    expect(root.getIn(["dependencies", "dependency", "version"])?.text).toBe("1.0.0");
    expect(root.getIn(["build", "plugins", "plugin", "version"])?.text).toBe("3.1.2");
  });

  test("bumping the project version leaves every other version untouched", () => {
    const doc = parseDocument(SAMPLE);
    doc.setText(doc.root!.get("version")!, "3.0.0");
    const result = doc.toString();

    expect(result).toContain("<version>3.0.0</version>");
    expect(result).toContain("<version>1.0.0</version>");
    expect(result).toContain("<version>3.1.2</version>");
    // structure, comments, and namespaces survive the edit
    expect(result).toContain("<!-- top comment -->");
    expect(result).toContain('xmlns="http://maven.apache.org/POM/4.0.0"');
    expect(result.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  test("a release can bump project, parent, and dependency versions in one pass", () => {
    const doc = parseDocument(SAMPLE);
    const root = doc.root!;

    doc.setText(root.get("version")!, "3.0.0");
    doc.setText(root.getIn(["parent", "version"])!, "1.1.0");
    doc.setText(root.getIn(["dependencies", "dependency", "version"])!, "1.2.0");

    const reparsed = parseDocument(doc.toString()).root!;
    expect(reparsed.get("version")?.text).toBe("3.0.0");
    expect(reparsed.getIn(["parent", "version"])?.text).toBe("1.1.0");
    expect(reparsed.getIn(["dependencies", "dependency", "version"])?.text).toBe("1.2.0");
    // the plugin version is not a module version and stays put
    expect(reparsed.getIn(["build", "plugins", "plugin", "version"])?.text).toBe("3.1.2");
  });

  test("reads every <module> and skips comments and self-closing tags", () => {
    const doc = parseDocument(`<project>
  <modules>
    <module>a</module>
    <!-- skip me -->
    <module>b</module>
    <module>c</module>
  </modules>
  <empty/>
</project>`);

    const modules = doc.root!.get("modules")!.getAll("module");
    expect(modules.map((module) => module.text)).toEqual(["a", "b", "c"]);
    expect(doc.root!.get("empty")?.selfClosing).toBe(true);
  });
});
