/**
 * A minimal, format-preserving XML reader.
 *
 * It parses just enough of the grammar (elements, attributes, text, comments,
 * CDATA, prolog, doctype) to locate values, and records the exact character
 * ranges of every node so edits can be spliced into the original text without
 * re-serializing the document.
 */

export interface Range {
  /** inclusive start offset into the source */
  start: number;
  /** exclusive end offset into the source */
  end: number;
}

export interface XmlAttribute {
  /** attribute name, verbatim (namespace prefix included) */
  name: string;
  /** attribute value, unescaped only of surrounding quotes */
  value: string;
  nameRange: Range;
  /** range of the value, excluding the surrounding quotes */
  valueRange: Range;
}

export interface RawText {
  kind: "text";
  /** raw source, including any CDATA markers */
  value: string;
  start: number;
  end: number;
}

export interface RawElement {
  kind: "element";
  /** element name, verbatim (namespace prefix included) */
  name: string;
  attributes: XmlAttribute[];
  children: RawNode[];
  selfClosing: boolean;
  /** offset of the `<` of the opening tag */
  start: number;
  /** offset just past the `>` of the closing (or self-closing) tag */
  end: number;
  /** offset just after the opening tag's `>` */
  contentStart: number;
  /** offset of the `<` of the closing tag (equals contentStart when empty) */
  contentEnd: number;
}

export type RawNode = RawElement | RawText;

/**
 * Parse XML source into a raw node tree.
 *
 * Returns `undefined` when the input contains no element at all (e.g. an empty
 * file); throws on malformed markup.
 */
export function parseRaw(input: string): RawElement | undefined {
  return new Parser(input).parseDocument();
}

class Parser {
  private pos = 0;

  constructor(private readonly s: string) {
    // skip a leading byte-order mark
    if (s.charCodeAt(0) === 0xfeff) this.pos = 1;
  }

  parseDocument(): RawElement | undefined {
    this.skipMisc();
    return this.parseElement();
  }

  private skipWhitespace(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos]!)) this.pos++;
  }

  /** Skip prolog, comments, doctype, and processing instructions before the root. */
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

  private parseElement(): RawElement | undefined {
    if (this.s[this.pos] !== "<") return;
    const start = this.pos;
    this.pos++;
    const name = this.readName();
    if (!name) throw new Error(`Malformed tag at offset ${start}.`);

    const attributes = this.parseAttributes();
    this.skipWhitespace();

    let selfClosing = false;
    if (this.s.startsWith("/>", this.pos)) {
      selfClosing = true;
      this.pos += 2;
    } else if (this.s[this.pos] === ">") {
      this.pos++;
    } else {
      throw new Error(`Unterminated tag "${name}" at offset ${start}.`);
    }

    const contentStart = this.pos;

    if (selfClosing) {
      return {
        kind: "element",
        name,
        attributes,
        children: [],
        selfClosing,
        start,
        end: this.pos,
        contentStart,
        contentEnd: contentStart,
      };
    }

    const children: RawNode[] = [];
    const close = this.parseChildren(children);

    return {
      kind: "element",
      name,
      attributes,
      children,
      selfClosing,
      start,
      end: close.end,
      contentStart,
      contentEnd: close.contentEnd,
    };
  }

  /** Parse children until the matching closing tag; returns its offsets. */
  private parseChildren(children: RawNode[]): { contentEnd: number; end: number } {
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

      if (this.pos >= this.s.length) break;

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
        const contentEnd = this.pos;
        this.pos += 2;
        this.readName();
        this.skipWhitespace();
        if (this.s[this.pos] === ">") this.pos++;
        return { contentEnd, end: this.pos };
      }

      const child = this.parseElement();
      if (!child) break;
      children.push(child);
    }

    // reached EOF without a closing tag
    return { contentEnd: this.pos, end: this.pos };
  }

  private parseAttributes(): XmlAttribute[] {
    const attributes: XmlAttribute[] = [];
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
        // valueless attribute; keep scanning
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
