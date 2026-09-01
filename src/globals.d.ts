/// <reference types="vite/client" />

/** Injected by vite.config.ts `define`. */
declare const __OPAL_CROSS_ORIGIN_ISOLATED__: boolean;
declare const __MUPDF_VERSION__: string;

/** Aliased in vite.config.ts to mupdf's WASM binary, which its exports map hides. */
declare module "mupdf-wasm-binary?url" {
  const url: string;
  export default url;
}
