import type { Awaitable } from "../types";

export const isCI = () => Boolean(process.env.CI);

export function joinPath(...paths: string[]): string {
  let out = "";
  for (const path of paths) {
    if (path.length === 0) continue;
    if (!out) {
      out = path;
      continue;
    }

    if (out.endsWith("/") && path.startsWith("/")) {
      out += path.slice(1);
      continue;
    }

    if (!out.endsWith("/") && !path.startsWith("/")) out += "/";
    out += path;
  }
  return out;
}

/**
 * Run `fn` over the items with at most `concurrency` of them in flight.
 *
 * Results keep the order of `items`, the first rejection rejects like `Promise.all`.
 */
export async function runConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Awaitable<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function work() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, work));
  return results;
}

/**
 * Like {@link runConcurrent}, but resolves with the first item satisfying `fn`.
 *
 * Items that have not started yet are skipped once a match is found, which item wins is
 * undefined when several match.
 */
export async function findConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Awaitable<boolean>,
): Promise<T | undefined> {
  let next = 0;
  let found: T | undefined;
  let matched = false;

  async function work() {
    while (!matched && next < items.length) {
      const index = next++;
      if (await fn(items[index]!, index)) {
        matched = true;
        found = items[index];
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, work));
  return found;
}

export function cached<Args extends unknown[], V>(
  cacheKey: (...args: Args) => string,
  fn: (...args: Args) => Awaitable<V>,
  cacheMap = new Map<string, Awaitable<V>>(),
): (...args: Args) => Awaitable<V> {
  return (...args) => {
    const key = cacheKey(...args);
    let out = cacheMap.get(key);
    if (!out) {
      out = fn(...args);
      cacheMap.set(key, out);
    }
    return out;
  };
}
