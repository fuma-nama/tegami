import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^tegami$/,
        replacement: resolve(root, "packages/tegami/src/index.ts"),
      },
      {
        find: /^tegami\/utils$/,
        replacement: resolve(root, "packages/tegami/src/utils/index.ts"),
      },
      {
        find: /^@tegami\/pip$/,
        replacement: resolve(root, "packages/tegami-pip/src/index.ts"),
      },
    ],
  },
});
