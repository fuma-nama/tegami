import UnpluginTypia from "@typia/unplugin/rolldown";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  platform: "node",
  fixedExtension: false,
  target: "es2023",
  dts: {
    sourcemap: false,
  },
  exports: true,
  deps: {
    onlyBundle: ["typia"],
  },
  plugins: [UnpluginTypia()],
});
