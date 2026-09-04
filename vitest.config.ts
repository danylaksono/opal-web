import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  define: {
    __OPAL_CROSS_ORIGIN_ISOLATED__: "false",
    __MUPDF_VERSION__: '"test"',
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "tests/unit/**/*.test.ts",
      "tests/scripts/**/*.test.ts",
    ],
    setupFiles: [],
  },
});
