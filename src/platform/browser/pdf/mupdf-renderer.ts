import type {
  PageGeometry,
  PageLink,
  PageText,
  PdfDocumentHandle,
  PdfRenderer,
  RenderedPage,
  RendererIdentity,
  RenderPageRequest,
} from "@/core/pdf/types";
import {
  PDF_PROTOCOL_VERSION,
  type PdfWorkerCall,
  type PdfWorkerRequest,
  type PdfWorkerResponse,
} from "@/workers/pdf/protocol";

/**
 * Main-thread client for the MuPDF worker (ADR-004).
 *
 * Implements `PdfRenderer` and nothing more. Callers get plain geometry and
 * transferable bitmaps; no MuPDF object exists outside the worker, which is
 * what keeps the renderer replaceable if ADR-004 is ever revisited.
 */

type Pending = {
  resolve: (response: PdfWorkerResponse) => void;
  reject: (error: Error) => void;
};

class WorkerCrashedError extends Error {
  constructor(cause: string) {
    super(`PDF worker terminated: ${cause}`);
    this.name = "WorkerCrashedError";
  }
}

export class MupdfRenderer implements PdfRenderer {
  #worker: Worker | null = null;
  #pending = new Map<number, Pending>();
  #nextRequestId = 1;
  #identity: RendererIdentity = {
    id: "mupdf",
    name: "MuPDF.js",
    version: "unknown",
    licence: "AGPL-3.0-or-later",
  };
  #initPromise: Promise<void> | null = null;

  get identity(): RendererIdentity {
    return this.#identity;
  }

  init(): Promise<void> {
    this.#initPromise ??= this.#start();
    return this.#initPromise;
  }

  async #start(): Promise<void> {
    const worker = new Worker(
      new URL("../../../workers/pdf/mupdf.worker.ts", import.meta.url),
      { type: "module", name: "opal-pdf" },
    );

    worker.onmessage = (event: MessageEvent<PdfWorkerResponse>) => {
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      pending.resolve(event.data);
    };

    // A worker that dies takes every in-flight request with it. Rejecting them
    // all is what stops the viewer sitting on a promise that will never settle.
    worker.onerror = (event) => this.#failAll(event.message || "worker error");
    worker.onmessageerror = () => this.#failAll("message could not be cloned");

    this.#worker = worker;

    const response = await this.#send({ type: "init" });
    if (!response.ok || response.type !== "init") {
      throw new Error("PDF worker failed to initialise");
    }
    if (response.protocolVersion !== PDF_PROTOCOL_VERSION) {
      // Realistic once a service worker is caching the bundle: a stale worker
      // against a fresh main thread fails far more usefully here than as an
      // undefined property several calls later.
      throw new Error(
        `PDF worker protocol ${response.protocolVersion} does not match ${PDF_PROTOCOL_VERSION}. The app was likely updated; reload to continue.`,
      );
    }
    this.#identity = response.identity;
  }

  #failAll(cause: string): void {
    const error = new WorkerCrashedError(cause);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #send(
    request: PdfWorkerCall,
    transfer: Transferable[] = [],
  ): Promise<PdfWorkerResponse> {
    const worker = this.#worker;
    if (!worker) throw new Error("PDF renderer is not initialised");

    const id = this.#nextRequestId++;
    const message = { ...request, id } as PdfWorkerRequest;

    return new Promise<PdfWorkerResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      worker.postMessage(message, transfer);
    });
  }

  async #call<T extends PdfWorkerResponse & { ok: true }>(
    request: PdfWorkerCall,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const response = await this.#send(request, transfer);
    if (!response.ok) {
      const error = new Error(response.error);
      if (response.stack) error.stack = response.stack;
      throw error;
    }
    return response as T;
  }

  async openDocument(bytes: Uint8Array): Promise<PdfDocumentHandle> {
    await this.init();

    // Transferred, not copied: PDF bytes are multi-megabyte and the caller is
    // documented as not reusing the buffer.
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    const opened = await this.#call<
      Extract<PdfWorkerResponse, { type: "openDocument"; ok: true }>
    >({ type: "openDocument", bytes: buffer }, [buffer]);

    return new MupdfDocumentHandle(this, opened.docId, opened.pageCount);
  }

  /** @internal Used by the document handle; not part of `PdfRenderer`. */
  async request<T extends PdfWorkerResponse & { ok: true }>(
    message: PdfWorkerCall,
  ): Promise<T> {
    return this.#call<T>(message);
  }

  async restart(): Promise<void> {
    await this.dispose();
    this.#initPromise = null;
    await this.init();
  }

  async dispose(): Promise<void> {
    this.#worker?.terminate();
    this.#worker = null;
    this.#failAll("renderer disposed");
    this.#initPromise = null;
  }
}

class MupdfDocumentHandle implements PdfDocumentHandle {
  #renderer: MupdfRenderer;
  #docId: number;
  #closed = false;
  readonly pageCount: number;

  constructor(renderer: MupdfRenderer, docId: number, pageCount: number) {
    this.#renderer = renderer;
    this.#docId = docId;
    this.pageCount = pageCount;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("PDF document is closed");
  }

  async getPageGeometry(pageIndex: number): Promise<PageGeometry> {
    this.#assertOpen();
    const response = await this.#renderer.request<
      Extract<PdfWorkerResponse, { type: "pageGeometry"; ok: true }>
    >({ type: "pageGeometry", docId: this.#docId, pageIndex });
    return response.geometry;
  }

  async renderPage(request: RenderPageRequest): Promise<RenderedPage> {
    this.#assertOpen();
    request.signal?.throwIfAborted();

    const response = await this.#renderer.request<
      Extract<PdfWorkerResponse, { type: "renderPage"; ok: true }>
    >({
      type: "renderPage",
      docId: this.#docId,
      pageIndex: request.pageIndex,
      pixelScale: request.scale * request.devicePixelRatio,
    });

    // MuPDF rasterises synchronously inside the worker, so a render already in
    // flight cannot be interrupted — only abandoned. Closing the bitmap here
    // keeps an abandoned page from leaking; genuinely stuck work needs
    // `restart()`, which is why the port exposes it.
    if (request.signal?.aborted) {
      response.bitmap.close();
      request.signal.throwIfAborted();
    }

    return {
      pageIndex: response.pageIndex,
      bitmap: response.bitmap,
      widthPx: response.widthPx,
      heightPx: response.heightPx,
      renderMs: response.renderMs,
    };
  }

  async getPageText(pageIndex: number): Promise<PageText> {
    this.#assertOpen();
    const response = await this.#renderer.request<
      Extract<PdfWorkerResponse, { type: "pageText"; ok: true }>
    >({ type: "pageText", docId: this.#docId, pageIndex });
    return response.text;
  }

  async getPageLinks(pageIndex: number): Promise<readonly PageLink[]> {
    this.#assertOpen();
    const response = await this.#renderer.request<
      Extract<PdfWorkerResponse, { type: "pageLinks"; ok: true }>
    >({ type: "pageLinks", docId: this.#docId, pageIndex });
    return response.links;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#renderer.request({
      type: "closeDocument",
      docId: this.#docId,
    });
  }
}
