/**
 * Stand-in for `blake3-wasm/browser.js`, aliased in vite.config.ts.
 *
 * blake3-wasm 2.1.5's browser build is broken upstream: `blake3_js.js` does
 * `export * from "./blake3_js_bg.js"`, and the package does not ship that file,
 * so any bundler that tries to resolve it fails the build.
 *
 * @siglum/engine imports it dynamically inside a `.catch()` and falls back to a
 * DJB2 hash when it is unavailable, so refusing to load here is a path the
 * engine already handles. Aliasing to this module — rather than marking the
 * dependency external — keeps the failure local: no 404 on every page load,
 * and no request for a file we know is missing.
 *
 * The cost is real and belongs in ADR-003: DJB2 keys the document and preamble
 * caches, and it collides far more readily than BLAKE3. For a spike measuring
 * compile behaviour that is acceptable. Before any cache-correctness claim, this
 * needs either a fixed upstream or our own hash.
 */

const REASON =
  "blake3-wasm 2.1.5 ships a browser build that references a file it does not include; Siglum's DJB2 fallback is in use.";

export function hash(): never {
  throw new Error(REASON);
}

throw new Error(REASON);
