import type {
  PageGeometry,
  PageLink,
  PageText,
  RendererIdentity,
} from "@/core/pdf/types";

/**
 * Versioned PDF worker protocol (PLAN.md 15, "define versioned worker
 * protocols").
 *
 * The version is checked on handshake. A worker served from a stale service
 * worker cache talking to a fresh main thread is a real failure mode for a PWA,
 * and it fails far more usefully here than as an undefined property later.
 */
export const PDF_PROTOCOL_VERSION = 1;

export type PdfWorkerRequest =
  | { id: number; type: "init" }
  | { id: number; type: "openDocument"; bytes: ArrayBuffer }
  | { id: number; type: "closeDocument"; docId: number }
  | { id: number; type: "pageCount"; docId: number }
  | { id: number; type: "pageGeometry"; docId: number; pageIndex: number }
  | {
      id: number;
      type: "renderPage";
      docId: number;
      pageIndex: number;
      /** Total device-pixel scale: CSS scale multiplied by devicePixelRatio. */
      pixelScale: number;
    }
  | { id: number; type: "pageText"; docId: number; pageIndex: number }
  | { id: number; type: "pageLinks"; docId: number; pageIndex: number };

export type PdfWorkerResponse =
  | {
      id: number;
      ok: true;
      type: "init";
      protocolVersion: number;
      identity: RendererIdentity;
    }
  | {
      id: number;
      ok: true;
      type: "openDocument";
      docId: number;
      pageCount: number;
    }
  | { id: number; ok: true; type: "closeDocument" }
  | { id: number; ok: true; type: "pageCount"; pageCount: number }
  | { id: number; ok: true; type: "pageGeometry"; geometry: PageGeometry }
  | {
      id: number;
      ok: true;
      type: "renderPage";
      pageIndex: number;
      bitmap: ImageBitmap;
      widthPx: number;
      heightPx: number;
      renderMs: number;
    }
  | { id: number; ok: true; type: "pageText"; text: PageText }
  | { id: number; ok: true; type: "pageLinks"; links: PageLink[] }
  | { id: number; ok: false; error: string; stack?: string };

/**
 * A request without its correlation id.
 *
 * Distributive on purpose: a plain `Omit<PdfWorkerRequest, "id">` collapses the
 * union to the keys every member shares, which is just `type`, and every
 * payload field then fails to typecheck at the call site.
 */
export type PdfWorkerCall = PdfWorkerRequest extends infer T
  ? T extends PdfWorkerRequest
    ? Omit<T, "id">
    : never
  : never;
