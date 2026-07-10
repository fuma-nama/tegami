import { writeFile } from "node:fs/promises";

/**
 * Minimal, format-preserving XML reader for MSBuild project files.
 *
 * It parses just enough of the grammar (elements, attributes, text, comments,
 * CDATA, prolog) to locate values, and records their character ranges so edits
 * can be spliced into the original text without re-serializing the document.
 */

export interface Range {
  start: number;
  end: number;
}

export interface XmlText extends Range {
  kind: "text";
  value: string;
}

export interface XmlAttr {
  name: string;
  nameLower: string;
  value: string;
  nameRange: Range;
  /** range of the attribute value, excluding the surrounding quotes */
  valueRange: Range;
}

export interface XmlElement extends Range {
  kind: "element";
  name: string;
  nameLower: string;
  attributes: XmlAttr[];
  children: XmlNode[];
  selfClosing: boolean;
}

export type XmlNode = XmlElement | XmlText;

export interface Patch extends Range {
  value: string;
}

export interface XmlFile {
  path: string;
  content: string;
  root: XmlElement | undefined;
  patches: Patch[];
}

export function parseXml(input: string): XmlElement {
  const parser = new XmlParser(input);
  const root = parser.parseDocument();
  if (!root) throw new Error("Expected an XML root element.");
  return root;
}

class XmlParser {
  private pos = 0;

  constructor(private readonly s: string) {
    if (s.charCodeAt(0) === 0xfeff) this.pos = 1;
  }

  parseDocument(): XmlElement | undefined {
    this.skipMisc();
    return this.parseElement();
  }

  private skipWhitespace(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos]!)) this.pos++;
  }

  /** Skip prolog, comments, doctype, and processing instructions. */
  private skipMisc(): void {
    while (this.pos < this.s.length) {
      this.skipWhitespace();
      if (this.s.startsWith("<?", this.pos)) {
        const end = this.s.indexOf("?>", this.pos);
        this.pos = end < 0 ? this.s.length : end + 2;
        continue;
      }
      if (this.s.startsWith("<!--", this.pos)) {
        const end = this.s.indexOf("-->", this.pos);
        this.pos = end < 0 ? this.s.length : end + 3;
        continue;
      }
      if (this.s.startsWith("<!", this.pos)) {
        const end = this.s.indexOf(">", this.pos);
        this.pos = end < 0 ? this.s.length : end + 1;
        continue;
      }
      break;
    }
  }

  private parseElement(): XmlElement | undefined {
    if (this.s[this.pos] !== "<") return;
    const start = this.pos;
    this.pos++;
    const name = this.readName();
    if (!name) throw new Error(`Malformed tag at ${start}.`);

    const attributes = this.parseAttributes();
    this.skipWhitespace();

    let selfClosing = false;
    if (this.s.startsWith("/>", this.pos)) {
      selfClosing = true;
      this.pos += 2;
    } else if (this.s[this.pos] === ">") {
      this.pos++;
    } else {
      throw new Error(`Unterminated tag "${name}" at ${start}.`);
    }

    const children: XmlNode[] = [];
    if (!selfClosing) {
      this.parseChildren(children);
    }

    return {
      kind: "element",
      name,
      nameLower: name.toLowerCase(),
      attributes,
      children,
      selfClosing,
      start,
      end: this.pos,
    };
  }

  private parseChildren(children: XmlNode[]): void {
    while (this.pos < this.s.length) {
      const textStart = this.pos;
      while (this.pos < this.s.length && this.s[this.pos] !== "<") this.pos++;
      if (this.pos > textStart) {
        children.push({
          kind: "text",
          start: textStart,
          end: this.pos,
          value: this.s.slice(textStart, this.pos),
        });
      }

      if (this.pos >= this.s.length) return;

      if (this.s.startsWith("<!--", this.pos)) {
        const end = this.s.indexOf("-->", this.pos);
        this.pos = end < 0 ? this.s.length : end + 3;
        continue;
      }
      if (this.s.startsWith("<![CDATA[", this.pos)) {
        const cdataStart = this.pos;
        const end = this.s.indexOf("]]>", this.pos);
        this.pos = end < 0 ? this.s.length : end + 3;
        children.push({
          kind: "text",
          start: cdataStart,
          end: this.pos,
          value: this.s.slice(cdataStart, this.pos),
        });
        continue;
      }
      if (this.s.startsWith("</", this.pos)) {
        this.pos += 2;
        this.readName();
        this.skipWhitespace();
        if (this.s[this.pos] === ">") this.pos++;
        return;
      }

      const child = this.parseElement();
      if (!child) return;
      children.push(child);
    }
  }

  private parseAttributes(): XmlAttr[] {
    const attributes: XmlAttr[] = [];
    while (true) {
      this.skipWhitespace();
      const char = this.s[this.pos];
      if (char === undefined || char === ">" || char === "/") break;

      const nameStart = this.pos;
      const name = this.readName();
      if (!name) break;
      const nameRange = { start: nameStart, end: this.pos };

      this.skipWhitespace();
      if (this.s[this.pos] !== "=") {
        // valueless attribute, ignore but keep parsing
        continue;
      }
      this.pos++;
      this.skipWhitespace();

      const quote = this.s[this.pos];
      if (quote !== '"' && quote !== "'") break;
      this.pos++;
      const valueStart = this.pos;
      while (this.pos < this.s.length && this.s[this.pos] !== quote) this.pos++;
      const valueEnd = this.pos;
      if (this.s[this.pos] === quote) this.pos++;

      attributes.push({
        name,
        nameLower: name.toLowerCase(),
        value: this.s.slice(valueStart, valueEnd),
        nameRange,
        valueRange: { start: valueStart, end: valueEnd },
      });
    }
    return attributes;
  }

  private readName(): string {
    const start = this.pos;
    while (this.pos < this.s.length && !/[\s/>=]/.test(this.s[this.pos]!)) this.pos++;
    return this.s.slice(start, this.pos);
  }
}

/** All descendant elements (including nested) matching `nameLower`. */
export function findDescendants(root: XmlElement, nameLower: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (el: XmlElement) => {
    for (const child of el.children) {
      if (child.kind !== "element") continue;
      if (child.nameLower === nameLower) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** First direct `<PropertyGroup>` child element matching `nameLower`, searched across every property group. */
export function findProperty(root: XmlElement, nameLower: string): XmlElement | undefined {
  for (const group of findDescendants(root, "propertygroup")) {
    for (const child of group.children) {
      if (child.kind === "element" && child.nameLower === nameLower) return child;
    }
  }
  return undefined;
}

export function getAttr(el: XmlElement, nameLower: string): XmlAttr | undefined {
  return el.attributes.find((attr) => attr.nameLower === nameLower);
}

/**
 * The trimmed text content of an element plus the exact range of that trimmed
 * token, so an edit preserves surrounding indentation and newlines.
 */
export function getElementText(el: XmlElement): { value: string; range: Range } | undefined {
  for (const child of el.children) {
    if (child.kind !== "text") continue;
    const trimmed = child.value.trim();
    if (trimmed.length === 0) continue;

    const lead = child.value.length - child.value.trimStart().length;
    const start = child.start + lead;
    return { value: trimmed, range: { start, end: start + trimmed.length } };
  }
  return undefined;
}

export function addPatch(file: XmlFile, range: Range, value: string): void {
  file.patches.push({ start: range.start, end: range.end, value });
}

export function applyPatches(content: string, patches: Patch[]): string {
  const ordered = [...patches].sort((a, b) => b.start - a.start);
  let out = content;
  for (const patch of ordered) {
    out = `${out.slice(0, patch.start)}${patch.value}${out.slice(patch.end)}`;
  }
  return out;
}

export async function writeXmlFile(file: XmlFile): Promise<void> {
  if (file.patches.length === 0) return;
  const content = applyPatches(file.content, file.patches);
  file.content = content;
  file.patches.length = 0;
  await writeFile(file.path, content);
}
