import { readFile } from "node:fs/promises";
import path from "node:path";
import MagicString from "magic-string";
import { glob } from "tinyglobby";
import { parseRequirement, type Requirement } from "./requirement";

/** An in-memory text file with a queue of byte-range edits to apply on write. */
export interface TextFile {
  /** absolute path */
  path: string;
  content: string;
  edits: TextEdit[];
}

export interface TextEdit {
  /** inclusive start offset into the original content */
  start: number;
  /** exclusive end offset into the original content */
  end: number;
  value: string;
}

/** A located version string literal inside a {@link TextFile}. */
export interface VersionRef {
  file: TextFile;
  start: number;
  end: number;
  value: string;
}

/** A located requirement string literal inside the gemspec. */
export interface RequirementLiteral {
  start: number;
  end: number;
  parsed: Requirement;
}

export type DependencyKind = "runtime" | "development";

export interface RawDependency {
  kind: DependencyKind;
  name: string;
  requirements: RequirementLiteral[];
}

export interface ParsedGemspec {
  /** gem name, or `undefined` when it is computed dynamically and cannot be resolved. */
  name?: string;
  /** located version literal (its `file` may be a separate `version.rb`), or `undefined` when unresolvable. */
  version?: VersionRef;
  gemspecFile: TextFile;
  dependencies: RawDependency[];
}

const NAME_RE = /\.name\s*=\s*(['"])([^'"\n]+)\1/;
const VERSION_LITERAL_RE = /(\.version\s*=\s*)(['"])([^'"\n]+)\2/;
const VERSION_CONSTANT_RE = /\.version\s*=\s*([A-Za-z_][\w:]*)/;
const VERSION_RB_RE = /(VERSION\s*=\s*)(['"])([^'"\n]+)\2/;
const DEP_RE =
  /\b(add(?:_runtime|_development)?_dependency)\b\s*\(?\s*(['"])([^'"\n]+)\2([^\n)]*)/g;
const REQUIREMENT_LITERAL_RE = /(['"])([^'"\n]+)\1/g;

/** Parse a gemspec file into its name, version location, and workspace dependencies. */
export async function parseGemspec(gemspecPath: string): Promise<ParsedGemspec> {
  const content = await readFile(gemspecPath, "utf8");
  const gemspecFile: TextFile = { path: gemspecPath, content, edits: [] };
  const dir = path.dirname(gemspecPath);

  const name = NAME_RE.exec(content)?.[2];
  const version = await resolveVersion(gemspecFile, dir);
  const dependencies = parseDependencies(content);

  return { name, version, gemspecFile, dependencies };
}

async function resolveVersion(
  gemspecFile: TextFile,
  dir: string,
): Promise<VersionRef | undefined> {
  const literal = VERSION_LITERAL_RE.exec(gemspecFile.content);
  if (literal) {
    const start = literal.index + literal[1]!.length + 1; // skip prefix + opening quote
    return { file: gemspecFile, start, end: start + literal[3]!.length, value: literal[3]! };
  }

  // no literal — the version is likely defined through a constant such as `Foo::VERSION`.
  if (!VERSION_CONSTANT_RE.test(gemspecFile.content)) return;

  const versionFiles = await glob(["lib/**/version.rb"], {
    cwd: dir,
    absolute: true,
    ignore: ["**/vendor/**", "**/node_modules/**", "**/tmp/**"],
  });

  for (const filePath of versionFiles.sort()) {
    const content = await readFile(filePath, "utf8").catch(() => undefined);
    if (content === undefined) continue;

    const match = VERSION_RB_RE.exec(content);
    if (!match) continue;

    const file: TextFile = { path: filePath, content, edits: [] };
    const start = match.index + match[1]!.length + 1;
    return { file, start, end: start + match[3]!.length, value: match[3]! };
  }

  return;
}

function parseDependencies(content: string): RawDependency[] {
  const dependencies: RawDependency[] = [];

  DEP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DEP_RE.exec(content))) {
    const kind: DependencyKind =
      match[1] === "add_development_dependency" ? "development" : "runtime";
    const name = match[3]!;
    const rest = match[4]!;
    const restOffset = match.index + match[0].length - rest.length;

    const requirements: RequirementLiteral[] = [];
    REQUIREMENT_LITERAL_RE.lastIndex = 0;
    let requirementMatch: RegExpExecArray | null;
    while ((requirementMatch = REQUIREMENT_LITERAL_RE.exec(rest))) {
      const parsed = parseRequirement(requirementMatch[2]!);
      if (!parsed) continue;

      const start = restOffset + requirementMatch.index + 1; // skip opening quote
      requirements.push({ start, end: start + requirementMatch[2]!.length, parsed });
    }

    dependencies.push({ kind, name, requirements });
  }

  return dependencies;
}

/** Apply queued edits and return the rewritten file content. Edits must not overlap. */
export function applyEdits(file: TextFile): string {
  const s = new MagicString(file.content);
  for (const edit of file.edits) {
    if (edit.start === edit.end) s.appendLeft(edit.start, edit.value);
    else s.update(edit.start, edit.end, edit.value);
  }
  return s.toString();
}
