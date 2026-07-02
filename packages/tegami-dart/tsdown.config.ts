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
});
