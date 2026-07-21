import { describe, expect, test } from "vitest";
import { parseDocument } from "../src/index";

/**
 * The reader is only ever pointed at real package manifests, so these use the
 * genuine article: a Maven-archetype `pom.xml`, a Visual Studio `.csproj`
 * (BOM + CRLF, as VS writes it), a NuGet central-package-management props file,
 * a `.nuspec`, and an Ant `build.xml` with a doctype.
 *
 * Every case asserts the two things a release depends on: the *right* value is
 * found among lookalikes, and everything else survives the edit byte for byte.
 */

/** Rewrite a fixture with Windows line endings, as Visual Studio writes them. */
function crlf(source: string): string {
  return source.replace(/\n/g, "\r\n");
}

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Copyright 2024 the original author or authors.
  Licensed under the Apache License, Version 2.0
-->
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.5</version>
    <relativePath/> <!-- lookup parent from repository -->
  </parent>

  <groupId>com.acme</groupId>
  <artifactId>acme-service</artifactId>
  <version>\${revision}</version>
  <packaging>jar</packaging>
  <name>acme-service</name>
  <description>Acme's service &amp; friends</description>

  <properties>
    <revision>1.4.2-SNAPSHOT</revision>
    <java.version>21</java.version>
    <testcontainers.version>1.19.7</testcontainers.version>
  </properties>

  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.testcontainers</groupId>
        <artifactId>testcontainers-bom</artifactId>
        <version>\${testcontainers.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>

  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>com.acme</groupId>
      <artifactId>acme-core</artifactId>
      <version>1.4.2-SNAPSHOT</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>[5.10,6.0)</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.13.0</version>
        <configuration>
          <compilerArgs>
            <arg>-Xlint:all,-processing</arg>
          </compilerArgs>
        </configuration>
      </plugin>
    </plugins>
  </build>

  <profiles>
    <profile>
      <id>release</id>
      <build>
        <plugins>
          <plugin>
            <artifactId>maven-gpg-plugin</artifactId>
            <version>3.2.4</version>
          </plugin>
        </plugins>
      </build>
    </profile>
  </profiles>
</project>
`;

describe("pom.xml", () => {
  test("resolves coordinates past the parent's lookalike elements", () => {
    const doc = parseDocument(POM);

    expect(doc.get("groupId")?.text).toBe("com.acme");
    expect(doc.get("artifactId")?.text).toBe("acme-service");
    expect(doc.get("version")?.text).toBe("${revision}");
    // the <parent> block declares all three too, and must not win
    expect(doc.getIn(["parent", "groupId"])?.text).toBe("org.springframework.boot");
    expect(doc.getIn(["parent", "version"])?.text).toBe("3.2.5");
  });

  test("finds the property a ${revision} version points at", () => {
    const doc = parseDocument(POM);
    expect(doc.getIn(["properties", "revision"])?.text).toBe("1.4.2-SNAPSHOT");
  });

  test("reads dependencies without picking up dependencyManagement", () => {
    const doc = parseDocument(POM);
    const deps = doc.get("dependencies")!.getAll("dependency");

    expect(deps.map((dep) => dep.get("artifactId")?.text)).toEqual([
      "spring-boot-starter-web",
      "acme-core",
      "junit-jupiter",
    ]);
    // a managed dependency declares no version of its own
    expect(deps[0]!.get("version")).toBeUndefined();
    expect(deps[2]!.get("scope")?.text).toBe("test");
  });

  test("bumping the revision property leaves all seven <version> elements alone", () => {
    const doc = parseDocument(POM);
    expect(doc.root!.findAll("version")).toHaveLength(7);

    doc.setText(doc.getIn(["properties", "revision"])!, "1.5.0");
    const out = doc.toString();

    expect(out).toContain("<revision>1.5.0</revision>");
    expect(out).toContain("<version>3.2.5</version>");
    expect(out).toContain("<version>${revision}</version>");
    expect(out).toContain("<version>[5.10,6.0)</version>");
    expect(out).toContain("<version>3.13.0</version>");
    // license header, xsi namespace, inline comment, and empty tag all intact
    expect(out).toContain("Licensed under the Apache License");
    expect(out).toContain("<relativePath/> <!-- lookup parent from repository -->");
    expect(out.replace("<revision>1.5.0</revision>", "<revision>1.4.2-SNAPSHOT</revision>")).toBe(
      POM,
    );
  });

  test("bumping an inter-module dependency edits only that <version>", () => {
    const doc = parseDocument(POM);
    const core = doc
      .get("dependencies")!
      .getAll("dependency")
      .find((dep) => dep.get("artifactId")?.text === "acme-core")!;

    doc.setText(core.get("version")!, "1.5.0");
    const out = doc.toString();

    expect(out).toContain("<artifactId>acme-core</artifactId>\n      <version>1.5.0</version>");
    expect(out).toContain("<revision>1.4.2-SNAPSHOT</revision>");
  });

  test("keeps the escaped ampersand in <description> escaped when rewritten", () => {
    const doc = parseDocument(POM);
    const description = doc.get("description")!;

    expect(description.text).toBe("Acme's service & friends");
    doc.setText(description, description.text);
    expect(doc.toString()).toBe(POM);
  });

  test("normalizes the wrapped xsi:schemaLocation into a single line", () => {
    const doc = parseDocument(POM);
    const schemaLocation = doc.root!.attr("xsi:schemaLocation")!.value;

    // §3.3.3: the newline and its indentation are whitespace characters, so the
    // value is the pair of URIs a validator reads — not the two lines on disk
    expect(schemaLocation).not.toContain("\n");
    expect(schemaLocation.split(/\s+/)).toEqual([
      "http://maven.apache.org/POM/4.0.0",
      "https://maven.apache.org/xsd/maven-4.0.0.xsd",
    ]);
  });
});

const CSPROJ = `﻿${crlf(`<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFrameworks>net8.0;netstandard2.0</TargetFrameworks>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <GenerateDocumentationFile>true</GenerateDocumentationFile>
    <NoWarn>$(NoWarn);CS1591</NoWarn>
  </PropertyGroup>

  <PropertyGroup>
    <PackageId>Acme.Core</PackageId>
    <Version>2.1.0</Version>
    <Authors>Acme</Authors>
    <Description>Core primitives for Acme services</Description>
    <PackageTags>acme;core;primitives</PackageTags>
    <IsPackable>true</IsPackable>
  </PropertyGroup>

  <PropertyGroup Condition="'$(Configuration)' == 'Debug' AND '$(OS)' != 'Windows_NT'">
    <DefineConstants>$(DefineConstants);UNIX_DEBUG</DefineConstants>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="System.Text.Json" Version="8.0.4" />
    <PackageReference Include="Acme.Abstractions" Version="[2.1.0]" />
    <PackageReference Include="Microsoft.SourceLink.GitHub" Version="8.0.0" PrivateAssets="All" />
  </ItemGroup>

  <ItemGroup Condition="'$(TargetFramework)' == 'netstandard2.0'">
    <PackageReference Include="IndexRange" Version="1.0.3" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\\Acme.Internal\\Acme.Internal.csproj" />
    <None Include="..\\..\\README.md" Pack="true" PackagePath="\\" />
  </ItemGroup>

</Project>
`)}`;

describe("Visual Studio .csproj", () => {
  test("reads MSBuild properties case-insensitively past the BOM and CRLF", () => {
    const doc = parseDocument(CSPROJ, { caseInsensitive: true });

    expect(doc.root?.name).toBe("Project");
    expect(doc.root?.attr("sdk")?.value).toBe("Microsoft.NET.Sdk");
    const groups = doc.root!.findAll("propertygroup");
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.get("version")?.text).find(Boolean)).toBe("2.1.0");
    expect(groups.map((group) => group.get("packageid")?.text).find(Boolean)).toBe("Acme.Core");
  });

  test("MSBuild property values with $(...) and ';' survive as written", () => {
    const doc = parseDocument(CSPROJ, { caseInsensitive: true });
    const root = doc.root!;

    expect(root.find("targetframeworks")?.text).toBe("net8.0;netstandard2.0");
    expect(root.find("nowarn")?.text).toBe("$(NoWarn);CS1591");
    expect(root.find("packagetags")?.text).toBe("acme;core;primitives");
  });

  test("a Condition keeps its single-quoted MSBuild expression intact", () => {
    const doc = parseDocument(CSPROJ, { caseInsensitive: true });
    const conditions = doc
      .root!.findAll("propertygroup")
      .concat(doc.root!.findAll("itemgroup"))
      .map((group) => group.attr("condition")?.value)
      .filter(Boolean);

    expect(conditions).toEqual([
      "'$(Configuration)' == 'Debug' AND '$(OS)' != 'Windows_NT'",
      "'$(TargetFramework)' == 'netstandard2.0'",
    ]);
  });

  test("reads Include paths with Windows separators verbatim", () => {
    const doc = parseDocument(CSPROJ, { caseInsensitive: true });

    expect(doc.root?.find("projectreference")?.attr("include")?.value).toBe(
      String.raw`..\Acme.Internal\Acme.Internal.csproj`,
    );
    expect(doc.root?.find("none")?.attr("packagepath")?.value).toBe("\\");
  });

  test("bumping the version and one PackageReference preserves BOM, CRLF, and everything else", () => {
    const doc = parseDocument(CSPROJ, { caseInsensitive: true });
    const version = doc.root!.findAll("propertygroup").flatMap((g) => g.getAll("version"))[0]!;
    const abstractions = doc
      .root!.findAll("packagereference")
      .find((ref) => ref.attr("include")?.value === "Acme.Abstractions")!;

    doc.setText(version, "2.2.0");
    expect(doc.setAttr(abstractions, "version", "[2.2.0]")).toBe(true);
    const out = doc.toString();

    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain(crlf("    <Version>2.2.0</Version>\n"));
    expect(out).toContain(`<PackageReference Include="Acme.Abstractions" Version="[2.2.0]" />`);
    // untouched references keep their own versions
    expect(out).toContain(`<PackageReference Include="System.Text.Json" Version="8.0.4" />`);
    expect(out).toContain(`<PackageReference Include="IndexRange" Version="1.0.3" />`);
    expect(out.split("\n")).toHaveLength(CSPROJ.split("\n").length);
    expect(out.replace("2.2.0", "2.1.0").replace("[2.2.0]", "[2.1.0]")).toBe(CSPROJ);
  });

  test("does not confuse <Version> elements with Version attributes", () => {
    const doc = parseDocument(CSPROJ, { caseInsensitive: true });

    // MSBuild's own property, not one of the four PackageReference Version attributes
    expect(doc.root?.findAll("version")).toHaveLength(1);
    expect(doc.root?.findAll("packagereference")).toHaveLength(4);
  });
});

const PACKAGES_PROPS = crlf(`<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
    <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Acme.Core" Version="2.1.0" />
    <PackageVersion Include="Serilog" Version="4.0.0" />
  </ItemGroup>
  <ItemGroup Condition="'$(TargetFramework)' == 'net8.0'">
    <PackageVersion Include="System.Text.Json" Version="8.0.4" />
  </ItemGroup>
</Project>
`);

describe("Directory.Packages.props", () => {
  test("rewrites one centrally managed version and nothing else", () => {
    const doc = parseDocument(PACKAGES_PROPS, { caseInsensitive: true });
    const acme = doc
      .root!.findAll("packageversion")
      .find((entry) => entry.attr("include")?.value === "Acme.Core")!;

    expect(acme.attr("version")?.value).toBe("2.1.0");
    expect(doc.setAttr(acme, "version", "2.2.0")).toBe(true);

    const out = doc.toString();
    expect(out).toContain(`<PackageVersion Include="Acme.Core" Version="2.2.0" />`);
    expect(out).toContain(`<PackageVersion Include="Serilog" Version="4.0.0" />`);
    expect(out).toBe(PACKAGES_PROPS.replace(`Version="2.1.0"`, `Version="2.2.0"`));
  });
});

const NUSPEC = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>Acme.Core</id>
    <version>2.1.0</version>
    <authors>Acme</authors>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <license type="expression">MIT</license>
    <projectUrl>https://example.com/acme?ref=nuget&amp;utm=readme</projectUrl>
    <description><![CDATA[Core primitives — see <https://example.com> for docs.]]></description>
    <releaseNotes>Fixes &lt;summary&gt; parsing.</releaseNotes>
    <dependencies>
      <group targetFramework=".NETStandard2.0">
        <dependency id="Acme.Abstractions" version="2.1.0" exclude="Build,Analyzers" />
      </group>
      <group targetFramework="net8.0" />
    </dependencies>
  </metadata>
</package>
`;

describe(".nuspec", () => {
  test("reads metadata through the default namespace", () => {
    const doc = parseDocument(NUSPEC);

    expect(doc.getIn(["metadata", "id"])?.text).toBe("Acme.Core");
    expect(doc.getIn(["metadata", "version"])?.text).toBe("2.1.0");
    expect(doc.getIn(["metadata", "license"])?.attr("type")?.value).toBe("expression");
  });

  test("decodes entities in text and attributes, and leaves CDATA literal", () => {
    const doc = parseDocument(NUSPEC);

    expect(doc.getIn(["metadata", "projectUrl"])?.text).toBe(
      "https://example.com/acme?ref=nuget&utm=readme",
    );
    expect(doc.getIn(["metadata", "releaseNotes"])?.text).toBe("Fixes <summary> parsing.");
    expect(doc.getIn(["metadata", "description"])?.text).toBe(
      "Core primitives — see <https://example.com> for docs.",
    );
  });

  test("distinguishes the package version from a dependency's version attribute", () => {
    const doc = parseDocument(NUSPEC);
    const dependency = doc.root!.find("dependency")!;

    doc.setText(doc.getIn(["metadata", "version"])!, "2.2.0");
    const out = doc.toString();

    expect(dependency.attr("version")?.value).toBe("2.1.0");
    expect(out).toContain("<version>2.2.0</version>");
    expect(out).toContain(`<dependency id="Acme.Abstractions" version="2.1.0"`);
    // the empty group element and the CDATA description are untouched
    expect(out).toContain(`<group targetFramework="net8.0" />`);
    expect(out).toContain("<![CDATA[Core primitives");
  });
});

const ANT_BUILD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE project [
  <!ENTITY common SYSTEM "common-targets.xml">
  <!ELEMENT project (target*)>
]>
<?ignore-this instruction?>
<project name="acme" default="dist" basedir=".">
  <property name="version" value="1.4.2"/>
  <target name="dist" description="build the jar">
    <jar destfile="build/acme-\${version}.jar" basedir="build/classes"/>
  </target>
  &common;
</project>
`;

describe("Ant build.xml", () => {
  test("parses past a doctype with an internal subset and a stray PI", () => {
    const doc = parseDocument(ANT_BUILD);

    expect(doc.root?.name).toBe("project");
    expect(doc.root?.attr("default")?.value).toBe("dist");
    expect(doc.get("property")?.attr("value")?.value).toBe("1.4.2");
  });

  test("leaves an undeclared entity reference in text verbatim", () => {
    // `&common;` is defined by the internal subset this reader does not evaluate;
    // inventing an expansion would drop the include from a round-trip
    const doc = parseDocument(ANT_BUILD);
    expect(doc.root?.text.trim()).toBe("&common;");
  });

  test("rewriting the version property preserves the doctype and PI", () => {
    const doc = parseDocument(ANT_BUILD);
    expect(doc.setAttr(doc.get("property")!, "value", "1.5.0")).toBe(true);

    const out = doc.toString();
    expect(out).toContain(`<!ENTITY common SYSTEM "common-targets.xml">`);
    expect(out).toContain("<?ignore-this instruction?>");
    expect(out).toBe(ANT_BUILD.replace(`value="1.4.2"`, `value="1.5.0"`));
  });
});
