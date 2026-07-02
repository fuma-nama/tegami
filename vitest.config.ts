import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const UnpluginTypia = (await import("@typia/unplugin/vite")).default;

  return {
    plugins: [UnpluginTypia()],
  };
});
