/// <reference lib="webworker" />

import wasmUrl from "mupdf-wasm-binary?url";
import type { Link, PDFDocument } from "mupdf";
import type { PageGeometry, PageLink, PageText } from "@/core/pdf/types";
import { normalizeStructuredText } from "@/platform/browser/pdf/structured-text";
import {
  PDF_PROTOCOL_VERSION,
  type PdfWorkerRequest,
  type PdfWorkerResponse,
} from "./protocol";

/**
 * MuPDF renderer worker.
 *
 * Desktop points MuPDF at its WASM through a dev-only `/@fs/` URL, which works
 * only because Vite is serving a local file next to a Tauri webview. A static
 * deploy has no such path, so the binary is imported as a Vite asset instead:
 * one URL that is correct in dev and content-hashed in production, which is
 * also what lets netlify.toml cache it immutably.
 *
 * The config object must exist before `mupdf` is imported, because that module
 * boots its WASM runtime during import.
 */
type MupdfWasmModuleConfig = { locateFile?: (path: string) => string };

const wasmHost = globalThis as typeof globalThis & {
  $libmupdf_wasm_Module?: MupdfWasmModuleConfig;
};

wasmHost.$libmupdf_wasm_Module ??= {};
wasmHost.$libmupdf_wasm_Module.locateFile = (path: string) =>
  path.endsWith("mupdf-wasm.wasm") ? wasmUrl : path;

/**
 * The message handler is attached before the top-level await, not after.
 *
 * A message posted while the worker module is still evaluating is dispatched
 * with no listener attached and is simply lost — which presents as a worker
 * that boots, fetches its WASM successfully, and then never answers anything.
 * Queueing here removes the race without needing a ready handshake the caller
 * would have to remember to wait for.
 */
const pendingMessages: PdfWorkerRequest[] = [];
let booted = false;

self.onmessage = (event: MessageEvent<PdfWorkerRequest>) => {
  if (booted) {
    void dispatch(event.data);
  } else {
    pendingMessages.push(event.data);
  }
};

const mupdf = await import("mupdf");

const documents = new Map<number, PDFDocument>();
let nextDocId = 1;

function requireDocument(docId: number): PDFDocument {
  const doc = documents.get(docId);
  if (!doc) throw new Error(`No open document ${docId}`);
  return doc;
}

/** MuPDF rects are [x0, y0, x1, y1], y increasing downwards — same as the port. */
function toRect(bounds: readonly number[]) {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = bounds;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function pageGeometry(docId: number, pageIndex: number): PageGeometry {
  const page = requireDocument(docId).loadPage(pageIndex);
  try {
    const rect = toRect(page.getBounds());
    return {
      pageIndex,
      width: rect.width,
      height: rect.height,
      // MuPDF bakes page rotation into the bounds it reports, so what the
      // viewport receives is already upright.
      rotation: 0,
    };
  } finally {
    page.destroy();
  }
}

function renderPage(docId: number, pageIndex: number, pixelScale: number) {
  const started = performance.now();
  const page = requireDocument(docId).loadPage(pageIndex);
  try {
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(pixelScale, pixelScale),
      mupdf.ColorSpace.DeviceRGB,
      true,
    );
    try {
      const widthPx = pixmap.getWidth();
      const heightPx = pixmap.getHeight();
      // getPixels() is a view onto the WASM heap. It has to be copied before
      // the pixmap is destroyed, or the ImageData reads freed memory.
      const pixels = new Uint8ClampedArray(pixmap.getPixels());
      return {
        image: new ImageData(pixels, widthPx, heightPx),
        widthPx,
        heightPx,
        renderMs: performance.now() - started,
      };
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
}

function pageText(docId: number, pageIndex: number): PageText {
  const page = requireDocument(docId).loadPage(pageIndex);
  try {
    const structured = page.toStructuredText("preserve-whitespace");
    try {
      return {
        pageIndex,
        lines: normalizeStructuredText(JSON.parse(structured.asJSON())),
      };
    } finally {
      structured.destroy();
    }
  } finally {
    page.destroy();
  }
}

function linkTarget(doc: PDFDocument, link: Link): PageLink["target"] {
  if (link.isExternal()) {
    return { kind: "external", url: link.getURI() };
  }
  const destination = doc.resolveLinkDestination(link);
  return {
    kind: "internal",
    pageIndex: destination.page,
    ...(typeof destination.y === "number" ? { top: destination.y } : {}),
  };
}

function pageLinks(docId: number, pageIndex: number): PageLink[] {
  const doc = requireDocument(docId);
  const page = doc.loadPage(pageIndex);
  try {
    return page.getLinks().map((link) => ({
      bbox: toRect(link.getBounds()),
      target: linkTarget(doc, link),
    }));
  } finally {
    page.destroy();
  }
}

async function handle(
  request: PdfWorkerRequest,
): Promise<{ response: PdfWorkerResponse; transfer: Transferable[] }> {
  const { id } = request;
  switch (request.type) {
    case "init":
      return {
        response: {
          id,
          ok: true,
          type: "init",
          protocolVersion: PDF_PROTOCOL_VERSION,
          identity: {
            id: "mupdf",
            name: "MuPDF.js",
            version: __MUPDF_VERSION__,
            licence: "AGPL-3.0-or-later",
          },
        },
        transfer: [],
      };

    case "openDocument": {
      const docId = nextDocId++;
      const doc = mupdf.Document.openDocument(
        request.bytes,
        "application/pdf",
      ) as PDFDocument;
      documents.set(docId, doc);
      return {
        response: {
          id,
          ok: true,
          type: "openDocument",
          docId,
          pageCount: doc.countPages(),
        },
        transfer: [],
      };
    }

    case "closeDocument": {
      const doc = documents.get(request.docId);
      if (doc) {
        documents.delete(request.docId);
        // Freed explicitly rather than left to the FinalizationRegistry: the JS
        // GC sees only a small wrapper while the WASM heap holds the whole
        // parsed document, so nothing creates pressure to collect it.
        doc.destroy();
        // Decoded images and glyphs live in a shared store with no eviction
        // signal of its own; an image-heavy document can strand hundreds of
        // megabytes there.
        mupdf.shrinkStore(50);
      }
      return {
        response: { id, ok: true, type: "closeDocument" },
        transfer: [],
      };
    }

    case "pageCount":
      return {
        response: {
          id,
          ok: true,
          type: "pageCount",
          pageCount: requireDocument(request.docId).countPages(),
        },
        transfer: [],
      };

    case "pageGeometry":
      return {
        response: {
          id,
          ok: true,
          type: "pageGeometry",
          geometry: pageGeometry(request.docId, request.pageIndex),
        },
        transfer: [],
      };

    case "renderPage": {
      const rendered = renderPage(
        request.docId,
        request.pageIndex,
        request.pixelScale,
      );
      const bitmap = await createImageBitmap(rendered.image);
      return {
        response: {
          id,
          ok: true,
          type: "renderPage",
          pageIndex: request.pageIndex,
          bitmap,
          widthPx: rendered.widthPx,
          heightPx: rendered.heightPx,
          renderMs: rendered.renderMs,
        },
        transfer: [bitmap],
      };
    }

    case "pageText":
      return {
        response: {
          id,
          ok: true,
          type: "pageText",
          text: pageText(request.docId, request.pageIndex),
        },
        transfer: [],
      };

    case "pageLinks":
      return {
        response: {
          id,
          ok: true,
          type: "pageLinks",
          links: pageLinks(request.docId, request.pageIndex),
        },
        transfer: [],
      };
  }
}

async function dispatch(request: PdfWorkerRequest): Promise<void> {
  try {
    const { response, transfer } = await handle(request);
    self.postMessage(response, transfer);
  } catch (error) {
    const failure: PdfWorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    };
    self.postMessage(failure);
  }
}

booted = true;
for (const request of pendingMessages.splice(0)) {
  void dispatch(request);
}
