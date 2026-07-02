import UnpluginTypia from "@typia/unplugin/rollup";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  platform: "node",
  fixedExtension: false,
  target: "es2023",
  dts: {
    sourcemap: false,
  },
  deps: {
    onlyBundle: ["@renovatebot/pep440", "typia"],
  },
  exports: true,
  plugins: [UnpluginTypia() as never],
});
