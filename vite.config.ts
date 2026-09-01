import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// mupdf's exports map does not expose package.json, and its WASM binary is not
// an exported subpath either, so both are reached by path rather than by
// specifier. The alias below is what lets the worker import the binary as a
// normal Vite asset.
const mupdfPackageJson = fileURLToPath(
  new URL("./node_modules/mupdf/package.json", import.meta.url),
);
const mupdfWasmFile = fileURLToPath(
  new URL("./node_modules/mupdf/dist/mupdf-wasm.wasm", import.meta.url),
);
const mupdfVersion: string = JSON.parse(
  readFileSync(mupdfPackageJson, "utf8"),
).version;

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
    alias: [
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
      // A regex, not a string: alias keys are matched against the whole id, and
      // the worker imports this with a `?url` suffix to have Vite emit the
      // binary as a content-hashed asset.
      { find: /^mupdf-wasm-binary/, replacement: mupdfWasmFile },
    ],
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: "es" },
  optimizeDeps: {
    // mupdf boots its WASM runtime on import and resolves the binary through a
    // locateFile hook. Prebundling rewrites that path and breaks worker start.
    exclude: ["mupdf"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  define: {
    __OPAL_CROSS_ORIGIN_ISOLATED__: JSON.stringify(crossOriginIsolated),
    __MUPDF_VERSION__: JSON.stringify(mupdfVersion),
  },
});
