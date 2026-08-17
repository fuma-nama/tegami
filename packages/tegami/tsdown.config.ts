import UnpluginTypia from "@typia/unplugin/rolldown";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/index.ts",
    "src/generators/simple.ts",
    "src/plugins/*",
    "src/providers/*",
    "src/utils/index.ts",
  ],
  fixedExtension: false,
  target: "es2023",
  dts: {
    sourcemap: false,
  },
  exports: true,
  deps: {
    onlyBundle: ["typia", "@typia/interface", "package-manager-detector", "jsonc-parser", "ini"],
  },
  inputOptions: {
    resolve: {
      // `jsonc-parser` has no `exports` field and its `main` points to a UMD build.
      // The UMD wrapper receives `require` as a parameter, so its internal
      // `require("./impl/...")` calls survive bundling as runtime requires that
      // resolve against `dist/` and fail. Prefer the ESM build instead.
      mainFields: ["module", "main"],
    },
  },
  plugins: [UnpluginTypia()],
});
