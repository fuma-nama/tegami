import MagicString from "magic-string";
import { parseRaw, type RawElement, type RawNode, type XmlAttribute } from "./parser";

export type { Range, XmlAttribute } from "./parser";

interface ParseOptions {
  /**
   * Match element and attribute names case-insensitively during navigation.
   *
   * XML is case-sensitive, so this is `false` by default. Enable it for formats
   * that treat names case-insensitively, such as MSBuild project files.
   */
  caseInsensitive?: boolean;
}

interface Edit {
  start: number;
  end: number;
  value: string;
}

/**
 * A parsed XML document that preserves the original formatting.
 *
 * The API mirrors the `yaml` package's {@link https://eemeli.org/yaml/#documents Document}:
 * navigate with {@link get}/{@link getIn}, read data with {@link toJS}, mutate
 * text and attribute values in place, and re-serialize with {@link toString} —
 * every unedited byte (indentation, comments, attribute order) is preserved.
 *
 * Only value edits are supported (element text and attribute values); the tree
 * structure is not mutated.
 */
export class XmlDocument {
  /** the root element, or `undefined` for an empty document */
  readonly root: XmlElement | undefined;
  private readonly source: string;
  private readonly edits: Edit[] = [];

  constructor(source: string, root: RawElement | undefined, ci: boolean) {
    this.source = source;
    this.root = root ? new XmlElement(root, ci) : undefined;
  }

  /** First direct child of the root with the given (local) name. */
  get(name: string): XmlElement | undefined {
    return this.root?.get(name);
  }

  /** Resolve a path of direct-child names from the root. */
  getIn(path: string[]): XmlElement | undefined {
    return this.root?.getIn(path);
  }

  /**
   * Replace the text content of the element at `path`, preserving surrounding
   * whitespace. Returns `false` when the path does not resolve.
   */
  setIn(path: string[], value: string): boolean {
    const el = this.getIn(path);
    if (!el) return false;
    this.setText(el, value);
    return true;
  }

  /** Queue a replacement of an element's text content. */
  setText(el: XmlElement, value: string): void {
    if (el.selfClosing) {
      throw new Error(`Cannot set text on self-closing element "${el.name}".`);
    }
    const escaped = escapeText(value);
    const raw = this.source.slice(el.contentStart, el.contentEnd);

    if (raw.trim().length === 0) {
      this.edits.push({ start: el.contentStart, end: el.contentEnd, value: escaped });
      return;
    }

    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    this.edits.push({
      start: el.contentStart + leading,
      end: el.contentEnd - trailing,
      value: escaped,
    });
  }

  /**
   * Queue a replacement of an element attribute's value. Returns `false` when
   * the attribute is absent (attributes are never created).
   */
  setAttr(el: XmlElement, name: string, value: string): boolean {
    const attr = el.attr(name);
    if (!attr) return false;
    this.edits.push({
      start: attr.valueRange.start,
      end: attr.valueRange.end,
      value: escapeAttr(value),
    });
    return true;
  }

  /** Whether any edits are queued. */
  get dirty(): boolean {
    return this.edits.length > 0;
  }

  /** Serialize the document, applying queued edits over the original source. */
  toString(): string {
    if (this.edits.length === 0) return this.source;
    const s = new MagicString(this.source);
    for (const edit of this.edits) {
      if (edit.start === edit.end) s.appendLeft(edit.start, edit.value);
      else s.update(edit.start, edit.end, edit.value);
    }
    return s.toString();
  }

  /** A best-effort plain-data view of the document (see {@link XmlElement.toJS}). */
  toJS(): unknown {
    return this.root?.toJS();
  }
}

/** A single XML element with format-preserving navigation. */
export class XmlElement {
  readonly name: string;
  /** local name (namespace prefix stripped) */
  readonly localName: string;
  readonly attributes: XmlAttribute[];
  readonly selfClosing: boolean;
  readonly start: number;
  readonly end: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly children: XmlElement[];
  private readonly ci: boolean;
  private readonly textNodes: { value: string; start: number; end: number }[];

  constructor(raw: RawElement, ci: boolean) {
    this.name = raw.name;
    this.localName = localName(raw.name);
    this.attributes = raw.attributes;
    this.selfClosing = raw.selfClosing;
    this.start = raw.start;
    this.end = raw.end;
    this.contentStart = raw.contentStart;
    this.contentEnd = raw.contentEnd;
    this.ci = ci;

    const children: XmlElement[] = [];
    const textNodes: { value: string; start: number; end: number }[] = [];
    for (const node of raw.children as RawNode[]) {
      if (node.kind === "element") children.push(new XmlElement(node, ci));
      else textNodes.push({ value: stripCdata(node.value), start: node.start, end: node.end });
    }
    this.children = children;
    this.textNodes = textNodes;
  }

  private eq(a: string, b: string): boolean {
    return this.ci ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  /** First direct child element with the given local name. */
  get(name: string): XmlElement | undefined {
    return this.children.find((el) => this.eq(el.localName, name));
  }

  /** All direct child elements with the given local name. */
  getAll(name: string): XmlElement[] {
    return this.children.filter((el) => this.eq(el.localName, name));
  }

  /** Resolve a path of direct-child names, returning the first match at each step. */
  getIn(path: string[]): XmlElement | undefined {
    // oxlint-disable-next-line typescript/no-this-alias
    let current: XmlElement | undefined = this;
    for (const name of path) {
      current = current?.get(name);
      if (!current) return undefined;
    }
    return current;
  }

  /** First descendant element with the given local name (depth-first). */
  find(name: string): XmlElement | undefined {
    for (const child of this.children) {
      if (this.eq(child.localName, name)) return child;
      const nested = child.find(name);
      if (nested) return nested;
    }
    return undefined;
  }

  /** All descendant elements with the given local name (depth-first). */
  findAll(name: string): XmlElement[] {
    const out: XmlElement[] = [];
    for (const child of this.children) {
      if (this.eq(child.localName, name)) out.push(child);
      out.push(...child.findAll(name));
    }
    return out;
  }

  /** Attribute with the given name, or `undefined`. */
  attr(name: string): XmlAttribute | undefined {
    return this.attributes.find((a) => this.eq(a.name, name));
  }

  /** Trimmed text content (concatenation of direct text nodes). */
  get text(): string {
    return this.textNodes
      .map((t) => t.value)
      .join("")
      .trim();
  }

  /**
   * Best-effort plain-data view:
   * - a leaf element with no attributes becomes its text string,
   * - otherwise an object keyed by child local name (repeated children become
   *   arrays), with attributes under `@name` and text under `#text`.
   */
  toJS(): unknown {
    const hasChildren = this.children.length > 0;
    const text = this.text;

    if (!hasChildren && this.attributes.length === 0) return text;

    const obj: Record<string, unknown> = {};
    for (const attr of this.attributes) obj[`@${attr.name}`] = attr.value;
    for (const child of this.children) {
      const key = child.localName;
      const value = child.toJS();
      const existing = obj[key];
      if (existing === undefined) obj[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else obj[key] = [existing, value];
    }
    if (text) obj["#text"] = text;
    return obj;
  }
}

/**
 * Parse XML source into a format-preserving {@link XmlDocument}.
 *
 * Throws on malformed markup — swallowing parse errors would silently drop the
 * document from whatever workflow reads it. Element-free input (e.g. an empty
 * file) produces a document whose {@link XmlDocument.root} is `undefined`.
 */
export function parseDocument(source: string, options: ParseOptions = {}): XmlDocument {
  return new XmlDocument(source, parseRaw(source), options.caseInsensitive ?? false);
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function stripCdata(value: string): string {
  if (value.startsWith("<![CDATA[") && value.endsWith("]]>")) {
    return value.slice(9, -3);
  }
  return value;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
