import { describe, expect, test } from "vitest";
import {
  addPatch,
  applyPatches,
  findDescendants,
  findProperty,
  getAttr,
  getElementText,
  parseXml,
  type XmlFile,
} from "../src/xml";

const PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <!-- a comment -->
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <PackageId>Acme.Core</PackageId>
    <Version>1.2.3</Version>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\Lib\\Lib.csproj" />
    <PackageReference Include="Some.Package" Version="1.0.0" />
  </ItemGroup>
</Project>
`;

describe("XML reader", () => {
  test("parses elements, attributes, and property text", () => {
    const root = parseXml(PROJECT);
    expect(root.name).toBe("Project");
    expect(getAttr(root, "sdk")?.value).toBe("Microsoft.NET.Sdk");

    expect(getElementText(findProperty(root, "packageid")!)?.value).toBe("Acme.Core");
    expect(getElementText(findProperty(root, "version")!)?.value).toBe("1.2.3");
    expect(getElementText(findProperty(root, "ispackable")!)?.value).toBe("false");
  });

  test("finds item references with attributes in any order", () => {
    const root = parseXml(PROJECT);
    const projectRefs = findDescendants(root, "projectreference");
    expect(projectRefs).toHaveLength(1);
    expect(getAttr(projectRefs[0]!, "include")?.value).toBe("..\\Lib\\Lib.csproj");

    const packageRefs = findDescendants(root, "packagereference");
    expect(getAttr(packageRefs[0]!, "version")?.value).toBe("1.0.0");
  });

  test("handles reordered and single-quoted attributes", () => {
    const root = parseXml(
      `<Project><ItemGroup><PackageReference Version='2.0.0' Include='Foo' /></ItemGroup></Project>`,
    );
    const ref = findDescendants(root, "packagereference")[0]!;
    expect(getAttr(ref, "include")?.value).toBe("Foo");
    expect(getAttr(ref, "version")?.value).toBe("2.0.0");
  });

  test("splices an element value while preserving surrounding formatting", () => {
    const root = parseXml(PROJECT);
    const version = getElementText(findProperty(root, "version")!)!;
    const file: XmlFile = { path: "x", content: PROJECT, root, patches: [] };
    addPatch(file, version.range, "2.0.0");

    const next = applyPatches(file.content, file.patches);
    expect(next).toContain("<Version>2.0.0</Version>");
    // untouched formatting around the edit
    expect(next).toContain("<PackageId>Acme.Core</PackageId>");
    expect(next).toContain("<IsPackable>false</IsPackable>");
  });

  test("splices an attribute value in place", () => {
    const root = parseXml(PROJECT);
    const ref = findDescendants(root, "packagereference")[0]!;
    const versionAttr = getAttr(ref, "version")!;
    const file: XmlFile = { path: "x", content: PROJECT, root, patches: [] };
    addPatch(file, versionAttr.valueRange, "3.4.5");

    const next = applyPatches(file.content, file.patches);
    expect(next).toContain(`Include="Some.Package" Version="3.4.5"`);
  });

  test("preserves indentation of an element with padded text", () => {
    const content = `<Project><PropertyGroup>\n    <Version>  1.0.0  </Version>\n</PropertyGroup></Project>`;
    const root = parseXml(content);
    const version = getElementText(findProperty(root, "version")!)!;
    expect(version.value).toBe("1.0.0");

    const next = applyPatches(content, [{ ...version.range, value: "9.9.9" }]);
    expect(next).toContain("<Version>  9.9.9  </Version>");
  });
});
