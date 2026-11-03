import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  MinusIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CompileSession,
  type CompileState,
} from "@/app/workspace/compile-session";
import type { CompileDiagnostic } from "@/core/compiler/types";
import type { ProjectId, ProjectPath } from "@/core/project/ids";
import type { ProjectRepository } from "@/core/project/repository";
import type {
  ReviewAnchor,
  ReviewAnchorUpdate,
  ReviewComment,
} from "@/core/review/model";
import {
  type AnchorChecker,
  reanchorAnnotations,
} from "@/core/review/reanchor";
import { synctexForwardSearch } from "@/platform/browser/compiler/synctex";
import {
  TEXLYRE_BOOT_TIER,
  TexlyreLatexCompiler,
} from "@/platform/browser/compiler/texlyre-compiler";
import { MupdfRenderer } from "@/platform/browser/pdf/mupdf-renderer";
import { Button } from "@/ui/button";
import { cn } from "@/ui/utils";

/**
 * The compiled document (investigation.md 14, Phase 2), in the right-hand pane.
 *
 * The loop is unchanged — `CompileSession` owns sequencing, `LatexCompiler`
 * compiles, `PdfRenderer` draws — and this file owns only how it looks: a
 * toolbar with the compile controls, the page, and the log when it fails.
 */

interface PreviewPaneProps {
  repository: ProjectRepository;
  projectId: ProjectId;
  /** What the engine is pointed at, whatever the editor happens to be showing. */
  mainFile: ProjectPath;
  /** The file open in the editor, which is not always the one being compiled. */
  openPath: ProjectPath;
  /** Live editor content, so a compile uses what is on screen, not on disk. */
  content: string;
  onDiagnostics?: (diagnostics: readonly CompileDiagnostic[]) => void;
  onState?: (state: CompileState) => void;
  /** A freshly rendered document, for checking review anchors against. */
  onDocument?: (checker: AnchorChecker) => void;
  /** A comment pinned to a point on a page. Absent means commenting is off. */
  onAddComment?: (input: { anchor: ReviewAnchor; body: string }) => void;
  /** Everything reviewers said, drawn on the page it was anchored to. */
  annotations?: readonly ReviewComment[];
  anchorStatus?: Readonly<Record<string, ReviewAnchorUpdate>>;
  selectedAnnotation?: string | null;
  onSelectAnnotation?: (id: string) => void;
  /** Ask the preview to show a page (1-based). The nonce makes a repeat count. */
  showPage?: { page: number; nonce: number } | null;
  /** A compile asked for from outside — the editor's Ctrl/Cmd+Enter. */
  compileSignal?: number;
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
 * a document you are proof-reading.
 */
const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2, 3] as const;
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;
const DEFAULT_ZOOM = 1.25;

export function PreviewPane({
  repository,
  projectId,
  mainFile,
  openPath,
  content,
  onDiagnostics,
  onState,
  onDocument,
  onAddComment,
  annotations = [],
  anchorStatus = {},
  selectedAnnotation = null,
  onSelectAnnotation,
  showPage = null,
  compileSignal,
}: PreviewPaneProps) {
  const [compile, setCompile] = useState<CompileState>({ status: "idle" });
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  /**
   * What the engine is doing, not just that it is doing something.
   *
   * A first compile downloads a 41 MB boot package before TeX starts, so a bare
   * "Compiling…" is a spinner over a minute of silence.
   */
  const [stage, setStage] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const sessionRef = useRef<CompileSession | null>(null);
  const rendererRef = useRef<MupdfRenderer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const documentRef = useRef<Awaited<
    ReturnType<MupdfRenderer["openDocument"]>
  > | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The page's width in PDF points as last drawn, to turn a click into one. */
  const pageWidthPt = useRef(0);
  const pageHeightPt = useRef(0);
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState<{
    page: number;
    x: number;
    y: number;
    left: number;
    top: number;
    body: string;
  } | null>(null);
  /** Where the reader was, read at compile time rather than captured. */
  const viewRef = useRef({ pageIndex: 0 });
  const report = useRef(onDiagnostics);
  report.current = onDiagnostics;
  const publish = useRef(onState);
  publish.current = onState;
  const announce = useRef(onDocument);
  announce.current = onDocument;

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
      onState: (state) => {
        setCompile(state);
        publish.current?.(state);
      },
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
      // Points, not pixels: the stored anchor must not depend on the zoom or
      // the screen it was made on.
      pageHeightPt.current =
        rendered.heightPx / (scale * window.devicePixelRatio);
      pageWidthPt.current =
        rendered.widthPx / (scale * window.devicePixelRatio);
      canvas.width = rendered.widthPx;
      canvas.height = rendered.heightPx;
      canvas.getContext("2d")?.drawImage(rendered.bitmap, 0, 0);
      // The bitmap is the caller's once transferred, and the canvas has its own
      // copy by now.
      rendered.bitmap.close();
      viewRef.current.pageIndex = pageIndex;
      // A draft belongs to the page it was placed on.
      setDraft(null);
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
      const synctex = result.synctex;
      announce.current?.((comments) =>
        reanchorAnnotations(
          // Without SyncTeX a source line cannot be resolved, and asking would
          // report every text-less annotation as drifted: no evidence is not
          // evidence of drift.
          synctex
            ? comments
            : comments.map(({ anchor: { source: _, ...anchor }, ...rest }) => ({
                ...rest,
                anchor,
              })),
          {
            pageCount: handle.pageCount,
            searchPage: (index, needle, maxHits) =>
              handle.searchPage(index, needle, maxHits),
            forwardSearch: (sources) =>
              synctex
                ? synctexForwardSearch(synctex, sources)
                : Promise.resolve(sources.map(() => null)),
            isCancelled: () => documentRef.current !== handle,
          },
        ),
      );

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
   * compile, or every keystroke would.
   */
  const lastSignal = useRef(compileSignal);
  useEffect(() => {
    if (compileSignal === undefined || compileSignal === lastSignal.current) {
      return;
    }
    lastSignal.current = compileSignal;
    void run();
  }, [compileSignal, run]);

  const pageIndex = preview.pageIndex ?? 0;

  // A request from the review panel to look at a page.
  const lastShown = useRef(showPage?.nonce);
  useEffect(() => {
    if (!showPage || showPage.nonce === lastShown.current) return;
    lastShown.current = showPage.nonce;
    const handle = documentRef.current;
    if (!handle) return;
    void drawPage(
      Math.min(Math.max(0, showPage.page - 1), handle.pageCount - 1),
    );
  }, [showPage, drawPage]);

  return (
    <div
      data-testid="workspace"
      className="flex h-full min-w-0 flex-col bg-muted/30"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-border border-b bg-background px-2">
        <Button
          size="sm"
          data-testid="compile-button"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => void run()}
          disabled={busy}
        >
          {busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <PlayIcon className="size-3.5" />
          )}
          {busy ? "Compiling…" : "Compile"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="cancel-button"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => sessionRef.current?.cancel()}
          disabled={!busy}
        >
          <SquareIcon className="size-3" />
          Cancel
        </Button>
        {/*
          The compile target, not the open file: pressing Compile while looking
          at `chapter.tex` compiles `main.tex`.
        */}
        <span
          data-testid="compile-target"
          className="ml-1 truncate text-muted-foreground text-xs"
        >
          {mainFile}
        </span>

        {preview.status === "ready" && preview.pageCount !== undefined && (
          <div className="ml-auto flex items-center gap-1">
            {onAddComment && (
              <Button
                size="icon"
                variant="ghost"
                data-testid="comment-mode"
                aria-label="Add a comment"
                aria-pressed={commenting}
                title="Add a comment: click the page"
                className={cn("size-7", commenting && "bg-accent")}
                onClick={() => {
                  setCommenting(!commenting);
                  setDraft(null);
                }}
              >
                <MessageSquarePlusIcon className="size-4" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              data-testid="prev-page"
              aria-label="Previous page"
              className="size-7"
              disabled={pageIndex === 0}
              onClick={() => void drawPage(pageIndex - 1)}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <span
              data-testid="page-indicator"
              className="text-muted-foreground text-xs tabular-nums"
            >
              {pageIndex + 1} / {preview.pageCount}
            </span>
            <Button
              size="icon"
              variant="ghost"
              data-testid="next-page"
              aria-label="Next page"
              className="size-7"
              disabled={pageIndex + 1 >= preview.pageCount}
              onClick={() => void drawPage(pageIndex + 1)}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
            <span className="mx-1 h-4 w-px bg-border" />
            {/*
              A minus sign is a picture of "zoom out" and reads as nothing, so
              the label carries the meaning and the glyph stays for the eye.
            */}
            <Button
              size="icon"
              variant="ghost"
              data-testid="zoom-out"
              aria-label="Zoom out"
              className="size-7"
              disabled={zoom <= MIN_ZOOM}
              onClick={() => {
                const next =
                  [...ZOOM_STEPS].reverse().find((step) => step < zoom) ?? zoom;
                setZoom(next);
                void drawPage(pageIndex, next);
              }}
            >
              <MinusIcon className="size-4" />
            </Button>
            <span
              data-testid="zoom-level"
              className="text-muted-foreground text-xs tabular-nums"
            >
              {Math.round(zoom * 100)}%
            </span>
            <Button
              size="icon"
              variant="ghost"
              data-testid="zoom-in"
              aria-label="Zoom in"
              className="size-7"
              disabled={zoom >= MAX_ZOOM}
              onClick={() => {
                const next = ZOOM_STEPS.find((step) => step > zoom) ?? zoom;
                setZoom(next);
                void drawPage(pageIndex, next);
              }}
            >
              <PlusIcon className="size-4" />
            </Button>
          </div>
        )}
      </div>

      {/*
        Polite rather than assertive: a compile takes seconds to minutes and its
        stages update throughout, so an assertive region would talk over
        everything else for the whole run.
      */}
      <span
        role="status"
        data-testid="workspace-status"
        data-status={compile.status}
        className="sr-only"
      >
        {compile.status === "idle" && "Not compiled yet"}
        {busy && (stage ? `Compiling… ${stage}` : "Compiling…")}
        {result?.ok &&
          `Compiled in ${Math.round(result.durationMs)} ms, ${result.passes} pass${
            result.passes === 1 ? "" : "es"
          }`}
        {result && !result.ok && `Failed: ${result.summary || result.category}`}
      </span>

      {busy && stage && (
        <p className="shrink-0 border-border border-b bg-background px-3 py-1 text-muted-foreground text-xs">
          {stage}
        </p>
      )}

      {result && !result.ok && (
        <div className="shrink-0 border-border border-b bg-destructive/5 px-3 py-2">
          <p className="font-medium text-destructive text-xs">
            {result.summary || result.category}
          </p>
          {result.diagnostics.length > 0 && (
            <ul
              data-testid="workspace-diagnostics"
              className="mt-1 space-y-0.5"
            >
              {result.diagnostics.slice(0, 20).map((diagnostic) => (
                <li
                  key={`${diagnostic.file ?? ""}:${diagnostic.line ?? 0}:${diagnostic.message}`}
                  className={`text-xs ${
                    diagnostic.severity === "error"
                      ? "text-destructive"
                      : "text-amber-600 dark:text-amber-400"
                  }`}
                >
                  <span className="font-mono">
                    {diagnostic.file ?? mainFile}
                    {diagnostic.line ? `:${diagnostic.line}` : ""}
                  </span>{" "}
                  {diagnostic.message}
                </li>
              ))}
            </ul>
          )}
          {result.log && (
            <details
              data-testid="workspace-log"
              open={showLog}
              onToggle={(event) => setShowLog(event.currentTarget.open)}
              className="mt-1"
            >
              {/*
                TeX's log is the only channel the engine gives, and a failure
                with no parseable diagnostic — which is most of them once the
                failure is after TeX, in xdvipdfmx — leaves the summary line and
                nothing else.
              */}
              <summary className="cursor-pointer text-muted-foreground text-xs">
                Engine log ({result.log.split("\n").length} lines)
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                {result.log.split("\n").slice(-200).join("\n")}
              </pre>
            </details>
          )}
        </div>
      )}

      {result?.ok && (
        <p className="sr-only" data-testid="workspace-engine">
          {result.engine.name} {result.engine.version} ·{" "}
          {result.engine.packageSetVersion}
        </p>
      )}

      <div
        ref={scrollRef}
        data-testid="preview-scroll"
        className="min-h-0 flex-1 overflow-auto p-4"
      >
        <div
          data-testid="preview"
          data-status={preview.status}
          className="flex justify-center"
        >
          {preview.status === "error" && (
            <p className="text-destructive text-sm" role="alert">
              Preview failed: {preview.error}
            </p>
          )}
          {preview.status === "idle" && !busy && (
            <p className="mt-8 max-w-xs text-center text-muted-foreground text-sm">
              Press Compile to typeset {mainFile}. The engine runs in this
              browser; the first compile downloads it.
            </p>
          )}
          {/*
            A canvas is a rectangle of pixels with nothing to read. Naming it
            says what is on screen and, more usefully, which page.
          */}
          <div
            className={cn("relative", preview.status !== "ready" && "hidden")}
          >
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={
                preview.pageCount
                  ? `Page ${pageIndex + 1} of ${preview.pageCount} of the compiled document`
                  : "Compiled document preview"
              }
              data-testid="preview-canvas"
              className={cn(
                "max-w-full shadow-md ring-1 ring-border",
                commenting && "cursor-crosshair",
              )}
              onClick={(event) => {
                const canvas = event.currentTarget;
                if (!commenting || !pageWidthPt.current) return;
                const box = canvas.getBoundingClientRect();
                // A fraction of what is displayed, so zoom, a canvas shrunk to
                // fit and the device pixel ratio all drop out.
                const scale = pageWidthPt.current / box.width;
                setDraft({
                  page: pageIndex + 1,
                  x: (event.clientX - box.left) * scale,
                  y: (event.clientY - box.top) * scale,
                  left: event.clientX - box.left,
                  top: event.clientY - box.top,
                  body: "",
                });
              }}
            />
            {/*
              Placed in percent of the page, so zoom and a canvas shrunk to fit
              move them with it. A shifted or drifted mark stays where it was
              put: the panel says its text moved, and the reader decides.
            */}
            {pageWidthPt.current > 0 &&
              annotations
                .filter((item) => item.anchor.page === pageIndex + 1)
                .map((item) => {
                  const { anchor } = item;
                  const status = anchorStatus[item.id]?.status;
                  const stale = status === "shifted" || status === "drifted";
                  const left = (anchor.x / pageWidthPt.current) * 100;
                  const top = (anchor.y / pageHeightPt.current) * 100;
                  const pin = anchor.width === 0 && anchor.height === 0;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid="page-marker"
                      data-id={item.id}
                      data-status={item.status}
                      aria-label={`Comment by ${item.author}${item.body ? `: ${item.body}` : ""}`}
                      aria-pressed={selectedAnnotation === item.id}
                      title={item.body || item.author}
                      style={{
                        left: `${left}%`,
                        top: `${top}%`,
                        ...(pin
                          ? {}
                          : {
                              width: `${(anchor.width / pageWidthPt.current) * 100}%`,
                              height: `${(anchor.height / pageHeightPt.current) * 100}%`,
                            }),
                      }}
                      className={cn(
                        "absolute z-[5]",
                        pin
                          ? "-translate-y-full size-5 rounded-full rounded-bl-none border bg-sky-500 text-white"
                          : "border-2 border-sky-500 bg-sky-500/15",
                        item.status === "resolved" && "opacity-40",
                        stale && "border-amber-500 bg-amber-500",
                        selectedAnnotation === item.id &&
                          "outline outline-2 outline-offset-2 outline-ring",
                        commenting && "pointer-events-none",
                      )}
                      onClick={() => onSelectAnnotation?.(item.id)}
                    />
                  );
                })}
            {draft && onAddComment && (
              <form
                data-testid="comment-draft"
                style={{ left: draft.left, top: draft.top }}
                className="absolute z-10 w-56 space-y-1 rounded-md border bg-background p-2 shadow-lg"
                onSubmit={(event) => {
                  event.preventDefault();
                  const body = draft.body.trim();
                  if (!body) return;
                  onAddComment({
                    anchor: {
                      kind: "point",
                      page: draft.page,
                      x: draft.x,
                      y: draft.y,
                      width: 0,
                      height: 0,
                    },
                    body,
                  });
                  setDraft(null);
                  setCommenting(false);
                }}
              >
                <textarea
                  // biome-ignore lint/a11y/noAutofocus: the person just clicked to write here
                  autoFocus
                  data-testid="comment-draft-body"
                  aria-label="Comment"
                  rows={3}
                  value={draft.body}
                  className="w-full rounded border bg-background p-1 text-xs"
                  onChange={(event) =>
                    setDraft({ ...draft, body: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setDraft(null);
                  }}
                />
                <div className="flex justify-end gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => setDraft(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    data-testid="comment-draft-add"
                    className="h-6 px-2 text-xs"
                  >
                    Add
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
