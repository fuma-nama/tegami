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
