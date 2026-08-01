import type { Awaitable } from "../types";

export const isCI = () => Boolean(process.env.CI);

/** resolve with the first index satisfying `fn` as soon as it settles, or `-1` after all settle */
export async function findPromiseIndex<T>(
  promises: Awaitable<T>[],
  fn: (value: T) => boolean,
): Promise<number> {
  return new Promise((res, reject) => {
    let n = promises.length;
    if (n === 0) res(-1);

    for (let i = 0; i < promises.length; i++) {
      const promise = promises[i]!;
      if (promise instanceof Promise) {
        void promise
          .then((v) => {
            if (fn(v)) return res(i);

            n--;
            if (n === 0) res(-1);
          })
          .catch(reject);
        continue;
      }

      if (fn(promise)) {
        return res(i);
      }

      n--;
      if (n === 0) res(-1);
    }
  });
}

export async function somePromise<T>(
  promises: Awaitable<T>[],
  fn: (value: T) => boolean,
): Promise<boolean> {
  return (await findPromiseIndex(promises, fn)) !== -1;
}

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
