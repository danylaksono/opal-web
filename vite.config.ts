import { createReadStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { type Connect, defineConfig, type Plugin } from "vite";
// @siglum/engine pulls in blake3-wasm, which uses the ESM-WASM integration
// proposal that Vite does not implement natively.
import wasm from "vite-plugin-wasm";
import { ctanProxyMiddleware } from "./scripts/ctan-proxy";

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

/**
 * Whether to build the browser test surfaces alongside the app.
 *
 * Off by default: `tests/browser/contract.html` exercises the storage layer and
 * has no business in a production bundle. Playwright sets it, because the e2e
 * suite runs against the built output rather than the dev server.
 */
const testPages = process.env.OPAL_TEST_PAGES === "1";

const isolationHeaders = crossOriginIsolated
  ? {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    }
  : {};

/**
 * Serve Siglum's pre-compressed bundles as opaque bytes.
 *
 * The `.data.gz` files are payloads that the engine gunzips itself, not files
 * the transport should compress. Vite's static middleware sees the extension
 * and sets `Content-Encoding: gzip`, so the browser transparently decompresses
 * them; the engine then receives plain bytes, tries to gunzip them again, and
 * fails with a bare "Failed to fetch". Siglum special-cases `Content-Encoding:
 * br` but not gzip, so the header has to be absent.
 *
 * netlify.toml carries the matching rule. Any host serving these needs it.
 */
function serveEngineAssets(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split("?")[0] ?? "";
    if (!url.startsWith("/engines/") || !url.endsWith(".data.gz")) {
      next();
      return;
    }
    const file = fileURLToPath(new URL(`./public${url}`, import.meta.url));
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Opal-Engine-Asset", "raw");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(file)
      .on("error", () => next())
      .pipe(res);
  };

  return {
    name: "opal:serve-engine-assets",
    // "pre" so this runs ahead of Vite's static middleware, which is what sets
    // the Content-Encoding header we need absent.
    enforce: "pre",
    configureServer: (server) => () => {
      server.middlewares.use(middleware);
      server.middlewares.use(ctanProxyMiddleware(console.log));
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(middleware);
      server.middlewares.use(ctanProxyMiddleware(console.log));
    },
  };
}

export default defineConfig({
  plugins: [react(), wasm(), serveEngineAssets()],
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
      // blake3-wasm 2.1.5's browser build references a file it does not ship.
      // See src/platform/browser/compiler/blake3-unavailable.ts.
      {
        find: /^blake3-wasm\/browser\.js$/,
        replacement: fileURLToPath(
          new URL(
            "./src/platform/browser/compiler/blake3-unavailable.ts",
            import.meta.url,
          ),
        ),
      },
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
    // The contract page runs the storage suite against real OPFS, so it has to
    // be built rather than only served in dev — Playwright drives the
    // production build. It is opt-in so that test code never reaches a user.
    ...(testPages
      ? {
          rollupOptions: {
            input: {
              main: fileURLToPath(new URL("./index.html", import.meta.url)),
              contract: fileURLToPath(
                new URL("./tests/browser/contract.html", import.meta.url),
              ),
            },
          },
        }
      : {}),
  },
  define: {
    __OPAL_CROSS_ORIGIN_ISOLATED__: JSON.stringify(crossOriginIsolated),
    __MUPDF_VERSION__: JSON.stringify(mupdfVersion),
  },
});
