import { writeFile } from "node:fs/promises";

export type ZonValue = ZonString | ZonMultilineString | ZonChar | ZonEnum | ZonObject | ZonLiteral;

export interface Range {
  start: number;
  end: number;
}

export interface ZonString extends Range {
  kind: "string";
  value: string;
}

export interface ZonMultilineString extends Range {
  kind: "multiline-string";
  value: string;
}

export interface ZonChar extends Range {
  kind: "char";
  value: string;
}

export interface ZonEnum extends Range {
  kind: "enum";
  value: string;
}

export interface ZonLiteral extends Range {
  kind: "literal";
  value: string;
}

export interface ZonField {
  name: string;
  nameRange: Range;
  value: ZonValue;
}

export interface ZonObject extends Range {
  kind: "object";
  fields: ZonField[];
  items: ZonValue[];
}

export interface ZonFile {
  path: string;
  dir: string;
  content: string;
  root: ZonObject;
  patches: Patch[];
}

export interface Patch {
  start: number;
  end: number;
  value: string;
}

export function parseZon(input: string): ZonValue {
  const parser = new ZonParser(input);
  const value = parser.parseValue();
  parser.skipTrivia();

  if (!parser.isDone()) {
    throw new Error(`Unexpected token at ${parser.offset}.`);
  }

  return value;
}

export function parseZonObject(input: string): ZonObject {
  const value = parseZon(input);
  if (value.kind !== "object") {
    throw new Error("Expected build.zig.zon to contain a root .{} object.");
  }

  return value;
}

class ZonParser {
  offset = 0;

  constructor(private readonly input: string) {
    if (input.charCodeAt(0) === 0xfeff) this.offset = 1;
  }

  isDone(): boolean {
    return this.offset >= this.input.length;
  }

  parseValue(): ZonValue {
    this.skipTrivia();
    const start = this.offset;
    const char = this.input[this.offset];

    if (char === '"') return this.parseString();
    if (char === "'") return this.parseChar();
    if (char === "\\" && this.input[this.offset + 1] === "\\") {
      return this.parseMultilineString();
    }
    if (char === "-") return this.parseNegativeLiteral(start);
    if (char === ".") {
      this.offset++;
      this.skipTrivia();
      if (this.input[this.offset] === "{") return this.parseObject(start);
      return this.parseEnum(start);
    }

    return this.parseLiteral();
  }

  skipTrivia(): void {
    while (this.offset < this.input.length) {
      const char = this.input[this.offset]!;
      if (/\s/.test(char)) {
        this.offset++;
        continue;
      }

      if (char === "/" && this.input[this.offset + 1] === "/") {
        this.offset += 2;
        while (this.offset < this.input.length && this.input[this.offset] !== "\n") this.offset++;
        continue;
      }

      break;
    }
  }

  private parseObject(start: number): ZonObject {
    this.expect("{");
    const fields: ZonField[] = [];
    const items: ZonValue[] = [];
    let needsComma = false;

    while (true) {
      this.skipTrivia();
      if (this.input[this.offset] === "}") {
        this.offset++;
        break;
      }

      if (needsComma) throw new Error(`Expected "," at ${this.offset}.`);

      const field = this.tryParseField();
      if (field) fields.push(field);
      else items.push(this.parseValue());

      this.skipTrivia();
      if (this.input[this.offset] === ",") {
        this.offset++;
        needsComma = false;
      } else {
        needsComma = true;
      }
    }

    if (fields.length > 0 && items.length > 0) {
      throw new Error(`ZON containers cannot mix fields and tuple items at ${start}.`);
    }

    return {
      kind: "object",
      start,
      end: this.offset,
      fields,
      items,
    };
  }

  private tryParseField(): ZonField | undefined {
    const checkpoint = this.offset;
    if (this.input[this.offset] !== ".") return;

    this.offset++;
    const nameStart = checkpoint;
    const name = this.parseNameAfterDot();
    if (name === undefined) {
      this.offset = checkpoint;
      return;
    }

    const nameEnd = this.offset;
    this.skipTrivia();
    if (this.input[this.offset] !== "=") {
      this.offset = checkpoint;
      return;
    }

    this.offset++;
    return {
      name,
      nameRange: {
        start: nameStart,
        end: nameEnd,
      },
      value: this.parseValue(),
    };
  }

  private parseEnum(start: number): ZonEnum {
    const value = this.parseNameAfterDot();
    if (value === undefined) throw new Error(`Expected enum literal at ${start}.`);

    return {
      kind: "enum",
      start,
      end: this.offset,
      value,
    };
  }

  private parseNameAfterDot(): string | undefined {
    this.skipTrivia();
    if (this.input[this.offset] === "@") {
      this.offset++;
      if (this.input[this.offset] !== '"') return;
      return this.parseString().value;
    }

    const name = this.readIdentifier();
    return name || undefined;
  }

  private parseString(): ZonString {
    const start = this.offset;
    this.expect('"');
    let value = "";

    while (this.offset < this.input.length) {
      const char = this.input[this.offset++]!;
      if (char === '"') {
        return {
          kind: "string",
          start,
          end: this.offset,
          value,
        };
      }

      if (isLineBreak(char)) {
        throw new Error(`Unterminated string at ${start}.`);
      }

      if (char !== "\\") {
        value += char;
        continue;
      }

      value += this.readEscape();
    }

    throw new Error(`Unterminated string at ${start}.`);
  }

  private parseMultilineString(): ZonMultilineString {
    const start = this.offset;
    let value = "";
    let first = true;

    while (true) {
      this.expect("\\");
      this.expect("\\");
      const lineStart = this.offset;
      while (this.offset < this.input.length && !isLineBreak(this.input[this.offset]!)) {
        this.offset++;
      }

      if (first) first = false;
      else value += "\n";
      value += this.input.slice(lineStart, this.offset);

      const lineEnd = this.offset;
      const newlineEnd = consumeLineBreak(this.input, this.offset);
      if (newlineEnd === this.offset) break;

      let next = newlineEnd;
      while (this.input[next] === " " || this.input[next] === "\t") next++;
      if (this.input[next] !== "\\" || this.input[next + 1] !== "\\") {
        this.offset = lineEnd;
        break;
      }

      this.offset = next;
    }

    return {
      kind: "multiline-string",
      start,
      end: this.offset,
      value,
    };
  }

  private parseChar(): ZonChar {
    const start = this.offset;
    this.expect("'");

    const value =
      this.input[this.offset] === "\\"
        ? (this.offset++, this.readEscape())
        : this.readCharCodepoint();
    if (value === undefined) throw new Error(`Unterminated char literal at ${start}.`);
    this.expect("'");

    return {
      kind: "char",
      start,
      end: this.offset,
      value,
    };
  }

  private readEscape(): string {
    const escaped = this.input[this.offset++]!;
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "0":
        return "\0";
      case "\\":
      case '"':
      case "'":
        return escaped;
      case "x": {
        const hex = this.input.slice(this.offset, this.offset + 2);
        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
          throw new Error(`Invalid hex escape at ${this.offset}.`);
        }
        this.offset += 2;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      case "u":
        if (this.input[this.offset] === "{") {
          const end = this.input.indexOf("}", this.offset + 1);
          if (end < 0) throw new Error(`Unterminated unicode escape at ${this.offset}.`);

          const hex = this.input.slice(this.offset + 1, end);
          if (!/^[0-9A-Fa-f]+$/.test(hex)) {
            throw new Error(`Invalid unicode escape at ${this.offset}.`);
          }

          const codepoint = Number.parseInt(hex, 16);
          if (codepoint > 0x10ffff) {
            throw new Error(`Invalid unicode escape at ${this.offset}.`);
          }

          this.offset = end + 1;
          return String.fromCodePoint(codepoint);
        }
        break;
    }

    throw new Error(`Invalid escape at ${this.offset - 1}.`);
  }

  private parseNegativeLiteral(start: number): ZonLiteral {
    this.expect("-");
    this.skipTrivia();
    const literal = this.parseLiteral();
    if (!isUnsignedNumberOrSpecialLiteral(literal.value)) {
      throw new Error(`Unsupported ZON literal "-${literal.value}" at ${start}.`);
    }

    return {
      ...literal,
      start,
      value: `-${literal.value}`,
    };
  }

  private readCharCodepoint(): string | undefined {
    const codepoint = this.input.codePointAt(this.offset);
    if (codepoint === undefined) return;

    const value = String.fromCodePoint(codepoint);
    if (isLineBreak(value)) return;

    this.offset += value.length;
    return value;
  }

  private parseLiteral(): ZonLiteral {
    const start = this.offset;
    while (this.offset < this.input.length && !/[\s,}]/.test(this.input[this.offset]!)) {
      this.offset++;
    }

    if (this.offset === start) throw new Error(`Unexpected token at ${start}.`);
    const value = this.input.slice(start, this.offset);
    if (!isZonLiteral(value)) {
      throw new Error(`Unsupported ZON literal "${value}" at ${start}.`);
    }

    return {
      kind: "literal",
      start,
      end: this.offset,
      value,
    };
  }

  private readIdentifier(): string {
    const start = this.offset;
    if (!/[A-Za-z_]/.test(this.input[this.offset] ?? "")) return "";

    this.offset++;
    while (/[A-Za-z0-9_]/.test(this.input[this.offset] ?? "")) this.offset++;
    return this.input.slice(start, this.offset);
  }

  private expect(char: string): void {
    if (this.input[this.offset] !== char) {
      throw new Error(`Expected "${char}" at ${this.offset}.`);
    }
    this.offset++;
  }
}

export function getField(obj: ZonObject, name: string): ZonField | undefined {
  return obj.fields.find((field) => field.name === name);
}

export function replaceNode(file: ZonFile, node: Range, value: string): void {
  file.patches.push({
    start: node.start,
    end: node.end,
    value,
  });
}

export async function writeZonFile(file: ZonFile): Promise<void> {
  if (file.patches.length === 0) return;

  const patches = [...file.patches].sort((a, b) => b.start - a.start);
  let content = file.content;
  for (const patch of patches) {
    content = `${content.slice(0, patch.start)}${patch.value}${content.slice(patch.end)}`;
  }

  file.content = content;
  file.patches.length = 0;
  await writeFile(file.path, content);
}

export function printZigString(value: string): string {
  return JSON.stringify(value);
}

function isLineBreak(char: string): boolean {
  return char === "\n" || char === "\r";
}

function consumeLineBreak(input: string, offset: number): number {
  if (input[offset] === "\r" && input[offset + 1] === "\n") return offset + 2;
  if (isLineBreak(input[offset] ?? "")) return offset + 1;
  return offset;
}

function isZonLiteral(value: string): boolean {
  if (value.startsWith("-")) return isUnsignedNumberOrSpecialLiteral(value.slice(1));
  if (/^(?:true|false|null)$/.test(value)) return true;
  return isUnsignedNumberOrSpecialLiteral(value);
}

function isUnsignedNumberOrSpecialLiteral(value: string): boolean {
  if (/^(?:nan|inf)$/.test(value)) return true;
  if (/^(?:0b[01_]+|0o[0-7_]+|0x[0-9A-Fa-f_]+|[0-9][0-9_]*)$/.test(value)) {
    return true;
  }
  if (/^[0-9][0-9_]*(?:\.[0-9_]+)?[eE][+-]?[0-9_]+$/.test(value)) return true;
  if (/^[0-9][0-9_]*\.[0-9_]+$/.test(value)) return true;
  return /^0x(?:[0-9A-Fa-f_]+(?:\.[0-9A-Fa-f_]*)?|\.[0-9A-Fa-f_]+)[pP][+-]?[0-9_]+$/.test(value);
}
