import { dump, load, visit, type Document, type DumpOptions } from "js-yaml";
import z from "zod";

function inlineMultilineScalars(documents: Document[]): void {
  visit(documents, (node) => {
    if (node.kind !== "scalar" || !node.value.includes("\n")) return;

    node.style.doubleQuoted = true;
    node.style.literal = false;
    node.style.folded = false;
    node.style.singleQuoted = false;
  });
}

export const lockDumpOptions = {
  sortKeys: true,
  lineWidth: -1,
  transform: inlineMultilineScalars,
} satisfies DumpOptions;

/**
 * the data structure of `publish-lock.yaml` file.
 */
export class PublishLock {
  constructor(
    /** namespace -> data array */
    private readonly data = new Map<string, unknown[]>(),
  ) {}

  /** write data to namespace, note that the `data` must be serializable in yaml */
  write(namespace: string, data: unknown) {
    let arr = this.data.get(namespace);
    if (!arr) {
      arr = [];
      this.data.set(namespace, arr);
    }

    arr.push(data);
  }

  read(namespace: string): unknown | undefined {
    return this.data.get(namespace)?.shift();
  }

  size(namespace: string) {
    return this.data.get(namespace)?.length ?? 0;
  }

  serialize(): string {
    let res = dump(Object.fromEntries(this.data.entries()), lockDumpOptions);
    if (!res.endsWith("\n")) res += "\n";
    return res;
  }
}

const baseSchema = z.record(z.string(), z.array(z.unknown()));

export function parsePublishLock(content: string): PublishLock {
  const data = baseSchema.parse(load(content));
  return new PublishLock(new Map(Object.entries(data)));
}
