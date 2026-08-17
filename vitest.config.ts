import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const UnpluginTypia = (await import("@typia/unplugin/vite")).default;

  return {
    plugins: [UnpluginTypia()],
    test: {
      env: {
        // keep the developer's own ~/.npmrc out of registry resolution
        NPM_CONFIG_USERCONFIG: path.join(import.meta.dirname, "no-such.npmrc"),
      },
    },
  };
});
