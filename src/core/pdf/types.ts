/**
 * Renderer-neutral PDF model (PLAN.md 8).
 *
 * Nothing here may expose a MuPDF or PDF.js object. The licence decision
 * (ADR-004) is still open, so the viewport, overlays, selection and review
 * anchoring must be written against these plain structures only — that is what
 * lets the renderer be swapped after the spike without touching the UI.
 *
 * Coordinates are in PDF points with the origin at the page's top-left and y
 * increasing downwards, matching the desktop structured-text convention so the
 * ported review anchoring keeps its geometry.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextFont {
  name: string;
  family: string;
  size: number;
  weight: "normal" | "bold" | string;
  style: "normal" | "italic" | string;
}

/**
 * One line of extracted text.
 *
 * `baselineY` is the glyph baseline, not the bottom of `bbox`. Desktop learned
 * this the hard way: falling back to the box bottom drops every line by its
 * descender, which misaligns selection and review highlights.
 */
export interface TextLine {
  bbox: Rect;
  baselineY: number;
  text: string;
  font: TextFont;
  /** 0 for horizontal writing mode, 1 for vertical. */
  wmode: 0 | 1;
}

export interface PageText {
  pageIndex: number;
  lines: readonly TextLine[];
}

export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "internal"; pageIndex: number; top?: number };

export interface PageLink {
  bbox: Rect;
  target: LinkTarget;
}

export interface PageGeometry {
  pageIndex: number;
  /** Page size in PDF points at scale 1. */
  width: number;
  height: number;
  /** Page rotation in degrees, already normalised to 0/90/180/270. */
  rotation: number;
}

export interface RenderPageRequest {
  pageIndex: number;
  /** CSS pixels per PDF point, before device pixel ratio. */
  scale: number;
  devicePixelRatio: number;
  signal?: AbortSignal;
}

export interface RenderedPage {
  pageIndex: number;
  /** Transferable bitmap, so page pixels never pass through the main thread. */
  bitmap: ImageBitmap;
  widthPx: number;
  heightPx: number;
  renderMs: number;
}

export interface RendererIdentity {
  /** "pdfjs" or "mupdf" during the spike. */
  id: string;
  name: string;
  version: string;
  licence: string;
}

export interface PdfDocumentHandle {
  readonly pageCount: number;
  getPageGeometry(pageIndex: number): Promise<PageGeometry>;
  renderPage(request: RenderPageRequest): Promise<RenderedPage>;
  getPageText(pageIndex: number): Promise<PageText>;
  getPageLinks(pageIndex: number): Promise<readonly PageLink[]>;
  close(): Promise<void>;
}

export interface PdfRenderer {
  readonly identity: RendererIdentity;
  init(): Promise<void>;
  /**
   * `bytes` is transferred to the worker, so the caller must not reuse the
   * buffer afterwards. Compiled PDF bytes are kept outside Zustand for the same
   * reason desktop does it: reactive copies of multi-megabyte buffers are what
   * pushed the webview into low-memory mode.
   */
  openDocument(bytes: Uint8Array): Promise<PdfDocumentHandle>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}
