import { writeFile } from "node:fs/promises";
import MagicString from "magic-string";

/**
 * A minimal, path-aware, format-preserving XML editor for `pom.xml`.
 *
 * It parses a document into a tree of {@link PomElement} nodes while tracking
 * the exact character offsets of every element and its text content. Edits are
 * expressed as patches that splice a new value into an element's text span, so
 * the rest of the document (indentation, comments, attribute ordering) is left
 * untouched.
 *
 * It intentionally understands only what Maven needs: element nesting, text
 * content, comments, CDATA, processing instructions, and doctype. Attributes
 * are skipped (never interpreted) and namespaces are treated as opaque prefixes.
 */

export interface PomElement {
  /** Local element name (namespace prefix, if any, is preserved verbatim). */
  name: string;
  /** Child elements, in document order. Text nodes are not tracked. */
  children: PomElement[];
  /** Offset of the `<` of the opening tag. */
  start: number;
  /** Offset just past the `>` of the closing tag (or self-closing tag). */
  end: number;
  /** Offset just after the opening tag's `>`. */
  contentStart: number;
  /** Offset of the `<` of the closing tag (equals {@link contentStart} when empty). */
  contentEnd: number;
  /** Whether this element was written as `<name/>`. */
  selfClosing: boolean;
}

export interface Patch {
  start: number;
  end: number;
  value: string;
}

export interface PomDocument {
  content: string;
  root?: PomElement;
  patches: Patch[];
}

interface RawTag {
  type: "open" | "close" | "selfclose";
  name: string;
  start: number;
  end: number;
}

export function parsePom(content: string): PomDocument {
  const tags = tokenize(content);
  return {
    content,
    root: buildTree(tags),
    patches: [],
  };
}

function tokenize(input: string): RawTag[] {
  const tags: RawTag[] = [];
  const n = input.length;
  let i = 0;

  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt < 0) break;

    if (input.startsWith("<!--", lt)) {
      const close = input.indexOf("-->", lt + 4);
      i = close < 0 ? n : close + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const close = input.indexOf("]]>", lt + 9);
      i = close < 0 ? n : close + 3;
      continue;
    }
    if (input.startsWith("<?", lt)) {
      const close = input.indexOf("?>", lt + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      const close = input.indexOf(">", lt + 2);
      i = close < 0 ? n : close + 1;
      continue;
    }

    const gt = findTagEnd(input, lt);
    if (gt < 0) break;

    const tag = parseTag(input.slice(lt, gt + 1), lt, gt + 1);
    if (tag) tags.push(tag);
    i = gt + 1;
  }

  return tags;
}

/** Find the `>` that closes a tag, skipping any `>` inside quoted attributes. */
function findTagEnd(input: string, lt: number): number {
  let i = lt + 1;
  let quote: string | undefined;

  while (i < input.length) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
    i++;
  }

  return -1;
}

function parseTag(raw: string, start: number, end: number): RawTag | undefined {
  let inner = raw.slice(1, -1).trim();
  let type: RawTag["type"] = "open";

  if (inner.startsWith("/")) {
    type = "close";
    inner = inner.slice(1).trim();
  } else if (inner.endsWith("/")) {
    type = "selfclose";
    inner = inner.slice(0, -1).trim();
  }

  const match = /^([^\s/>]+)/.exec(inner);
  if (!match?.[1]) return;

  return { type, name: match[1], start, end };
}

function buildTree(tags: RawTag[]): PomElement | undefined {
  const stack: PomElement[] = [];
  let root: PomElement | undefined;

  const attach = (el: PomElement) => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else root ??= el;
  };

  for (const tag of tags) {
    if (tag.type === "selfclose") {
      attach({
        name: tag.name,
        children: [],
        start: tag.start,
        end: tag.end,
        contentStart: tag.end,
        contentEnd: tag.end,
        selfClosing: true,
      });
      continue;
    }

    if (tag.type === "open") {
      const el: PomElement = {
        name: tag.name,
        children: [],
        start: tag.start,
        end: tag.end,
        contentStart: tag.end,
        contentEnd: tag.end,
        selfClosing: false,
      };
      attach(el);
      stack.push(el);
      continue;
    }

    // closing tag: unwind to the nearest matching open element
    for (let s = stack.length - 1; s >= 0; s--) {
      const el = stack[s];
      if (el && el.name === tag.name) {
        el.contentEnd = tag.start;
        el.end = tag.end;
        stack.length = s;
        break;
      }
    }
  }

  return root;
}

/** First direct child element with the given local name. */
export function child(parent: PomElement, name: string): PomElement | undefined {
  return parent.children.find((el) => localName(el.name) === name);
}

/** All direct child elements with the given local name. */
export function children(parent: PomElement, name: string): PomElement[] {
  return parent.children.filter((el) => localName(el.name) === name);
}

/** Resolve a path of local names from an element, returning the first match. */
export function resolvePath(from: PomElement, ...names: string[]): PomElement | undefined {
  let current: PomElement | undefined = from;
  for (const name of names) {
    if (!current) return;
    current = child(current, name);
  }
  return current;
}

/** Trimmed text content of a leaf element (empty string when it has no text). */
export function elementText(doc: PomDocument, el: PomElement): string {
  if (el.contentEnd <= el.contentStart) return "";
  return doc.content.slice(el.contentStart, el.contentEnd).trim();
}

/** Queue a patch replacing an element's text content with the given value. */
export function setElementText(doc: PomDocument, el: PomElement, value: string): void {
  const raw = doc.content.slice(el.contentStart, el.contentEnd);
  const escaped = escapeXml(value);

  if (raw.trim().length === 0) {
    doc.patches.push({ start: el.contentStart, end: el.contentEnd, value: escaped });
    return;
  }

  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  doc.patches.push({
    start: el.contentStart + leading,
    end: el.contentEnd - trailing,
    value: escaped,
  });
}

/** Apply queued patches and return the new document text. */
export function applyPatches(doc: PomDocument): string {
  if (doc.patches.length === 0) return doc.content;

  const s = new MagicString(doc.content);
  for (const patch of doc.patches) {
    if (patch.start === patch.end) s.appendLeft(patch.start, patch.value);
    else s.update(patch.start, patch.end, patch.value);
  }

  doc.content = s.toString();
  doc.patches.length = 0;
  return doc.content;
}

/** Apply queued patches (if any) and write the document to `path`. */
export async function writePom(doc: PomDocument, path: string): Promise<void> {
  if (doc.patches.length === 0) return;
  await writeFile(path, applyPatches(doc));
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
