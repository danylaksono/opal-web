import { useCallback, useEffect, useRef, useState } from "react";
import {
  CompileSession,
  type CompileState,
} from "@/app/workspace/compile-session";
import type { CompileDiagnostic } from "@/core/compiler/types";
import type { ProjectId, ProjectPath } from "@/core/project/ids";
import type { ProjectRepository } from "@/core/project/repository";
import {
  TEXLYRE_BOOT_TIER,
  TexlyreLatexCompiler,
} from "@/platform/browser/compiler/texlyre-compiler";
import { MupdfRenderer } from "@/platform/browser/pdf/mupdf-renderer";

/**
 * The edit-compile-preview loop (PLAN.md Phase 2).
 *
 * The first surface where the ports carry a product rather than a
 * measurement: files come from `ProjectRepository`, compiling goes through
 * `LatexCompiler`, and the result is drawn through `PdfRenderer`. Nothing here
 * knows which engine or which renderer, which is what lets ADR-003 stay open
 * while this exists.
 *
 * Compiling is on a button rather than on every keystroke. Warm compiles
 * measure 0.9–3.2 s, fast enough that a debounce would work for `blank` and
 * feel broken on `thesis-standard`, so the trigger stays explicit until there
 * is a reason it should not be — and `CompileSession` is written so that
 * changing it is a change to this file alone.
 */

interface WorkspaceProps {
  repository: ProjectRepository;
  projectId: ProjectId;
  mainFile: ProjectPath;
  /** Live editor content, so a compile uses what is on screen, not on disk. */
  content: string;
  onClose: () => void;
}

interface PreviewState {
  status: "idle" | "rendering" | "ready" | "error";
  pageCount?: number;
  pageIndex?: number;
  error?: string;
}

const ENCODER = new TextEncoder();

/** Enough to read at, without making a 16-page thesis a memory problem. */
const PREVIEW_SCALE = 1.25;

function severityClass(diagnostic: CompileDiagnostic): string {
  return diagnostic.severity === "error" ? "unavailable" : "optional-missing";
}

export function Workspace({
  repository,
  projectId,
  mainFile,
  content,
  onClose,
}: WorkspaceProps) {
  const [compile, setCompile] = useState<CompileState>({ status: "idle" });
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const sessionRef = useRef<CompileSession | null>(null);
  const rendererRef = useRef<MupdfRenderer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Kept so page navigation can redraw without recompiling. */
  const documentRef = useRef<Awaited<
    ReturnType<MupdfRenderer["openDocument"]>
  > | null>(null);

  useEffect(() => {
    const renderer = new MupdfRenderer();
    rendererRef.current = renderer;
    const session = new CompileSession({
      compiler: new TexlyreLatexCompiler({
        engine: "xelatex",
        tiers: [TEXLYRE_BOOT_TIER],
        remoteEndpoint: `${window.location.origin}/texlive`,
        verbose: true,
        onLog: (line) => console.log("[engine]", line),
      }),
      onState: setCompile,
    });
    sessionRef.current = session;

    return () => {
      void documentRef.current?.close();
      void session.dispose();
      void renderer.dispose();
      documentRef.current = null;
      sessionRef.current = null;
      rendererRef.current = null;
    };
  }, []);

  const drawPage = useCallback(async (pageIndex: number) => {
    const handle = documentRef.current;
    const canvas = canvasRef.current;
    if (!handle || !canvas) return;

    const rendered = await handle.renderPage({
      pageIndex,
      scale: PREVIEW_SCALE,
      devicePixelRatio: window.devicePixelRatio,
    });
    canvas.width = rendered.widthPx;
    canvas.height = rendered.heightPx;
    canvas.getContext("2d")?.drawImage(rendered.bitmap, 0, 0);
    // The bitmap is the caller's once transferred, and the canvas has its own
    // copy by now.
    rendered.bitmap.close();
    setPreview({
      status: "ready",
      pageCount: handle.pageCount,
      pageIndex,
    });
  }, []);

  const run = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;

    // Everything the project holds, not just the open file: a document that
    // \inputs a chapter or cites a .bib compiles only if those travel with it.
    const paths = await repository.listFiles(projectId);
    const files = await Promise.all(
      paths.map(async (path) => ({
        path,
        content:
          path === mainFile
            ? ENCODER.encode(content)
            : await repository.readFile(projectId, path),
      })),
    );

    const result = await session.compile(mainFile, files);
    // null means a newer compile overtook this one; its result is already on
    // its way and this one must not touch the preview.
    if (!result?.ok) return;

    setPreview({ status: "rendering" });
    try {
      const renderer = rendererRef.current;
      if (!renderer) return;
      await documentRef.current?.close();
      documentRef.current = await renderer.openDocument(
        new Uint8Array(result.pdf),
      );
      await drawPage(0);
    } catch (error) {
      setPreview({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [repository, projectId, mainFile, content, drawPage]);

  const result = compile.status === "done" ? compile.result : null;
  const busy = compile.status === "compiling";

  return (
    <section data-testid="workspace">
      <header
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
          marginBottom: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <strong>{mainFile}</strong>
        <button
          type="button"
          data-testid="compile-button"
          onClick={() => void run()}
          disabled={busy}
        >
          {busy ? "Compiling…" : "Compile"}
        </button>
        <button
          type="button"
          data-testid="cancel-button"
          onClick={() => sessionRef.current?.cancel()}
          disabled={!busy}
        >
          Cancel
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
        <span data-testid="workspace-status" data-status={compile.status}>
          {compile.status === "idle" && "Not compiled yet"}
          {busy && "Compiling…"}
          {result?.ok &&
            `Compiled in ${Math.round(result.durationMs)} ms, ${result.passes} pass${
              result.passes === 1 ? "" : "es"
            }`}
          {result &&
            !result.ok &&
            `Failed: ${result.summary || result.category}`}
        </span>
      </header>

      {result && (
        <p className="note" data-testid="workspace-engine">
          {result.engine.name} {result.engine.version} ·{" "}
          {result.engine.packageSetVersion}
        </p>
      )}

      {result && result.diagnostics.length > 0 && (
        <ul data-testid="workspace-diagnostics">
          {result.diagnostics.slice(0, 20).map((diagnostic) => (
            <li
              key={`${diagnostic.file ?? ""}:${diagnostic.line ?? 0}:${diagnostic.message}`}
              className={severityClass(diagnostic)}
            >
              {diagnostic.file ?? mainFile}
              {diagnostic.line ? `:${diagnostic.line}` : ""} —{" "}
              {diagnostic.message}
            </li>
          ))}
        </ul>
      )}

      <div data-testid="preview" data-status={preview.status}>
        {preview.status === "error" && (
          <p className="unavailable">Preview failed: {preview.error}</p>
        )}
        {preview.status === "ready" && preview.pageCount !== undefined && (
          <p className="note">
            <button
              type="button"
              data-testid="prev-page"
              disabled={(preview.pageIndex ?? 0) === 0}
              onClick={() => void drawPage((preview.pageIndex ?? 0) - 1)}
            >
              Previous
            </button>{" "}
            Page {(preview.pageIndex ?? 0) + 1} of {preview.pageCount}{" "}
            <button
              type="button"
              data-testid="next-page"
              disabled={(preview.pageIndex ?? 0) + 1 >= preview.pageCount}
              onClick={() => void drawPage((preview.pageIndex ?? 0) + 1)}
            >
              Next
            </button>
          </p>
        )}
        <canvas
          ref={canvasRef}
          data-testid="preview-canvas"
          style={{ maxWidth: "100%", border: "1px solid var(--line, #ccc)" }}
        />
      </div>
    </section>
  );
}
