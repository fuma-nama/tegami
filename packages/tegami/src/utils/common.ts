import type { Awaitable } from "../types";

export const isCI = () => Boolean(process.env.CI);

export async function somePromise<T>(
  promises: Awaitable<T>[],
  fn: (value: T) => boolean,
): Promise<boolean> {
  return new Promise((res, reject) => {
    const n = promises.length;
    if (n === 0) res(false);

    let i = 0;
    for (const promise of promises) {
      if (promise instanceof Promise) {
        void promise
          .then((v) => {
            if (fn(v)) return res(true);

            i++;
            if (i === n) res(false);
          })
          .catch(reject);
        continue;
      }

      if (fn(promise)) {
        return res(true);
      }

      i++;
      if (i === n) res(false);
    }
  });
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
