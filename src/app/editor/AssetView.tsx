import { useEffect, useRef, useState } from "react";
import type { ProjectPath } from "@/core/project/ids";
import { MupdfRenderer } from "@/platform/browser/pdf/mupdf-renderer";

/**
 * What a project's non-text files look like when you open one
 * (PLAN.md 14, Phase 3: "image/PDF asset views").
 *
 * Before this, every file in the list opened in the text editor, including the
 * figures a ZIP import brings with it. That is not merely ugly: the bytes were
 * decoded as UTF-8, which replaces everything invalid with U+FFFD, and the
 * editor's first keystroke would have autosaved that back over the image. The
 * view is the visible half of the fix; the other half is the panel not handing
 * binary to a text editor at all.
 *
 * A PDF is drawn through `PdfRenderer` rather than handed to the browser's own
 * viewer. The port is already here, it works offline, and ADR-001's boundary is
 * easier to keep when nothing reaches for a plugin — a browser PDF viewer is a
 * different renderer with different fonts and its own network behaviour.
 */

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const SVG = /\.svg$/i;
const PDF = /\.pdf$/i;

function kilobytes(bytes: number): string {
  return bytes < 1024
    ? `${bytes} bytes`
    : `${(bytes / 1024).toFixed(1)} KB (${bytes} bytes)`;
}

interface AssetViewProps {
  path: ProjectPath;
  bytes: Uint8Array;
}

export function AssetView({ path, bytes }: AssetViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [pdf, setPdf] = useState<{ pages: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isImage = IMAGE.test(path) || SVG.test(path);
  const isPdf = PDF.test(path);

  useEffect(() => {
    if (!isImage) return;
    // `image/svg+xml` explicitly: a blob with the wrong type renders as
    // nothing, and SVG is the one image format here that is also text.
    const blob = new Blob([bytes as BlobPart], {
      type: SVG.test(path) ? "image/svg+xml" : "image",
    });
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [bytes, path, isImage]);

  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    const renderer = new MupdfRenderer();

    void (async () => {
      try {
        const document = await renderer.openDocument(bytes);
        const rendered = await document.renderPage({
          pageIndex: 0,
          scale: 1,
          devicePixelRatio: window.devicePixelRatio,
        });
        // The component can unmount during an await, and drawing then would
        // touch a canvas React has already thrown away.
        if (!cancelled && canvas.current) {
          canvas.current.width = rendered.widthPx;
          canvas.current.height = rendered.heightPx;
          canvas.current.getContext("2d")?.drawImage(rendered.bitmap, 0, 0);
          setPdf({ pages: document.pageCount });
        }
        rendered.bitmap.close();
        await document.close();
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Cannot read this");
        }
      } finally {
        await renderer.dispose();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bytes, isPdf]);

  return (
    <div
      data-testid="asset-view"
      data-kind={isImage ? "image" : isPdf ? "pdf" : "other"}
    >
      <p className="note">
        {path} — {kilobytes(bytes.byteLength)}
        {pdf ? `, ${pdf.pages} ${pdf.pages === 1 ? "page" : "pages"}` : ""}
      </p>

      {error && (
        <p className="unavailable" role="alert">
          {error}
        </p>
      )}

      {isImage && url && (
        // Named by its path: a figure in a project has no other description
        // available, and "image" would be worse than the filename.
        <img
          src={url}
          alt={path}
          data-testid="asset-image"
          style={{ maxWidth: "100%", border: "1px solid var(--line, #ccc)" }}
        />
      )}

      {isPdf && (
        <canvas
          ref={canvas}
          role="img"
          aria-label={`First page of ${path}`}
          data-testid="asset-canvas"
          style={{ maxWidth: "100%", border: "1px solid var(--line, #ccc)" }}
        />
      )}

      {!isImage && !isPdf && (
        <p className="note" data-testid="asset-unviewable">
          No preview for this kind of file. It is stored, and it travels with
          the project into a compile and out into a ZIP.
        </p>
      )}
    </div>
  );
}
