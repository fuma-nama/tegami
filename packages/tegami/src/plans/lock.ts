import { parse, stringify } from "yaml";
import typia from "typia";

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
    let res = stringify(this.data, {
      sortMapEntries: true,
      lineWidth: 0,
      blockQuote: false,
      doubleQuotedAsJSON: true,
    });
    if (!res.endsWith("\n")) res += "\n";
    return res;
  }
}

const assertPublishLockData = typia.createAssert<Record<string, unknown[]>>();

export function parsePublishLock(content: string): PublishLock {
  const data = assertPublishLockData(parse(content));
  return new PublishLock(new Map(Object.entries(data)));
}
