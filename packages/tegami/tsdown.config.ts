import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/index.ts",
    "src/context.ts",
    "src/graph.ts",
    "src/generators/simple.ts",
    "src/plans/draft.ts",
    "src/plugins/*",
    "src/providers/*",
    "src/utils/error.ts",
    "src/utils/semver.ts",
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
