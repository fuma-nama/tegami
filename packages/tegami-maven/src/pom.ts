import { writeFile } from "node:fs/promises";
import { parseDocument, type XmlDocument, type XmlElement } from "@tegami/xml-util";

/**
 * `pom.xml` reading and format-preserving editing.
 *
 * This is a thin, Maven-flavored adapter over {@link @tegami/xml-util}, which
 * provides the underlying format-preserving XML document model. XML element
 * names are case-sensitive, so navigation is case-sensitive here.
 */

export type PomElement = XmlElement;
export type PomDocument = XmlDocument;

/** Parse `pom.xml` content into a format-preserving document. */
export function parsePom(content: string): PomDocument {
  return parseDocument(content);
}

/** First direct child element with the given local name. */
export function child(parent: PomElement, name: string): PomElement | undefined {
  return parent.get(name);
}

/** All direct child elements with the given local name. */
export function children(parent: PomElement, name: string): PomElement[] {
  return parent.getAll(name);
}

/** Resolve a path of local names from an element, returning the first match. */
export function resolvePath(from: PomElement, ...names: string[]): PomElement | undefined {
  return from.getIn(names);
}

/** Trimmed text content of a leaf element (empty string when it has no text). */
export function elementText(_doc: PomDocument, el: PomElement): string {
  return el.text;
}

/** Queue a patch replacing an element's text content with the given value. */
export function setElementText(doc: PomDocument, el: PomElement, value: string): void {
  doc.setText(el, value);
}

/** Apply queued edits and return the new document text. */
export function applyPatches(doc: PomDocument): string {
  return doc.toString();
}

/** Write the document to `path`, only when it has queued edits. */
export async function writePom(doc: PomDocument, path: string): Promise<void> {
  if (!doc.dirty) return;
  await writeFile(path, doc.toString());
}
