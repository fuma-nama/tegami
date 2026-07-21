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
  /** attribute value, normalized (§3.3.3) and with entity references decoded */
  value: string;
  nameRange: Range;
  /** range of the value in the source, excluding the surrounding quotes */
  valueRange: Range;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * The code points a document may contain (XML 1.0 §2.2 `Char`).
 *
 * Surrogates, NUL, and the other control characters are excluded: decoding
 * `&#xD800;` would put a lone surrogate into the value, which cannot be encoded
 * back to UTF-8 when the document is written out.
 */
function isLegalChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/**
 * Decode XML entity references in a single pass, so `&amp;lt;` decodes to the
 * literal text `&lt;` rather than being decoded twice into `<`.
 *
 * Unknown entities are left verbatim — this reader has no DTD, so inventing a
 * replacement would lose information that a round-trip must preserve. So are
 * character references outside `Char` (§4.1 WFC: Legal Character), which have no
 * representable value to decode to.
 */
export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;

  // `CharRef` (§4.1) is decimal or lowercase-`x` hex only, so `&#1F;` is not a
  // reference at all and must not be read as the decimal `1`.
  return value.replace(/&(#[0-9]+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (match, ref: string) => {
    if (ref.startsWith("#")) {
      const codePoint = ref.startsWith("#x")
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
      return isLegalChar(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES[ref] ?? match;
  });
}

/**
 * Attribute-value normalization (§3.3.3): a literal whitespace character in an
 * attribute value stands for a single space, and a CRLF pair collapses to one
 * space (line endings are normalized first, §2.11). Multi-line attributes are
 * common in the wild — `xsi:schemaLocation` conventionally wraps — so the value
 * a caller reads must be the normalized one.
 *
 * Character references are decoded afterwards: the spec normalizes the literal
 * characters, not the referenced ones, so `&#xA;` still yields a newline.
 */
export function normalizeAttributeValue(raw: string): string {
  return decodeEntities(raw.replace(/\r\n|[\t\n\r]/g, " "));
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
        this.skipProcessingInstruction();
        continue;
      }
      if (this.s.startsWith("<!--", this.pos)) {
        this.skipComment();
        continue;
      }
      if (this.s.startsWith("<!", this.pos)) {
        this.skipDeclaration();
        continue;
      }
      break;
    }
  }

  /** Skip a processing instruction, `<?` through the matching `?>` (§2.6). */
  private skipProcessingInstruction(): void {
    const end = this.s.indexOf("?>", this.pos + 2);
    this.pos = end < 0 ? this.s.length : end + 2;
  }

  /** Skip a comment, `<!--` through the matching `-->` (§2.5). */
  private skipComment(): void {
    const end = this.s.indexOf("-->", this.pos + 4);
    this.pos = end < 0 ? this.s.length : end + 3;
  }

  /**
   * Skip a markup declaration such as `<!DOCTYPE ...>` (§2.8).
   *
   * The terminating `>` cannot be found by a plain search: `doctypedecl` may
   * carry a `>` inside a quoted system/public literal or inside its `[...]`
   * internal subset. Stopping at the first one would resume parsing mid-DTD and
   * lose the root element entirely.
   */
  private skipDeclaration(): void {
    this.pos += 2;
    let subset = 0;
    while (this.pos < this.s.length) {
      const char = this.s[this.pos]!;
      if (char === '"' || char === "'") {
        const end = this.s.indexOf(char, this.pos + 1);
        this.pos = end < 0 ? this.s.length : end + 1;
        continue;
      }
      if (char === "[") subset++;
      else if (char === "]") subset--;
      else if (char === ">" && subset <= 0) {
        this.pos++;
        return;
      }
      this.pos++;
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
    const close = this.parseChildren(children, name, start);

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

  /**
   * Parse children until the closing tag for `name`; returns its offsets.
   *
   * Throws when the closing tag names a different element or never arrives —
   * accepting either would silently reparent nodes and corrupt edit offsets.
   */
  private parseChildren(
    children: RawNode[],
    name: string,
    start: number,
  ): { contentEnd: number; end: number } {
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
        this.skipComment();
        continue;
      }
      // `content` (§3) admits processing instructions between children, not just
      // in the prolog; without this the PI would be read as an element named `?…`
      if (this.s.startsWith("<?", this.pos)) {
        this.skipProcessingInstruction();
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
        const closeName = this.readName();
        if (closeName !== name) {
          throw new Error(
            `Mismatched closing tag: expected "</${name}>" for the element opened at offset ${start}, found "</${closeName}>" at offset ${contentEnd}.`,
          );
        }
        this.skipWhitespace();
        if (this.s[this.pos] === ">") this.pos++;
        return { contentEnd, end: this.pos };
      }

      const child = this.parseElement();
      if (!child) break;
      children.push(child);
    }

    throw new Error(`Unclosed element "${name}" opened at offset ${start}.`);
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
        value: normalizeAttributeValue(this.s.slice(valueStart, valueEnd)),
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
