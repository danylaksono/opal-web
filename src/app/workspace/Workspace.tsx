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
  /** What the engine is pointed at, whatever the editor happens to be showing. */
  mainFile: ProjectPath;
  /**
   * The file open in the editor, which is not always the one being compiled.
   *
   * Editing `chapter.tex` and compiling `main.tex` is the ordinary case for any
   * document long enough to be split up, and it is the whole reason these are
   * two props rather than one.
   */
  openPath: ProjectPath;
  /** Live editor content, so a compile uses what is on screen, not on disk. */
  content: string;
  /**
   * The engine's diagnostics, handed up so the editor can mark them.
   *
   * The compile lives here and the editor lives in the panel above, so one of
   * them has to reach the other. This direction keeps the engine's ports where
   * they are: the panel learns *that there are diagnostics*, not how to compile.
   */
  onDiagnostics?: (diagnostics: readonly CompileDiagnostic[]) => void;
  /**
   * A compile asked for from outside — the editor's Ctrl/Cmd+Enter.
   *
   * A number rather than a boolean, because it is an event: pressing the
   * shortcut twice has to compile twice, and any value that can be equal to
   * itself would swallow the second press.
   */
  compileSignal?: number;
  onClose: () => void;
}

interface PreviewState {
  status: "idle" | "rendering" | "ready" | "error";
  pageCount?: number;
  pageIndex?: number;
  error?: string;
}

const ENCODER = new TextEncoder();

/**
 * Zoom steps, in CSS pixels per PDF point before device pixel ratio.
 *
 * Rendering happens at the chosen scale rather than by stretching a bitmap, so
 * text stays sharp when zoomed in — which is the reason to have zoom at all on
 * a document you are proof-reading. The ceiling is where a 16-page thesis
 * starts to cost real memory per page.
 */
const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2, 3] as const;
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;
const DEFAULT_ZOOM = 1.25;

function severityClass(diagnostic: CompileDiagnostic): string {
  return diagnostic.severity === "error" ? "unavailable" : "optional-missing";
}

export function Workspace({
  repository,
  projectId,
  mainFile,
  openPath,
  content,
  onDiagnostics,
  compileSignal,
  onClose,
}: WorkspaceProps) {
  const [compile, setCompile] = useState<CompileState>({ status: "idle" });
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  /**
   * What the engine is doing, not just that it is doing something.
   *
   * A first compile downloads a 41 MB boot package before TeX starts, so a bare
   * "Compiling…" is a spinner over a minute of silence. The adapter already
   * reports stages and a download percentage; this is the only place that can
   * show them.
   */
  const [stage, setStage] = useState<string | null>(null);
  /** Shown only on failure, and collapsed: it is long, and it is the evidence. */
  const [showLog, setShowLog] = useState(false);
  const sessionRef = useRef<CompileSession | null>(null);
  const rendererRef = useRef<MupdfRenderer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  /** Kept so page navigation can redraw without recompiling. */
  const documentRef = useRef<Awaited<
    ReturnType<MupdfRenderer["openDocument"]>
  > | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * Where the reader was, read at compile time rather than captured in a
   * closure.
   *
   * A recompile replaces the document, and redrawing from page one throws away
   * the reader's position on every keystroke-to-compile cycle — the thing that
   * makes a preview feel like it is fighting you. `run` would otherwise need
   * `preview` as a dependency and would then compile against whichever page was
   * showing when the callback was last built, which is the stale-closure bug
   * the compiler spike documents having already been bitten by.
   */
  const viewRef = useRef({ pageIndex: 0 });
  /**
   * Read when a compile finishes rather than captured by `run`.
   *
   * A callback in `run`'s dependencies rebuilds it on every render of the
   * parent, which on this screen is every keystroke.
   */
  const report = useRef(onDiagnostics);
  report.current = onDiagnostics;

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
        onProgress: (name, detail) =>
          setStage(detail ? `${name}: ${detail}` : name),
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

  const drawPage = useCallback(
    async (pageIndex: number, scale = zoom) => {
      const handle = documentRef.current;
      const canvas = canvasRef.current;
      if (!handle || !canvas) return;

      const rendered = await handle.renderPage({
        pageIndex,
        scale,
        devicePixelRatio: window.devicePixelRatio,
      });
      canvas.width = rendered.widthPx;
      canvas.height = rendered.heightPx;
      canvas.getContext("2d")?.drawImage(rendered.bitmap, 0, 0);
      // The bitmap is the caller's once transferred, and the canvas has its own
      // copy by now.
      rendered.bitmap.close();
      viewRef.current.pageIndex = pageIndex;
      setPreview({
        status: "ready",
        pageCount: handle.pageCount,
        pageIndex,
      });
    },
    [zoom],
  );

  const run = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    setShowLog(false);

    // Everything the project holds, not just the open file: a document that
    // \inputs a chapter or cites a .bib compiles only if those travel with it.
    const paths = await repository.listFiles(projectId);
    const files = await Promise.all(
      paths.map(async (path) => ({
        path,
        // The open file comes from the editor and everything else from disk.
        // Autosave has probably written it already, but "probably" is a
        // debounce away from compiling the previous keystroke.
        content:
          path === openPath
            ? ENCODER.encode(content)
            : await repository.readFile(projectId, path),
      })),
    );

    const result = await session.compile(mainFile, files);
    setStage(null);
    // null means a newer compile overtook this one; its result is already on
    // its way and this one must not touch the preview.
    if (!result) return;
    // Reported before the early return on failure: a failed compile is exactly
    // when its diagnostics matter, and clearing them on success is how the
    // marks from the last failure leave the gutter.
    report.current?.(result.diagnostics);
    if (!result.ok) return;

    setPreview({ status: "rendering" });
    try {
      const renderer = rendererRef.current;
      if (!renderer) return;
      // Read before the document is replaced: after that, the old page count
      // is gone and so is any sense of where the reader was.
      const container = scrollRef.current;
      const wanted = viewRef.current.pageIndex;
      const scrollTop = container?.scrollTop ?? 0;
      const scrollLeft = container?.scrollLeft ?? 0;

      await documentRef.current?.close();
      const handle = await renderer.openDocument(new Uint8Array(result.pdf));
      documentRef.current = handle;

      // Clamped rather than assumed: an edit that deletes a chapter makes the
      // page the reader was on stop existing.
      await drawPage(Math.min(wanted, handle.pageCount - 1));
      if (container) {
        container.scrollTop = scrollTop;
        container.scrollLeft = scrollLeft;
      }
    } catch (error) {
      setPreview({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [repository, projectId, mainFile, openPath, content, drawPage]);

  const result = compile.status === "done" ? compile.result : null;
  const busy = compile.status === "compiling";

  /**
   * Compile when the signal changes, and never on mount.
   *
   * `run` is in the dependencies because it must be the current one — it closes
   * over the content being compiled — but a change to *it* must not start a
   * compile, or every keystroke would. The remembered signal is what decides.
   */
  const lastSignal = useRef(compileSignal);
  useEffect(() => {
    if (compileSignal === undefined || compileSignal === lastSignal.current) {
      return;
    }
    lastSignal.current = compileSignal;
    void run();
  }, [compileSignal, run]);

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
        {/*
          The compile target, not the open file: pressing Compile while looking
          at `chapter.tex` compiles `main.tex`, and a header that named the open
          file would be quietly lying about what the button does.
        */}
        <strong data-testid="compile-target">{mainFile}</strong>
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
        {/*
          Polite rather than assertive: a compile takes seconds to minutes and
          its stages update throughout, so an assertive region would talk over
          everything else for the whole run. The result still lands here, which
          is what PLAN.md 13.1 asks to be audible.
        */}
        <span
          role="status"
          data-testid="workspace-status"
          data-status={compile.status}
        >
          {compile.status === "idle" && "Not compiled yet"}
          {busy && (stage ? `Compiling… ${stage}` : "Compiling…")}
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

      {result && !result.ok && result.log && (
        <details
          data-testid="workspace-log"
          open={showLog}
          onToggle={(event) => setShowLog(event.currentTarget.open)}
        >
          {/*
            TeX's log is the only channel the engine gives, and a failure with
            no parseable diagnostic — which is most of them once the failure is
            after TeX, in xdvipdfmx — leaves the summary line and nothing else.
            Collapsed, because it is thousands of lines and the summary is
            usually enough.
          */}
          <summary>Engine log ({result.log.split("\n").length} lines)</summary>
          <pre
            style={{
              maxHeight: "16rem",
              overflow: "auto",
              fontSize: "0.8em",
              whiteSpace: "pre-wrap",
            }}
          >
            {result.log.split("\n").slice(-200).join("\n")}
          </pre>
        </details>
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
          <p className="unavailable" role="alert">
            Preview failed: {preview.error}
          </p>
        )}
        {preview.status === "ready" && (
          <p className="note">
            {/*
              A minus sign is a picture of "zoom out" and reads as nothing.
              The label carries the meaning; the glyph stays for the eye.
            */}
            <button
              type="button"
              data-testid="zoom-out"
              aria-label="Zoom out"
              disabled={zoom <= MIN_ZOOM}
              onClick={() => {
                const next =
                  [...ZOOM_STEPS].reverse().find((step) => step < zoom) ?? zoom;
                setZoom(next);
                void drawPage(preview.pageIndex ?? 0, next);
              }}
            >
              −
            </button>{" "}
            <span data-testid="zoom-level">Zoom {Math.round(zoom * 100)}%</span>{" "}
            <button
              type="button"
              data-testid="zoom-in"
              aria-label="Zoom in"
              disabled={zoom >= MAX_ZOOM}
              onClick={() => {
                const next = ZOOM_STEPS.find((step) => step > zoom) ?? zoom;
                setZoom(next);
                void drawPage(preview.pageIndex ?? 0, next);
              }}
            >
              +
            </button>
          </p>
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
        {/*
          A scroll container rather than a page that grows: zoomed in, a page is
          wider and taller than the viewport, and the position inside it is what
          has to survive a recompile.
        */}
        <div
          ref={scrollRef}
          data-testid="preview-scroll"
          style={{
            overflow: "auto",
            maxHeight: "70vh",
            border: "1px solid var(--line, #ccc)",
          }}
        >
          {/*
            A canvas is a rectangle of pixels with nothing to read. Naming it
            says what is on screen and, more usefully, *which page*: the page
            number is otherwise only in the controls above it.
          */}
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={
              preview.pageCount
                ? `Page ${(preview.pageIndex ?? 0) + 1} of ${preview.pageCount} of the compiled document`
                : "Compiled document preview"
            }
            data-testid="preview-canvas"
          />
        </div>
      </div>
    </section>
  );
}
