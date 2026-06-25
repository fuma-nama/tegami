import { dump, load } from "js-yaml";
import z from "zod";

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
    return dump(Object.fromEntries(this.data.entries()), { sortKeys: true });
  }
}

const baseSchema = z.record(z.string(), z.array(z.unknown()));

export function parsePublishLock(content: string): PublishLock {
  const data = baseSchema.parse(load(content));
  return new PublishLock(new Map(Object.entries(data)));
}
