import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Cross-origin isolation is a Phase 0 measurement, not a settled decision.
 * PLAN.md 7.3 requires us to know whether threaded WASM needs COOP/COEP and
 * what that costs in fonts, package fetches, OAuth popups and third-party APIs,
 * so the headers are switchable rather than baked in. Netlify mirrors this via
 * netlify.toml, and both must be flipped together when the decision lands.
 */
const crossOriginIsolated = process.env.OPAL_COI === "1";

const isolationHeaders = crossOriginIsolated
  ? {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    }
  : {};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  define: {
    __OPAL_CROSS_ORIGIN_ISOLATED__: JSON.stringify(crossOriginIsolated),
  },
});
