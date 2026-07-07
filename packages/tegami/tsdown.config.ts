import UnpluginTypia from "@typia/unplugin/rollup";
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
    onlyBundle: ["typia", "@typia/interface", "package-manager-detector"],
  },
  plugins: [UnpluginTypia() as never],
});
