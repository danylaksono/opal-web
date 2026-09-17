import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { EditorProblem } from "@/app/editor/CodeEditor";
import { useLayoutStore } from "@/app/store/layout-store";
import { ActivityRail } from "@/app/workspace/ActivityRail";
import type { CompileState } from "@/app/workspace/compile-session";
import { EditorPane, type StructuredEdit } from "@/app/workspace/EditorPane";
import { PreviewPane } from "@/app/workspace/PreviewPane";
import { SidePanel } from "@/app/workspace/SidePanel";
import { StatusBar } from "@/app/workspace/StatusBar";
import type { CompileDiagnostic } from "@/core/compiler/types";
import {
  type Citation,
  citationAt,
  citationCommands,
  formatCitation,
  newCitation,
  readBibliography,
} from "@/core/latex/citation";
import { buildProjectIndex } from "@/core/latex/project-index";
import {
  formatTabular,
  newTabular,
  type Tabular,
  tabularAt,
} from "@/core/latex/tabular";
import {
  type Autosave,
  createAutosave,
  type SaveStatus,
} from "@/core/project/autosave";
import type { ProjectId, ProjectPath } from "@/core/project/ids";
import { projectPath } from "@/core/project/ids";
import type { ProjectRepository } from "@/core/project/repository";
import { cn } from "@/ui/utils";

/**
 * A project, open (PLAN.md 14, Phase 3).
 *
 * The document state that used to live in `ProjectsPanel` — which file is
 * open, every text file's content, the autosave bound to a revision — with the
 * panes of the desktop editor around it: rail, side panel, editor, preview,
 * status bar.
 *
 * The state stays here rather than in a store. It is one screen's worth, it is
 * already proved by the tests that drive it, and the thing a store would buy —
 * components reaching it without props — is not worth the indirection until
 * something outside this tree needs it.
 */

/** Extensions whose bytes are text the index can read. */
const TEXT_FILE = /\.(tex|ltx|cls|sty|bib|txt|md)$/i;

async function readForEditing(
  repository: ProjectRepository,
  id: ProjectId,
  path: ProjectPath,
): Promise<{ content: string; asset: Uint8Array | null }> {
  const bytes = await repository.readFile(id, path);
  return TEXT_FILE.test(path)
    ? { content: new TextDecoder().decode(bytes), asset: null }
    : { content: "", asset: bytes };
}

async function readSources(
  repository: ProjectRepository,
  id: ProjectId,
  files: readonly ProjectPath[],
): Promise<Record<string, string>> {
  const decoder = new TextDecoder();
  const sources: Record<string, string> = {};
  for (const path of files) {
    sources[path] = TEXT_FILE.test(path)
      ? decoder.decode(await repository.readFile(id, path))
      : "";
  }
  return sources;
}

interface OpenProject {
  path: ProjectPath;
  mainFile: ProjectPath;
  files: readonly ProjectPath[];
  /**
   * Every text file's content, kept in memory.
   *
   * The semantic index spans files — a `\ref` here resolves to a `\label`
   * there — so it needs all of them, and re-reading a project from OPFS on
   * every keystroke would trade a 1 ms index for storage traffic.
   */
  sources: Readonly<Record<string, string>>;
  content: string;
  /** The open file's bytes, when it is not text. Never set with `content`. */
  asset: Uint8Array | null;
}

interface WorkspaceScreenProps {
  repository: ProjectRepository;
  projectId: ProjectId;
  title: string;
  onClose: () => void;
  onExport: () => void;
  /** Re-read the project list after a write, so its counts stay honest. */
  onChanged: () => void;
}

export function WorkspaceScreen({
  repository,
  projectId,
  title,
  onClose,
  onExport,
  onChanged,
}: WorkspaceScreenProps) {
  const [open, setOpen] = useState<OpenProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null);
  const [compiled, setCompiled] = useState<readonly CompileDiagnostic[]>([]);
  const [compileState, setCompileState] = useState<CompileState>({
    status: "idle",
  });
  const [compileSignal, setCompileSignal] = useState(0);
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(
    null,
  );
  const [cursor, setCursor] = useState(0);
  const [structured, setStructured] = useState<StructuredEdit | null>(null);
  const [edit, setEdit] = useState<{
    from: number;
    to: number;
    insert: string;
    nonce: number;
  } | null>(null);
  const [focusFile, setFocusFile] = useState<ProjectPath | null>(null);
  const autosaveRef = useRef<Autosave | null>(null);

  const sidePanelOpen = useLayoutStore((state) => state.sidePanelOpen);
  const activeSidePanel = useLayoutStore((state) => state.activeSidePanel);
  const setActiveSidePanel = useLayoutStore(
    (state) => state.setActiveSidePanel,
  );
  const previewVisible = useLayoutStore((state) => state.previewVisible);
  const togglePreview = useLayoutStore((state) => state.togglePreview);

  /**
   * Read when something changes rather than depended on.
   *
   * The caller rebuilds this callback on every render, and depending on it
   * made the effect below re-open the project each time — which reset the open
   * file, the editor's content and the autosave's revision under the person
   * typing. The autosave then never reported a save, because it was replaced
   * before its debounce could fire.
   */
  const changed = useRef(onChanged);
  changed.current = onChanged;

  /** Run something that touches storage, and show why it refused. */
  const act = useCallback(async (work: () => Promise<unknown> | unknown) => {
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Storage refused");
    }
    changed.current();
  }, []);

  const startAutosave = useCallback(
    (revision: number) => {
      autosaveRef.current?.stop();
      autosaveRef.current = createAutosave({
        repository,
        projectId,
        revision,
        onStatus: (status) => {
          setSaveStatus(status);
          if (status.state === "saved") changed.current();
        },
      });
    },
    [repository, projectId],
  );

  // Opening is the one effect: everything else is a response to a person.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const record = await repository.open(projectId);
      const files = await repository.listFiles(projectId);
      const path = record.rootTexPath ?? files[0];
      if (!path || cancelled) return;
      const sources = await readSources(repository, projectId, files);
      if (cancelled) return;
      setOpen({
        path,
        mainFile: path,
        files,
        sources,
        content: sources[path] ?? "",
        asset: null,
      });
      setSaveStatus({ state: "idle", revision: record.revision });
      startAutosave(record.revision);
    })();
    return () => {
      cancelled = true;
      void autosaveRef.current?.flush();
      autosaveRef.current?.stop();
    };
  }, [repository, projectId, startAutosave]);

  // A tab closing mid-edit is exactly when a debounce is a liability.
  useEffect(() => {
    const flush = () => {
      void autosaveRef.current?.flush();
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const openFile = useCallback(
    async (path: ProjectPath) => {
      if (!open) return;
      await autosaveRef.current?.flush();
      const opened = await readForEditing(repository, projectId, path);
      // Functional, like every other update here that spans an await: the user
      // can type through a storage round trip.
      setOpen(
        (previous) =>
          previous && {
            ...previous,
            path,
            ...opened,
            sources: opened.asset
              ? previous.sources
              : { ...previous.sources, [path]: opened.content },
          },
      );
      setStructured(null);
    },
    [open, repository, projectId],
  );

  const createFile = useCallback(
    async (name: string) => {
      if (!open) return;
      const path = projectPath(name);
      if (open.files.includes(path)) {
        throw new Error(`${path} already exists in this project`);
      }
      await autosaveRef.current?.flush();
      const revision = await repository.writeFile(
        projectId,
        path,
        new Uint8Array(),
      );
      const files = await repository.listFiles(projectId);
      setOpen(
        (previous) =>
          previous && {
            ...previous,
            path,
            files,
            content: "",
            asset: null,
            sources: { ...previous.sources, [path]: "" },
          },
      );
      // The write advanced the revision out from under the autosave, whose
      // writes are conditional on the one it was built with. Told rather than
      // rebuilt, because a rebuild drops anything typed while this was in
      // flight.
      autosaveRef.current?.adopt(revision);
    },
    [open, repository, projectId],
  );

  const renameOpenFile = useCallback(
    async (name: string) => {
      if (!open) return;
      const to = projectPath(name);
      if (to === open.path) return;
      await autosaveRef.current?.flush();
      const revision = await repository.renameFile(projectId, open.path, to);
      const files = await repository.listFiles(projectId);
      const from = open.path;
      setOpen((previous) => {
        if (!previous) return previous;
        const sources = { ...previous.sources };
        sources[to] = sources[from] ?? "";
        delete sources[from];
        return {
          ...previous,
          path: to,
          // The record's root file follows a rename, so this has to as well or
          // the compile button would point at a name that no longer exists.
          mainFile: previous.mainFile === from ? to : previous.mainFile,
          files,
          sources,
        };
      });
      autosaveRef.current?.adopt(revision);
    },
    [open, repository, projectId],
  );

  const deleteFile = useCallback(
    async (path: ProjectPath) => {
      if (!open) return;
      // The compile target is not deletable from here. A project whose main
      // file is missing cannot compile and offers no way back to one that can.
      if (path === open.mainFile) {
        throw new Error(
          `${path} is this project's main file; it cannot be deleted here`,
        );
      }
      await autosaveRef.current?.flush();
      const revision = await repository.deleteFile(projectId, path);
      const files = await repository.listFiles(projectId);
      const next = path === open.path ? open.mainFile : open.path;
      const opened = await readForEditing(repository, projectId, next);
      setOpen((previous) => {
        if (!previous) return previous;
        const sources = { ...previous.sources };
        delete sources[path];
        return { ...previous, path: next, files, sources, ...opened };
      });
      // Deleting the file you were on removes the button you pressed, and
      // focus falls to the body.
      setFocusFile(next);
      autosaveRef.current?.adopt(revision);
    },
    [open, repository, projectId],
  );

  /** The project's cross-file structure, recomputed as it is typed (~1 ms). */
  const index = useMemo(() => {
    if (!open) return null;
    return buildProjectIndex(
      Object.entries(open.sources).map(([path, content]) => ({
        path: path as ProjectPath,
        content,
      })),
      open.mainFile,
    );
  }, [open]);

  /**
   * What to mark in the open file's gutter, from both sources at once.
   *
   * The engine knows what TeX could not do, the index knows what the project
   * does not contain, and neither is visible from the other.
   */
  const editorProblems = useMemo<EditorProblem[]>(() => {
    if (!open) return [];
    const fromIndex = (index?.problems ?? [])
      .filter((problem) => problem.file === open.path)
      .map((problem) => ({
        line: problem.line,
        message: problem.message,
        severity: "warning" as const,
      }));
    const fromEngine = compiled.flatMap((diagnostic) =>
      diagnostic.line === undefined ||
      (diagnostic.file ?? open.mainFile) !== open.path
        ? []
        : [
            {
              line: diagnostic.line,
              message: diagnostic.message,
              severity:
                diagnostic.severity === "error"
                  ? ("error" as const)
                  : ("warning" as const),
            },
          ],
    );
    return [...fromIndex, ...fromEngine];
  }, [open, index, compiled]);

  const tableHere = useMemo(
    () => (open && !open.asset ? tabularAt(open.content, cursor) : null),
    [open, cursor],
  );
  const citationHere = useMemo(
    () => (open && !open.asset ? citationAt(open.content, cursor) : null),
    [open, cursor],
  );
  const packages = useMemo(
    () =>
      new Set(
        [...(index?.facts.values() ?? [])].flatMap((facts) => facts.packages),
      ),
    [index],
  );

  /**
   * Write a structured editor's result back into the document.
   *
   * Refused if the span no longer holds what was read: the source stayed
   * editable while the editor was open, and replacing a span that has moved
   * would overwrite whatever now occupies it.
   */
  const applySpan = useCallback(
    (
      span: { from: number; to: number; original: string },
      insert: string,
      what: string,
    ) => {
      if (!open) return;
      const current = open.content.slice(span.from, span.to);
      if (current !== span.original) {
        throw new Error(
          `The ${what} changed in the source while its editor was open; reopen it to edit the current version`,
        );
      }
      setEdit((previous) => ({
        from: span.from,
        to: span.to,
        insert,
        nonce: (previous?.nonce ?? 0) + 1,
      }));
      setStructured(null);
    },
    [open],
  );

  const closeStructured = useCallback(() => {
    setStructured(null);
    document
      .querySelector<HTMLElement>('[data-testid="editor-content"]')
      ?.focus();
  }, []);

  /** Open a file if it is not already open, then put the cursor on a line. */
  const goTo = useCallback(
    async (path: ProjectPath, line: number) => {
      if (open && path !== open.path) await openFile(path);
      // Counted rather than timestamped: two activations inside one
      // millisecond would otherwise carry the same nonce.
      setReveal((previous) => ({ line, nonce: (previous?.nonce ?? 0) + 1 }));
    },
    [open, openFile],
  );

  if (!open) {
    return (
      <div className="flex h-dvh items-center justify-center text-muted-foreground text-sm">
        Opening {title}…
      </div>
    );
  }

  const errors = editorProblems.filter(
    (problem) => problem.severity === "error",
  ).length;
  const warnings = editorProblems.length - errors;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1">
        <ActivityRail
          onClose={onClose}
          onExport={onExport}
          problemCount={index?.problems.length ?? 0}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          {error && (
            <div
              role="alert"
              data-testid="projects-error"
              className="shrink-0 border-destructive/40 border-b bg-destructive/10 px-3 py-1.5 text-destructive text-xs"
            >
              {error}
            </div>
          )}

          <PanelGroup direction="horizontal" className="min-h-0 min-w-0 flex-1">
            {sidePanelOpen && (
              <>
                <Panel
                  id="side"
                  order={1}
                  defaultSize={20}
                  minSize={12}
                  maxSize={34}
                >
                  <SidePanel
                    panel={activeSidePanel}
                    files={open.files}
                    openPath={open.path}
                    mainFile={open.mainFile}
                    index={index}
                    focusFile={focusFile}
                    onFocused={() => setFocusFile(null)}
                    onOpenFile={(path) => void act(() => openFile(path))}
                    onCreateFile={(name) => void act(() => createFile(name))}
                    onRenameFile={(name) =>
                      void act(() => renameOpenFile(name))
                    }
                    onDeleteFile={(path) => void act(() => deleteFile(path))}
                    onGoTo={(path, line) => void act(() => goTo(path, line))}
                  />
                </Panel>
                <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />
              </>
            )}

            <Panel
              id="editor"
              order={2}
              defaultSize={previewVisible ? 45 : 85}
              minSize={25}
            >
              <div className="relative h-full">
                <EditorPane
                  projectId={projectId}
                  openPath={open.path}
                  mainFile={open.mainFile}
                  content={open.content}
                  asset={open.asset}
                  completions={{
                    labels: [...(index?.labels.keys() ?? [])],
                    citations: [...(index?.bibliographyKeys ?? [])],
                  }}
                  problems={editorProblems}
                  reveal={reveal}
                  edit={edit}
                  tableHere={tableHere}
                  citationHere={citationHere}
                  structured={structured}
                  citationCommands={citationCommands(packages)}
                  prenotes={packages.has("natbib") || packages.has("biblatex")}
                  onCompile={() => setCompileSignal((signal) => signal + 1)}
                  onCursor={setCursor}
                  onChange={(content) => {
                    setOpen((previous) =>
                      previous
                        ? {
                            ...previous,
                            content,
                            sources: {
                              ...previous.sources,
                              [previous.path]: content,
                            },
                          }
                        : previous,
                    );
                    autosaveRef.current?.queue(
                      open.path,
                      new TextEncoder().encode(content),
                    );
                  }}
                  onOpenTable={() =>
                    setStructured({
                      kind: "table",
                      path: open.path,
                      table: tableHere?.ok
                        ? tableHere.table
                        : newTabular(open.content, cursor),
                    })
                  }
                  onOpenCitation={() =>
                    setStructured({
                      kind: "citation",
                      path: open.path,
                      citation: citationHere?.ok
                        ? citationHere.citation
                        : newCitation(cursor),
                      // Read now rather than kept in the index: fields cost
                      // more than keys, and only this needs them.
                      entries: readBibliography(
                        Object.entries(open.sources).map(([path, content]) => ({
                          path: path as ProjectPath,
                          content,
                        })),
                      ),
                    })
                  }
                  onApplyTable={(table: Tabular) =>
                    void act(() =>
                      applySpan(table, formatTabular(table), "table"),
                    )
                  }
                  onApplyCitation={(citation: Citation) =>
                    void act(() =>
                      applySpan(citation, formatCitation(citation), "citation"),
                    )
                  }
                  onCancelStructured={closeStructured}
                />
                <button
                  type="button"
                  data-testid="toggle-preview"
                  onClick={togglePreview}
                  title={previewVisible ? "Hide preview" : "Show preview"}
                  aria-label={previewVisible ? "Hide preview" : "Show preview"}
                  aria-pressed={previewVisible}
                  className={cn(
                    "absolute right-3 bottom-3 z-40 rounded-md border bg-background/85 p-1.5 text-muted-foreground text-xs shadow-sm backdrop-blur",
                    "transition-colors hover:bg-muted hover:text-foreground",
                  )}
                >
                  {previewVisible ? "Hide preview" : "Show preview"}
                </button>
              </div>
            </Panel>

            {previewVisible && (
              <>
                <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />
                <Panel id="preview" order={3} defaultSize={45} minSize={25}>
                  <PreviewPane
                    repository={repository}
                    projectId={projectId}
                    mainFile={open.mainFile}
                    openPath={open.path}
                    content={open.content}
                    onDiagnostics={setCompiled}
                    onState={setCompileState}
                    compileSignal={compileSignal}
                  />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
      </div>

      <StatusBar
        openPath={open.path}
        mainFile={open.mainFile}
        content={open.content}
        saveStatus={saveStatus}
        compile={compileState}
        errors={errors}
        warnings={warnings}
        onShowProblems={() => setActiveSidePanel("health")}
      />
    </div>
  );
}
