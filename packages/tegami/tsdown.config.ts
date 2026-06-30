import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/index.ts",
    "src/generators/simple.ts",
    "src/plugins/*",
    "src/providers/*",
  ],
  platform: "node",
  fixedExtension: false,
  target: "es2023",
  dts: {
    sourcemap: false,
  },
  exports: true,
  deps: {
    onlyBundle: [],
  },
});
