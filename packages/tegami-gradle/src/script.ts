/**
 * A tolerant lexer for Gradle build scripts, covering both the Groovy and
 * Kotlin DSLs.
 *
 * Gradle scripts are full programs, so this deliberately stops at tokens: it
 * knows where strings, comments and blocks start and end, which is enough to
 * read declarations and to patch string literals in place. Anything that needs
 * real evaluation (convention plugins, `libs.versions.toml` lookups, computed
 * versions) is out of reach by design and reported as "not found" instead of
 * being guessed at.
 */

export interface Token {
  kind: "word" | "string" | "punct";
  /** identifier text, string contents, or the punctuation character */
  value: string;
  start: number;
  end: number;
  /** offsets of a string's contents, excluding its quotes */
  contentStart: number;
  contentEnd: number;
  /** strings with `$foo` or `${foo}` cannot be replaced literally */
  interpolated: boolean;
  /** a string whose closing quote is missing — the script does not parse */
  unterminated?: boolean;
  /** names of the enclosing `{}` blocks, outermost first */
  blockPath: string[];
  /** for `)`, the index of the matching `(` token */
  openIndex?: number;
}

const WORD_START = /[A-Za-z_$]/;
const WORD_PART = /[A-Za-z0-9_$.]/;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const blocks: string[] = [];
  const parens: number[] = [];
  let i = 0;

  const push = (token: Omit<Token, "blockPath" | "interpolated"> & { interpolated?: boolean }) => {
    tokens.push({ interpolated: false, ...token, blockPath: [...blocks] });
  };

  while (i < text.length) {
    const char = text[i]!;

    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      i++;
      continue;
    }

    // comments
    if (char === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    // strings, including triple-quoted (raw) forms
    if (char === '"' || char === "'") {
      const triple = text.startsWith(char.repeat(3), i);
      const quote = triple ? char.repeat(3) : char;
      const string = readString(text, i, quote);
      push({
        kind: "string",
        value: string.value,
        start: i,
        end: string.end,
        contentStart: i + quote.length,
        contentEnd: string.unterminated ? string.end : string.end - quote.length,
        interpolated: string.interpolated,
        ...(string.unterminated ? { unterminated: true } : {}),
      });
      i = string.end;
      continue;
    }

    // Kotlin escapes keywords as identifiers: `maven-publish`
    if (char === "`") {
      const end = text.indexOf("`", i + 1);
      const stop = end === -1 ? text.length : end + 1;
      push({
        kind: "word",
        value: text.slice(i + 1, stop - 1),
        start: i,
        end: stop,
        contentStart: i + 1,
        contentEnd: stop - 1,
      });
      i = stop;
      continue;
    }

    if (WORD_START.test(char)) {
      let end = i + 1;
      while (end < text.length && WORD_PART.test(text[end]!)) end++;
      push({
        kind: "word",
        value: text.slice(i, end),
        start: i,
        end,
        contentStart: i,
        contentEnd: end,
      });
      i = end;
      continue;
    }

    if (char === "{") {
      blocks.push(blockNameBefore(tokens));
      push({
        kind: "punct",
        value: char,
        start: i,
        end: i + 1,
        contentStart: i,
        contentEnd: i + 1,
      });
      i++;
      continue;
    }

    if (char === "}") {
      blocks.pop();
      push({
        kind: "punct",
        value: char,
        start: i,
        end: i + 1,
        contentStart: i,
        contentEnd: i + 1,
      });
      i++;
      continue;
    }

    if (char === "(") parens.push(tokens.length);

    let openIndex: number | undefined;
    if (char === ")") openIndex = parens.pop();

    push({
      kind: "punct",
      value: char,
      start: i,
      end: i + 1,
      contentStart: i,
      contentEnd: i + 1,
      ...(openIndex !== undefined ? { openIndex } : {}),
    });
    i++;
  }

  return tokens;
}

/**
 * Read a string starting at its opening quote.
 *
 * `${…}` interpolation is skipped as a balanced brace run so that braces inside
 * a string never open or close a block, and `$foo` marks the string as
 * interpolated so callers know it cannot be rewritten literally.
 */
function readString(
  text: string,
  start: number,
  quote: string,
): { value: string; end: number; interpolated: boolean; unterminated?: boolean } {
  const raw = quote.length === 3;
  const interpolates = quote[0] === '"';
  let i = start + quote.length;
  let value = "";
  let interpolated = false;

  while (i < text.length) {
    if (text.startsWith(quote, i)) {
      return { value, end: i + quote.length, interpolated };
    }

    const char = text[i]!;

    if (!raw && char === "\\" && i + 1 < text.length) {
      value += text[i + 1];
      i += 2;
      continue;
    }

    if (interpolates && char === "$") {
      interpolated = true;
      if (text[i + 1] === "{") {
        i = skipInterpolation(text, i + 1);
        continue;
      }
    }

    value += char;
    i++;
  }

  // consume the rest rather than desynchronising the lexer; callers surface
  // this as a parse error instead of silently misreading the script
  return { value, end: text.length, interpolated, unterminated: true };
}

/** Skip a `{…}` interpolation, tolerating nested braces and strings. */
function skipInterpolation(text: string, open: number): number {
  let depth = 0;
  let i = open;

  while (i < text.length) {
    const char = text[i]!;

    if (char === '"' || char === "'") {
      const triple = text.startsWith(char.repeat(3), i);
      i = readString(text, i, triple ? char.repeat(3) : char).end;
      continue;
    }

    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }

    i++;
  }

  return text.length;
}

/** The receiver a `{` belongs to: `plugins {` → `plugins`, `named("x") {` → `named`. */
function blockNameBefore(tokens: Token[]): string {
  const last = tokens[tokens.length - 1];
  if (!last) return "";
  if (last.kind === "word") return last.value;

  if (last.value === ")" && last.openIndex !== undefined) {
    const before = tokens[last.openIndex - 1];
    if (before?.kind === "word") return before.value;
  }

  return "";
}

export interface StringAssignment {
  name: string;
  value: string;
  blockPath: string[];
  contentStart: number;
  contentEnd: number;
  interpolated: boolean;
}

/**
 * Assignments of a plain string, in both DSL spellings:
 * `version = "1.0.0"` (Kotlin/Groovy) and `version '1.0.0'` (Groovy).
 *
 * Values that are not string literals (`version = libs.versions.core.get()`)
 * are skipped: they cannot be read or rewritten without evaluating the script.
 */
export function findStringAssignments(tokens: Token[]): StringAssignment[] {
  const out: StringAssignment[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i]!;
    if (name.kind !== "word") continue;

    let next = tokens[i + 1];
    if (next?.kind === "punct" && next.value === "=") next = tokens[i + 2];
    if (next?.kind !== "string") continue;

    out.push({
      name: name.value,
      value: next.value,
      blockPath: name.blockPath,
      contentStart: next.contentStart,
      contentEnd: next.contentEnd,
      interpolated: next.interpolated,
    });
  }

  return out;
}

/**
 * Strings passed to a named call, covering `include(":a", ":b")` and the
 * parenthesis-free Groovy form `include ':a', ':b'`.
 */
export function findInvocationStrings(tokens: Token[], name: string): Token[] {
  const out: Token[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word" || token.value !== name) continue;

    for (let j = i + 1; j < tokens.length; j++) {
      const arg = tokens[j]!;
      if (arg.kind === "string") {
        out.push(arg);
        continue;
      }
      if (arg.kind === "punct" && (arg.value === "(" || arg.value === ",")) continue;
      break;
    }
  }

  return out;
}

export interface ProjectRef {
  /** Gradle project path, e.g. `:core` */
  path: string;
  /** the configuration it was declared in, e.g. `implementation` */
  configuration: string;
  blockPath: string[];
}

/**
 * Inter-project dependencies: `project(":core")`, `project(path: ":core")`
 * and `project(path = ":core")`.
 *
 * Type-safe accessors (`projects.core`) are not detected — they resolve through
 * generated code that only exists after a Gradle configuration phase.
 */
export function findProjectRefs(tokens: Token[]): ProjectRef[] {
  const out: ProjectRef[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word" || token.value !== "project") continue;

    let j = i + 1;
    if (tokens[j]?.kind === "punct" && tokens[j]!.value === "(") j++;

    // named argument: `path: ":core"` / `path = ":core"`
    if (tokens[j]?.kind === "word" && tokens[j]!.value === "path") {
      const separator = tokens[j + 1];
      if (separator?.kind === "punct" && (separator.value === ":" || separator.value === "=")) {
        j += 2;
      }
    }

    const arg = tokens[j];
    if (arg?.kind !== "string" || !arg.value.startsWith(":")) continue;

    out.push({
      path: normalizeProjectPath(arg.value),
      configuration: configurationBefore(tokens, i),
      blockPath: token.blockPath,
    });
  }

  return out;
}

/**
 * The configuration a `project(…)` call was declared in.
 *
 * Walks out through wrapper calls so `testImplementation(testFixtures(project(…)))`
 * reports `testImplementation` rather than `testFixtures`.
 */
function configurationBefore(tokens: Token[], index: number): string {
  let found = "";

  for (let j = index - 1; j >= 0;) {
    const token = tokens[j]!;

    if (token.kind === "punct" && token.value === "(") {
      j--;
      continue;
    }

    if (token.kind !== "word") break;

    found = token.value;
    const previous = tokens[j - 1];
    if (previous?.kind !== "punct" || previous.value !== "(") break;
    j--;
  }

  return found;
}

/**
 * Whether the script sets up publishing at all.
 *
 * Detects `id("maven-publish")`, backtick accessors, version-catalog aliases
 * whose name mentions publishing, `apply plugin: "maven-publish"`, and
 * `publishing {}` / `mavenPublishing {}` blocks.
 */
export function declaresPublishing(tokens: Token[]): boolean {
  return tokens.some((token) => {
    if (token.blockPath.some((block) => PUBLISHING_BLOCKS.has(block))) return true;
    if (token.kind === "punct") return false;

    const scope = token.blockPath;
    const declaration = scope.length === 0 || (scope.length === 1 && scope[0] === "plugins");
    return declaration && /publish/i.test(token.value);
  });
}

const PUBLISHING_BLOCKS = new Set(["publishing", "mavenPublishing"]);

/** `:a:b:` and `a:b` both mean the same project as `:a:b`. */
export function normalizeProjectPath(path: string): string {
  const trimmed = path.trim().replace(/:+$/, "");
  if (trimmed === "" || trimmed === ":") return ":";
  return trimmed.startsWith(":") ? trimmed : `:${trimmed}`;
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Apply edits back-to-front so earlier offsets stay valid. */
export function applyEdits(content: string, edits: Edit[]): string {
  let out = content;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
