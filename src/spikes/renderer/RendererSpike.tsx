import { useCallback, useEffect, useRef, useState } from "react";
import type { PageLink, TextLine } from "@/core/pdf/types";
import { MupdfRenderer } from "@/platform/browser/pdf/mupdf-renderer";

/**
 * ADR-004 measurement surface.
 *
 * Loads a PDF through the `PdfRenderer` port and reports what the exit criteria
 * in ADR-004 actually ask about: whether the worker boots in a plain browser at
 * all, how long a page takes to rasterise, and — the deciding question for the
 * review subsystem — whether extracted text carries usable per-line geometry.
 *
 * Feed it the reference PDFs under `tests/fixtures/compiler-corpus`.
 */

interface PageReport {
  pageIndex: number;
  width: number;
  height: number;
  renderMs: number;
  widthPx: number;
  heightPx: number;
  lineCount: number;
  linkCount: number;
  sampleLines: TextLine[];
  links: PageLink[];
}

interface SpikeState {
  status: "idle" | "loading" | "done" | "error";
  rendererName?: string;
  rendererVersion?: string;
  licence?: string;
  fileName?: string;
  pageCount?: number;
  openMs?: number;
  pages: PageReport[];
  error?: string;
}

const MAX_PAGES_PROFILED = 3;

export function RendererSpike() {
  const [state, setState] = useState<SpikeState>({ status: "idle", pages: [] });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MupdfRenderer | null>(null);

  useEffect(() => {
    const renderer = new MupdfRenderer();
    rendererRef.current = renderer;
    return () => {
      void renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  const run = useCallback(async (file: File) => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    setState({ status: "loading", pages: [], fileName: file.name });

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());

      const openedAt = performance.now();
      const doc = await renderer.openDocument(bytes);
      const openMs = performance.now() - openedAt;

      const pages: PageReport[] = [];
      const profileCount = Math.min(doc.pageCount, MAX_PAGES_PROFILED);

      for (let pageIndex = 0; pageIndex < profileCount; pageIndex++) {
        const geometry = await doc.getPageGeometry(pageIndex);
        const rendered = await doc.renderPage({
          pageIndex,
          scale: 1,
          devicePixelRatio: window.devicePixelRatio,
        });
        const text = await doc.getPageText(pageIndex);
        const links = await doc.getPageLinks(pageIndex);

        if (pageIndex === 0 && canvasRef.current) {
          const canvas = canvasRef.current;
          canvas.width = rendered.widthPx;
          canvas.height = rendered.heightPx;
          canvas.getContext("2d")?.drawImage(rendered.bitmap, 0, 0);
        }
        // The bitmap is owned by the caller once transferred; the canvas has
        // its own copy by now, so holding it any longer just costs memory.
        rendered.bitmap.close();

        pages.push({
          pageIndex,
          width: geometry.width,
          height: geometry.height,
          renderMs: rendered.renderMs,
          widthPx: rendered.widthPx,
          heightPx: rendered.heightPx,
          lineCount: text.lines.length,
          linkCount: links.length,
          sampleLines: text.lines.slice(0, 3),
          links: links.slice(0, 3),
        });
      }

      await doc.close();

      setState({
        status: "done",
        fileName: file.name,
        rendererName: renderer.identity.name,
        rendererVersion: renderer.identity.version,
        licence: renderer.identity.licence,
        pageCount: doc.pageCount,
        openMs,
        pages,
      });
    } catch (error) {
      setState({
        status: "error",
        fileName: file.name,
        pages: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  return (
    <section>
      <h2>ADR-004: renderer spike</h2>
      <p className="lede">
        Open a PDF to exercise the <code>PdfRenderer</code> port end to end. The
        reference outputs under <code>tests/fixtures/compiler-corpus</code> are
        the intended input.
      </p>

      <input
        type="file"
        accept="application/pdf"
        data-testid="pdf-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void run(file);
        }}
      />

      <div data-testid="spike-status" data-status={state.status}>
        {state.status === "loading" && <p>Rendering {state.fileName}…</p>}
        {state.status === "error" && (
          <div className="banner bad">
            <strong>Failed:</strong> {state.error}
          </div>
        )}
        {state.status === "done" && (
          <>
            <table>
              <tbody>
                <tr>
                  <td>Renderer</td>
                  <td className="note" data-testid="renderer-identity">
                    {state.rendererName} {state.rendererVersion} —{" "}
                    {state.licence}
                  </td>
                </tr>
                <tr>
                  <td>Document</td>
                  <td className="note">
                    <code>{state.fileName}</code>, {state.pageCount} pages,
                    opened in {state.openMs?.toFixed(1)} ms
                  </td>
                </tr>
              </tbody>
            </table>

            <table>
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Points</th>
                  <th>Pixels</th>
                  <th>Render</th>
                  <th>Text lines</th>
                  <th>Links</th>
                </tr>
              </thead>
              <tbody>
                {state.pages.map((page) => (
                  <tr key={page.pageIndex} data-testid="page-row">
                    <td>{page.pageIndex + 1}</td>
                    <td className="note">
                      {page.width.toFixed(0)} × {page.height.toFixed(0)}
                    </td>
                    <td className="note">
                      {page.widthPx} × {page.heightPx}
                    </td>
                    <td className="note">{page.renderMs.toFixed(1)} ms</td>
                    <td className="note" data-testid="line-count">
                      {page.lineCount}
                    </td>
                    <td className="note">{page.linkCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>First lines of page 1, with geometry</h3>
            <table>
              <thead>
                <tr>
                  <th>Text</th>
                  <th>bbox</th>
                  <th>baselineY</th>
                  <th>Font</th>
                </tr>
              </thead>
              <tbody>
                {state.pages[0]?.sampleLines.map((line) => (
                  <tr key={`${line.baselineY}-${line.text}`}>
                    <td className="note">{line.text.slice(0, 60)}</td>
                    <td className="note">
                      {line.bbox.x.toFixed(1)}, {line.bbox.y.toFixed(1)},{" "}
                      {line.bbox.width.toFixed(1)} ×{" "}
                      {line.bbox.height.toFixed(1)}
                    </td>
                    <td className="note">{line.baselineY.toFixed(2)}</td>
                    <td className="note">
                      {line.font.family || line.font.name} {line.font.size}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <canvas
        ref={canvasRef}
        data-testid="page-canvas"
        style={{
          maxWidth: "100%",
          height: "auto",
          border: "1px solid var(--line)",
          marginTop: "1rem",
        }}
      />
    </section>
  );
}
