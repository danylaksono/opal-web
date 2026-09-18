import { createReadStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Connect, defineConfig, type Plugin } from "vite";
// @siglum/engine pulls in blake3-wasm, which uses the ESM-WASM integration
// proposal that Vite does not implement natively.
import wasm from "vite-plugin-wasm";
import { brotliSibling } from "./scripts/build-brotli-assets";
import { ctanProxyMiddleware } from "./scripts/ctan-proxy";
import { texliveEndpointMiddleware } from "./scripts/texlive-endpoint";

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
 * What the two caches are keyed by (`src/platform/browser/offline/`).
 *
 * The build id changes every time, so a deploy replaces the application's
 * cache; the engine's version changes only when the engine does, so 22.7 MB of
 * WASM and TeX files survives a deploy that moved a button.
 */
const buildId = process.env.OPAL_BUILD_ID ?? String(Date.now());
const engineVersion: string = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./node_modules/texlyre-busytex/package.json", import.meta.url),
    ),
    "utf8",
  ),
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
/**
 * Serve the engine assets uncompressed even where a `.br` exists.
 *
 * Every browser sends `Accept-Encoding: br`, so without a switch the
 * before-and-after of pre-compressing them is not measurable on one build.
 */
const noBrotli = process.env.OPAL_NO_BROTLI === "1";

const CONTENT_TYPES: Record<string, string> = {
  // `application/wasm` is not cosmetic: it is what lets the browser compile
  // the module while it streams. ADR-003 records a deployment that lost both
  // streaming and compression by getting this wrong, invisibly.
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".data": "application/octet-stream",
};

function serveEngineAssets(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split("?")[0] ?? "";
    // `/assets/` is Vite's own build output — the renderer's WASM lives there,
    // and it is the largest single response of a first load once the engine is
    // compressed.
    const engineAsset = url.startsWith("/engines/");
    if (!engineAsset && !url.startsWith("/assets/")) {
      next();
      return;
    }

    if (url.endsWith(".data.gz")) {
      const file = fileURLToPath(new URL(`./public${url}`, import.meta.url));
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Opal-Engine-Asset", "raw");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      createReadStream(file)
        .on("error", () => next())
        .pipe(res);
      return;
    }

    /**
     * Serve a pre-compressed sibling when one exists.
     *
     * Only for whole-file reads, and only for files the engine consumes as
     * bytes — `pnpm spike:brotli` decides which, and deliberately excludes
     * `texlive-extra.data`, which the endpoint reads by byte offset and which
     * a transport encoding would make unseekable.
     *
     * A range request is refused this path for the same reason: `Range` and
     * `Content-Encoding` together describe a range of the *encoded* stream,
     * which is not what any caller here means.
     */
    const extension = url.slice(url.lastIndexOf("."));
    const type = CONTENT_TYPES[extension];
    const accepts = String(req.headers["accept-encoding"] ?? "").includes("br");
    if (!type || !accepts || req.headers.range || noBrotli) {
      next();
      return;
    }

    const file = fileURLToPath(
      new URL(`./${engineAsset ? "public" : "dist"}${url}`, import.meta.url),
    );
    const compressed = brotliSibling(file);
    if (!compressed) {
      next();
      return;
    }

    res.setHeader("Content-Type", type);
    res.setHeader("Content-Encoding", "br");
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("X-Opal-Engine-Asset", "brotli");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(compressed)
      .on("error", () => next())
      .pipe(res);
  };

  return {
    name: "opal:serve-engine-assets",
    // "pre" so this runs ahead of Vite's static middleware, which is what sets
    // the Content-Encoding header we need absent.
    enforce: "pre",
    /**
     * Two groups, because they need opposite insertion points.
     *
     * `/texlive/` and `/ctan/` are API routes, and in dev Vite's HTML fallback
     * answers anything still unhandled — so installed *after* Vite's own
     * middlewares, as a returned hook installs them, the engine asked for
     * `article.cls` and was handed `index.html` with a 200. TeX then read the
     * page as a class file and stopped at "Missing \begin{document}", naming a
     * file that looked fine. They are registered directly, which puts them
     * ahead of Vite's internals, and nothing of Vite's should ever answer them.
     *
     * The asset middleware is the other way round: it exists to serve a
     * pre-compressed sibling *instead of* Vite's static handler, but only where
     * that is what the engine wants. It stays in the returned hook, where it
     * has always been — `busytex.wasm` delivery is the one axis this repository
     * has already seen diverge between local and deployed twice, and no test
     * watches it in dev.
     */
    configureServer: (server) => {
      server.middlewares.use(ctanProxyMiddleware(console.log));
      server.middlewares.use(texliveEndpointMiddleware(console.log));
      return () => {
        server.middlewares.use(middleware);
      };
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(middleware);
      server.middlewares.use(ctanProxyMiddleware(console.log));
      server.middlewares.use(texliveEndpointMiddleware(console.log));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), wasm(), serveEngineAssets()],
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
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // The service worker, at a fixed path: its scope is the directory it
        // is served from, so a hashed name under /assets/ could only ever
        // control /assets/.
        sw: fileURLToPath(
          new URL("./src/platform/browser/offline/sw.ts", import.meta.url),
        ),
        ...(testPages
          ? {
              contract: fileURLToPath(
                new URL("./tests/browser/contract.html", import.meta.url),
              ),
            }
          : {}),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
      },
    },
    // The contract page runs the storage suite against real OPFS, so it has to
    // be built rather than only served in dev — Playwright drives the
    // production build. It is opt-in so that test code never reaches a user.
  },
  define: {
    __OPAL_CROSS_ORIGIN_ISOLATED__: JSON.stringify(crossOriginIsolated),
    __MUPDF_VERSION__: JSON.stringify(mupdfVersion),
    __OPAL_BUILD_ID__: JSON.stringify(buildId),
    __OPAL_ENGINE_VERSION__: JSON.stringify(engineVersion),
  },
});
