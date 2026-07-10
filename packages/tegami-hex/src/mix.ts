import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** A byte-span replacement in the original file content. */
export interface Edit {
  start: number;
  end: number;
  replacement: string;
}

export interface MixDep {
  /** dependency app name (the atom, e.g. `:jason` → `jason`) */
  name: string;
  /** the requirement string (second positional element), e.g. `~> 1.0` */
  requirement?: string;
  /** absolute span of the requirement string content (without quotes) */
  requirementSpan?: { start: number; end: number };
  /** relative `path:` option, if present */
  relativePath?: string;
  /** `in_umbrella: true` */
  inUmbrella: boolean;
  /** has an `only:` option → treated as a dev/test dependency */
  dev: boolean;
}

export interface MixFile {
  /** absolute path to mix.exs */
  path: string;
  /** directory containing mix.exs */
  dir: string;
  /** original file content */
  content: string;
  /** app name (`app: :name`), if defined */
  app?: string;
  /** resolved version, if it can be statically resolved */
  version?: string;
  /** absolute span of the version string content (without quotes), for splicing */
  versionSpan?: { start: number; end: number };
  /** `apps_path:` value → this file is an umbrella root */
  appsPath?: string;
  deps: MixDep[];
}

const APP_RE = /\bapp:\s*:(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/;
const APPS_PATH_RE = /\bapps_path:\s*"([^"]+)"/;
const VERSION_LITERAL_RE = /\bversion:\s*"([^"]*)"/;
const VERSION_ATTR_RE = /\bversion:\s*@([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Locate the closing bracket matching the opening bracket at `openIndex`,
 * skipping over string literals. Returns the index of the closing bracket.
 */
function matchBracket(content: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Find the deps list literal span (`[...]`) in the file, or `undefined`. */
function findDepsListSpan(content: string): { start: number; end: number } | undefined {
  // `def deps do [ ... ] end` / `defp deps do [ ... ] end`
  const block = /\bdef(?:p)?\s+deps\s*(?:\([^)]*\))?\s+do\b/.exec(content);
  let searchFrom: number | undefined;
  if (block) searchFrom = block.index + block[0].length;

  // fall back to inline `deps: [ ... ]`
  if (searchFrom === undefined) {
    const inline = /\bdeps:\s*\[/.exec(content);
    if (!inline) return undefined;
    const open = content.indexOf("[", inline.index);
    const close = matchBracket(content, open, "[", "]");
    if (close === -1) return undefined;
    return { start: open, end: close };
  }

  const open = content.indexOf("[", searchFrom);
  if (open === -1) return undefined;
  const close = matchBracket(content, open, "[", "]");
  if (close === -1) return undefined;
  return { start: open, end: close };
}

const TUPLE_RE = /\{\s*:([A-Za-z_][A-Za-z0-9_]*)\s*([^{}]*)\}/g;

function parseDeps(content: string): MixDep[] {
  const span = findDepsListSpan(content);
  if (!span) return [];

  const blockStart = span.start;
  const blockText = content.slice(span.start, span.end + 1);
  const deps: MixDep[] = [];

  for (const m of blockText.matchAll(TUPLE_RE)) {
    const name = m[1]!;
    const body = m[2] ?? "";
    const tupleAbsStart = blockStart + m.index!;

    const dep: MixDep = {
      name,
      inUmbrella: /\bin_umbrella:\s*true\b/.test(body),
      dev: /\bonly:\s*/.test(body),
    };

    // requirement: first positional quoted string right after the atom
    const reqM = /^\s*,\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    if (reqM) {
      // position of the tuple body inside the whole tuple match
      const bodyOffsetInTuple = m[0].length - body.length - 1; // -1 for trailing `}`
      const quoteOffsetInBody = reqM[0].indexOf('"');
      const innerStart = tupleAbsStart + bodyOffsetInTuple + reqM.index + quoteOffsetInBody + 1;
      dep.requirement = reqM[1];
      dep.requirementSpan = { start: innerStart, end: innerStart + reqM[1]!.length };
    }

    const pathM = /\bpath:\s*"([^"]*)"/.exec(body);
    if (pathM) dep.relativePath = pathM[1];

    deps.push(dep);
  }

  return deps;
}

export function parseMix(content: string, filePath: string): MixFile {
  const file: MixFile = {
    path: filePath,
    dir: path.dirname(filePath),
    content,
    deps: parseDeps(content),
  };

  const appM = APP_RE.exec(content);
  if (appM) file.app = appM[1] ?? appM[2];

  const appsPathM = APPS_PATH_RE.exec(content);
  if (appsPathM) file.appsPath = appsPathM[1];

  const literalM = VERSION_LITERAL_RE.exec(content);
  if (literalM) {
    const innerStart = literalM.index + literalM[0].indexOf('"') + 1;
    file.version = literalM[1];
    file.versionSpan = { start: innerStart, end: innerStart + literalM[1]!.length };
  } else {
    const attrRefM = VERSION_ATTR_RE.exec(content);
    if (attrRefM) {
      const attrName = attrRefM[1];
      const attrDefM = new RegExp(`@${attrName}\\s+"([^"]*)"`).exec(content);
      if (attrDefM) {
        const innerStart = attrDefM.index + attrDefM[0].indexOf('"') + 1;
        file.version = attrDefM[1];
        file.versionSpan = { start: innerStart, end: innerStart + attrDefM[1]!.length };
      }
    }
  }

  return file;
}

export async function readMix(dir: string): Promise<MixFile | undefined> {
  const filePath = path.join(dir, "mix.exs");
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  return parseMix(content, filePath);
}

/** Apply a set of non-overlapping edits to `content`, preserving all other bytes. */
export function applyEdits(content: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = content;
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return out;
}

export async function writeMix(file: MixFile, edits: Edit[]): Promise<void> {
  if (edits.length === 0) return;
  await writeFile(file.path, applyEdits(file.content, edits));
}
