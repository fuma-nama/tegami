/**
 * Minimal `gradle.properties` reader that keeps byte offsets, so a bump can
 * replace a single value and leave comments, ordering and spacing untouched.
 */

export interface PropertyEntry {
  key: string;
  value: string;
  /** offsets of the value, excluding the separator and the trailing newline */
  start: number;
  end: number;
}

export interface PropertiesFile {
  /** absolute path to `gradle.properties` */
  path: string;
  content: string;
  entries: Map<string, PropertyEntry>;
}

const SEPARATOR = /[=:\s]/;

export function parseProperties(path: string, content: string): PropertiesFile {
  const entries = new Map<string, PropertyEntry>();
  let offset = 0;

  while (offset < content.length) {
    const lineEnd = indexOfLineEnd(content, offset);
    const line = content.slice(offset, lineEnd);
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      offset = lineEnd + 1;
      continue;
    }

    let cursor = 0;
    while (cursor < trimmed.length && !SEPARATOR.test(trimmed[cursor]!)) {
      // an escaped separator is part of the key
      if (trimmed[cursor] === "\\") cursor++;
      cursor++;
    }

    const key = trimmed.slice(0, cursor);
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor]!)) cursor++;
    if (trimmed[cursor] === "=" || trimmed[cursor] === ":") cursor++;
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor]!)) cursor++;

    const valueStart = offset + indent + cursor;
    // a value continues onto the next line when the line ends with an odd
    // number of backslashes
    let valueEnd = lineEnd;
    while (hasContinuation(content.slice(valueStart, valueEnd))) {
      const nextEnd = indexOfLineEnd(content, valueEnd + 1);
      if (nextEnd === valueEnd) break;
      valueEnd = nextEnd;
    }

    // keep trailing whitespace (notably `\r` on CRLF files) outside the span so
    // rewriting a value cannot corrupt line endings
    let trimmedEnd = valueEnd;
    while (trimmedEnd > valueStart && /\s/.test(content[trimmedEnd - 1]!)) trimmedEnd--;

    if (key.length > 0 && !entries.has(key)) {
      entries.set(key, {
        key,
        value: content.slice(valueStart, trimmedEnd),
        start: valueStart,
        end: trimmedEnd,
      });
    }

    offset = valueEnd + 1;
  }

  return { path, content, entries };
}

function indexOfLineEnd(content: string, from: number): number {
  const index = content.indexOf("\n", from);
  return index === -1 ? content.length : index;
}

function hasContinuation(value: string): boolean {
  const match = /\\+$/.exec(value);
  return match ? match[0].length % 2 === 1 : false;
}
