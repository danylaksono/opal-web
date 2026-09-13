/**
 * Create, open, rename and delete projects (PLAN.md 14, Phase 1).
 *
 * The first surface backed by real storage rather than by a spike's file input.
 * It is deliberately plain: what is being built here is the guarantee that a
 * project survives a reload, and the way to show that is a list that comes back
 * with the same revisions after one.
 *
 * Quota and persistence sit next to the list rather than in a settings page.
 * OPFS is origin-private and evictable, so a user who has not granted
 * persistence is one storage-pressure event away from losing work, and PLAN.md
 * 6.1 is explicit that this must be visible rather than buried.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssetView } from "@/app/editor/AssetView";
import type { EditorProblem } from "@/app/editor/CodeEditor";
import { CodeEditor } from "@/app/editor/CodeEditor";
import { Workspace } from "@/app/workspace/Workspace";
import type { CompileDiagnostic } from "@/core/compiler/types";
import { buildProjectIndex } from "@/core/latex/project-index";
import {
  ArchiveRejectedError,
  packProject,
  unpackProject,
} from "@/core/project/archive";
import {
  type Autosave,
  createAutosave,
  type SaveStatus,
} from "@/core/project/autosave";
import type { ProjectId, ProjectPath } from "@/core/project/ids";
import { projectPath } from "@/core/project/ids";
import type {
  ProjectRepository,
  ProjectSummary,
} from "@/core/project/repository";
import { PROJECT_TEMPLATES, templateById } from "@/core/project/templates";

/**
 * Extensions whose bytes are text the index can read.
 *
 * Anything else is held as an empty string rather than skipped: a project's
 * images are not readable here, but `\includegraphics{plot}` resolves against
 * their *paths*, and a file the index cannot see is a file it reports missing.
 */
const TEXT_FILE = /\.(tex|ltx|cls|sty|bib|txt|md)$/i;

/**
 * Read one file the way the editor needs it: text, or bytes it must not decode.
 *
 * Extracted because `openFile` and `deleteFile` both switch to a file, and only
 * one of them knew about binary. Deleting a file while a PNG was open decoded
 * the PNG into the text editor — the exact data-loss path `AssetView` exists to
 * close, reachable through the other door.
 */
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

interface StorageStatus {
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
}

async function readStorageStatus(): Promise<StorageStatus> {
  const storage = navigator.storage as StorageManager | undefined;
  const persisted =
    typeof storage?.persisted === "function" ? await storage.persisted() : null;
  const estimate =
    typeof storage?.estimate === "function" ? await storage.estimate() : null;
  return {
    persisted,
    usageBytes: estimate?.usage ?? null,
    quotaBytes: estimate?.quota ?? null,
  };
}

/**
 * A timestamp a person can read at a glance.
 *
 * The stored value is ISO 8601 because records have to sort and compare; that
 * is a storage concern, and showing it raw makes the reader do the conversion.
 */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const minutes = Math.round((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function ProjectsPanel({
  repository,
}: {
  repository: ProjectRepository;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled project");
  const [templateId, setTemplateId] = useState("blank");
  const importInput = useRef<HTMLInputElement | null>(null);
  const [editing, setEditing] = useState<{
    id: ProjectId;
    /** The file in the textarea. */
    path: ProjectPath;
    /** The file the compile is pointed at, which `path` need not be. */
    mainFile: ProjectPath;
    /** Every file in the project, so one can be switched to without a re-open. */
    files: readonly ProjectPath[];
    /**
     * Every text file's content, kept in memory.
     *
     * The semantic index spans files — a `\ref` here resolves to a `\label`
     * there — so it needs all of them, and re-reading a project from OPFS on
     * every keystroke would trade a 1 ms index for storage traffic. Binary
     * files are held as empty strings: their *paths* are what
     * `\includegraphics` resolves against, and their bytes mean nothing here.
     */
    sources: Readonly<Record<string, string>>;
    content: string;
    /**
     * The open file's bytes, when it is not text.
     *
     * Set instead of `content`, never as well as it: a file that reaches the
     * text editor can be autosaved from it, and autosaving a PNG that has been
     * through `TextDecoder` writes back a different PNG.
     */
    asset: Uint8Array | null;
  } | null>(null);
  const [newFileName, setNewFileName] = useState("");
  const [renameTo, setRenameTo] = useState("");
  /** An outline click: which line to show, and a nonce so a repeat click works. */
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(
    null,
  );
  /** The last compile's diagnostics, kept so the editor can mark them. */
  const [compiled, setCompiled] = useState<readonly CompileDiagnostic[]>([]);
  /** Bumped by the editor's Ctrl/Cmd+Enter; the workspace compiles on a change. */
  const [compileSignal, setCompileSignal] = useState(0);
  /**
   * A file whose button should take focus once it is rendered.
   *
   * Deleting the file you were on removes the button you pressed, and focus
   * falls to the body — a keyboard user is then at the top of the document with
   * no idea where they are. Set on delete, cleared when it lands.
   */
  const [focusFile, setFocusFile] = useState<ProjectPath | null>(null);
  const fileList = useRef<HTMLDivElement>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null);
  const autosaveRef = useRef<Autosave | null>(null);

  /**
   * Re-read the list.
   *
   * Reports its own failure but never clears someone else's: `act` runs this
   * after every action, and a `setError(null)` here would wipe the message the
   * action had just set. A rejected import then looked like nothing happening
   * at all, which is how the browser test found it.
   */
  const refresh = useCallback(async () => {
    try {
      setProjects(await repository.list());
      setStatus(await readStorageStatus());
    } catch (cause) {
      // A storage layer that cannot list is the one failure this panel must
      // not hide: everything else it offers would silently do nothing.
      setError(cause instanceof Error ? cause.message : "Storage unavailable");
      setProjects([]);
    }
  }, [repository]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (work: () => Promise<unknown>) => {
      // Cleared before, not after: what follows may set one.
      setError(null);
      try {
        await work();
      } catch (cause) {
        // An archive rejection is the user's problem to fix, so it names the
        // entry rather than reporting a generic storage failure.
        setError(
          cause instanceof ArchiveRejectedError
            ? `Archive rejected (${cause.reason}): ${cause.message}`
            : cause instanceof Error
              ? cause.message
              : "Storage refused",
        );
      }
      await refresh();
    },
    [refresh],
  );

  /**
   * Download a project as a ZIP.
   *
   * The object URL is revoked on the next frame rather than immediately: the
   * click has to reach the browser's download machinery first, and revoking in
   * the same tick cancels the download in some browsers.
   */
  const exportProject = useCallback(
    async (id: ProjectId, projectTitle: string) => {
      const paths = await repository.listFiles(id);
      const files = await Promise.all(
        paths.map(async (path) => ({
          path,
          bytes: await repository.readFile(id, path),
        })),
      );
      const zip = packProject(files);
      const url = URL.createObjectURL(
        new Blob([zip as BlobPart], { type: "application/zip" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${projectTitle.replace(/[^\w.-]+/g, "-") || "project"}.zip`;
      anchor.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 0);
    },
    [repository],
  );

  const importArchive = useCallback(
    async (file: File) => {
      const archive = new Uint8Array(await file.arrayBuffer());
      // Unpacked before the project is created, so a rejected archive leaves
      // nothing behind to clean up.
      const files = unpackProject(archive);
      const main = files.find((entry) => entry.path.endsWith("main.tex"));
      await repository.create({
        title: file.name.replace(/\.zip$/i, "") || "Imported project",
        files,
        ...(main ? { rootTexPath: main.path } : {}),
      });
    },
    [repository],
  );

  /**
   * Build the autosave scheduler for a project at a known revision.
   *
   * Rebuilt rather than updated because it holds the revision this session is
   * writing against: carrying one over from a different project — or from
   * before a write this panel itself made — would make its conditional writes
   * meaningless, which is the one thing they exist to prevent.
   */
  const startAutosave = useCallback(
    (id: ProjectId, revision: number) => {
      autosaveRef.current?.stop();
      autosaveRef.current = createAutosave({
        repository,
        projectId: id,
        revision,
        onStatus: (status) => {
          setSaveStatus(status);
          // A saved revision changes the row's counts, so the list is stale
          // until it is re-read.
          if (status.state === "saved") void refresh();
        },
      });
    },
    [repository, refresh],
  );

  /**
   * Open a project's main file for editing.
   */
  const openForEditing = useCallback(
    async (id: ProjectId) => {
      await autosaveRef.current?.flush();
      autosaveRef.current?.stop();

      const record = await repository.open(id);
      const files = await repository.listFiles(id);
      const path = record.rootTexPath ?? files[0];
      if (!path) {
        setEditing(null);
        return;
      }
      const sources = await readSources(repository, id, files);
      const content = sources[path] ?? "";
      setEditing({
        id,
        path,
        mainFile: path,
        files,
        sources,
        content,
        asset: null,
      });
      setSaveStatus({ state: "idle", revision: record.revision });
      startAutosave(id, record.revision);
    },
    [repository, startAutosave],
  );

  /**
   * Switch which file the editor is showing.
   *
   * Flushed first: a queued write is bound to the path it was queued for, so it
   * would not be lost, but letting it land after the switch means the save
   * status a user is watching belongs to a file they are no longer looking at.
   */
  const openFile = useCallback(
    async (path: ProjectPath) => {
      if (!editing) return;
      await autosaveRef.current?.flush();
      const opened = await readForEditing(repository, editing.id, path);
      // Functional, like every other update here that spans an await: the user
      // can type through a storage round trip, and spreading the snapshot
      // taken before it would put their keystrokes back.
      setEditing(
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
    },
    [editing, repository],
  );

  /**
   * Add a file and open it.
   *
   * Empty rather than templated: a `.bib`, a `chapter.tex` and a `\usepackage`
   * fragment have nothing in common to pre-fill, and a wrong guess is worse
   * than a blank file because it has to be deleted before it can be replaced.
   */
  const createFile = useCallback(
    async (name: string) => {
      if (!editing) return;
      const path = projectPath(name);
      if (editing.files.includes(path)) {
        throw new Error(`${path} already exists in this project`);
      }
      await autosaveRef.current?.flush();
      const revision = await repository.writeFile(
        editing.id,
        path,
        new Uint8Array(),
      );
      const files = await repository.listFiles(editing.id);
      setEditing(
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
      // writes are conditional on the one it was built with. Left alone, the
      // next keystroke would be reported to the user as "this project changed
      // elsewhere" — which it did, by us. Told rather than rebuilt, because a
      // rebuild drops anything typed while this was in flight.
      autosaveRef.current?.adopt(revision);
      setNewFileName("");
      await refresh();
    },
    [editing, repository, refresh],
  );

  /**
   * Rename the open file.
   *
   * One repository call rather than a write and a delete: the port makes it one
   * revision, so a tab that closes mid-rename leaves the project with one name
   * or the other and never with both.
   */
  const renameOpenFile = useCallback(
    async (name: string) => {
      if (!editing) return;
      const to = projectPath(name);
      if (to === editing.path) return;
      await autosaveRef.current?.flush();
      const revision = await repository.renameFile(
        editing.id,
        editing.path,
        to,
      );

      const files = await repository.listFiles(editing.id);
      const from = editing.path;
      setEditing((previous) => {
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
      setRenameTo("");
      await refresh();
    },
    [editing, repository, refresh],
  );

  const deleteFile = useCallback(
    async (path: ProjectPath) => {
      if (!editing) return;
      // The compile target is not deletable from here. A project whose main
      // file is missing cannot compile and offers no way back to one that can.
      if (path === editing.mainFile) {
        throw new Error(
          `${path} is this project's main file; it cannot be deleted here`,
        );
      }
      await autosaveRef.current?.flush();
      const revision = await repository.deleteFile(editing.id, path);
      const files = await repository.listFiles(editing.id);
      const next = path === editing.path ? editing.mainFile : editing.path;
      const opened = await readForEditing(repository, editing.id, next);
      setEditing((previous) => {
        if (!previous) return previous;
        const sources = { ...previous.sources };
        delete sources[path];
        return { ...previous, path: next, files, sources, ...opened };
      });
      setFocusFile(next);
      autosaveRef.current?.adopt(revision);
      await refresh();
    },
    [editing, repository, refresh],
  );

  /**
   * The project's cross-file structure, recomputed as it is typed.
   *
   * Cheap enough to do on every keystroke — the corpus's largest project
   * indexes in about a millisecond — so there is no debounce and no staleness
   * to reason about. The alternative, an incremental index, would need
   * invalidating correctly, and a wrong index is worse than a slow one.
   */
  const index = useMemo(() => {
    if (!editing) return null;
    return buildProjectIndex(
      Object.entries(editing.sources).map(([path, content]) => ({
        path: path as ProjectPath,
        content,
      })),
      editing.mainFile,
    );
  }, [editing]);

  /**
   * What to mark in the open file's gutter, from both sources at once.
   *
   * They answer different questions and a writer does not care which is which:
   * the engine knows what TeX could not do, the index knows what the project
   * does not contain, and neither is visible from the other. Index problems are
   * warnings even when they are certainly wrong — a missing `\label` compiles,
   * it just renders as `??` — while the engine's own severity is kept.
   */
  const editorProblems = useMemo<EditorProblem[]>(() => {
    if (!editing) return [];
    const fromIndex = (index?.problems ?? [])
      .filter((problem) => problem.file === editing.path)
      .map((problem) => ({
        line: problem.line,
        message: problem.message,
        severity: "warning" as const,
      }));
    const fromEngine = compiled.flatMap((diagnostic) =>
      // A diagnostic with no file is about the compile target, which is where
      // TeX was reading from; one with no line cannot be put in a gutter and
      // stays in the list under the compile button.
      diagnostic.line === undefined ||
      (diagnostic.file ?? editing.mainFile) !== editing.path
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
  }, [editing, index, compiled]);

  /** Open a file if it is not already open, then put the cursor on a line. */
  const goTo = useCallback(
    async (path: ProjectPath, line: number) => {
      if (editing && path !== editing.path) await openFile(path);
      // Counted rather than timestamped: two activations inside one millisecond
      // — a held Enter, a double click — would otherwise carry the same nonce
      // and the second jump would be dropped, which is the case the nonce is
      // there for.
      setReveal((previous) => ({ line, nonce: (previous?.nonce ?? 0) + 1 }));
    },
    [editing, openFile],
  );

  useEffect(() => {
    if (!focusFile) return;
    const button = fileList.current?.querySelector<HTMLButtonElement>(
      `[data-testid="file-open"][data-path="${CSS.escape(focusFile)}"]`,
    );
    button?.focus();
    setFocusFile(null);
  }, [focusFile]);

  // A tab closing mid-edit is exactly when a debounce is a liability.
  useEffect(() => {
    const flush = () => {
      void autosaveRef.current?.flush();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  return (
    <section data-testid="projects-panel">
      <h2>Projects</h2>
      <p className="lede">
        Stored on this device: file bytes in OPFS, metadata in IndexedDB.
        Nothing here is sent anywhere.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <input
          data-testid="project-title"
          aria-label="New project title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
        {/*
          Beside the title rather than behind a wizard: choosing a starting
          point is one decision, and a second screen to make it would be a
          second screen between a person and their document.
        */}
        <label>
          Start from{" "}
          <select
            data-testid="project-template"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
          >
            {PROJECT_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="create-project"
          onClick={() => {
            const template = templateById(templateId);
            void act(() =>
              repository.create({
                title,
                files: template.files,
                rootTexPath: template.rootTexPath,
              }),
            );
          }}
        >
          Create project
        </button>
        <label className="file-button">
          Import ZIP
          <input
            ref={importInput}
            type="file"
            accept=".zip,application/zip"
            data-testid="import-archive"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void act(async () => {
                try {
                  await importArchive(file);
                } finally {
                  // Cleared either way, so importing the same file twice after
                  // fixing it still fires a change event.
                  if (importInput.current) importInput.current.value = "";
                }
              });
            }}
          />
        </label>
      </div>

      {/*
        `alert` rather than `status`: this is the result of something the user
        just asked for and it is always a refusal — a rejected archive, a rename
        onto a name already taken — so it interrupts rather than waiting for a
        pause.
      */}
      {error && (
        <div className="banner bad" role="alert" data-testid="projects-error">
          {error}
        </div>
      )}

      {projects === null ? (
        <p>Reading storage…</p>
      ) : projects.length === 0 ? (
        <p data-testid="projects-empty">No projects yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Files</th>
              <th>Size</th>
              <th>Revision</th>
              <th>Last opened</th>
              <th />
            </tr>
          </thead>
          <tbody data-testid="projects-list">
            {projects.map((project) => (
              <tr key={project.id} data-testid="project-row">
                <td data-testid="project-row-title">{project.title}</td>
                <td className="note">{project.fileCount}</td>
                <td className="note">{project.byteSize} B</td>
                <td className="note" data-testid="project-row-revision">
                  {project.revision}
                </td>
                <td className="note">{when(project.lastOpenedAt)}</td>
                <td>
                  <button
                    type="button"
                    data-testid="open-project"
                    onClick={() => {
                      void act(() => openForEditing(project.id));
                    }}
                  >
                    Open
                  </button>{" "}
                  <button
                    type="button"
                    data-testid="export-project"
                    onClick={() => {
                      void act(() => exportProject(project.id, project.title));
                    }}
                  >
                    Export ZIP
                  </button>{" "}
                  <button
                    type="button"
                    data-testid="delete-project"
                    onClick={() => {
                      void act(() => repository.delete(project.id));
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div style={{ marginTop: "0.75rem" }} data-testid="editor">
          {/*
            A flat list rather than a tree. Every corpus project is flat, the
            archive format allows nested paths and nothing yet creates them, so
            a tree here would be scaffolding for a shape no project has. It
            becomes a tree the day a project has a directory in it.
          */}
          <div
            ref={fileList}
            data-testid="file-list"
            style={{ marginBottom: "0.5rem" }}
          >
            {editing.files.map((path) => (
              <span key={path} style={{ marginRight: "0.5rem" }}>
                <button
                  type="button"
                  data-testid="file-open"
                  data-path={path}
                  aria-current={path === editing.path ? "true" : undefined}
                  style={{
                    fontWeight: path === editing.path ? "bold" : "normal",
                  }}
                  aria-label={
                    path === editing.mainFile ? `${path}, main file` : path
                  }
                  onClick={() => {
                    void act(() => openFile(path));
                  }}
                >
                  {path}
                  {/* A star is a picture of "main file" and says nothing out
                      loud, so the name above carries it instead. */}
                  {path === editing.mainFile ? " ★" : ""}
                </button>
                {path !== editing.mainFile && (
                  <button
                    type="button"
                    data-testid="file-delete"
                    data-path={path}
                    aria-label={`Delete ${path}`}
                    onClick={() => {
                      void act(() => deleteFile(path));
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>

          <form
            style={{ marginBottom: "0.5rem" }}
            onSubmit={(event) => {
              event.preventDefault();
              const name = newFileName.trim();
              if (name) void act(() => createFile(name));
            }}
          >
            <input
              data-testid="new-file-name"
              aria-label="New file name"
              value={newFileName}
              placeholder="chapter.tex"
              onChange={(event) => setNewFileName(event.target.value)}
            />{" "}
            <button type="submit" data-testid="create-file">
              Add file
            </button>
          </form>

          {index && index.problems.length > 0 && (
            <details data-testid="project-health" open>
              {/*
                Open by default and above the editor, unlike the compiler's
                diagnostics: these are answers to questions a person cannot
                check by looking — whether a `\ref` resolves anywhere in the
                project — and they are available without compiling at all.
              */}
              <summary>
                Project health: {index.problems.length}{" "}
                {index.problems.length === 1 ? "problem" : "problems"}
              </summary>
              <ul>
                {index.problems.slice(0, 50).map((problem) => (
                  <li
                    key={`${problem.kind}:${problem.file}:${problem.line}:${problem.subject}`}
                    className="optional-missing"
                  >
                    <button
                      type="button"
                      data-testid="problem-go-to"
                      onClick={() => {
                        void act(() => goTo(problem.file, problem.line));
                      }}
                    >
                      {problem.file}:{problem.line}
                    </button>{" "}
                    {problem.message}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {index && index.outline.length > 0 && (
            <details data-testid="outline">
              <summary>Outline ({index.outline.length})</summary>
              <ul style={{ listStyle: "none", paddingLeft: 0 }}>
                {index.outline.map((entry) => (
                  <li
                    key={`${entry.file}:${entry.line}:${entry.title}`}
                    // Indented by sectioning level, which is the only thing an
                    // outline has to get right to be readable.
                    style={{ paddingLeft: `${entry.level * 0.75}rem` }}
                  >
                    <button
                      type="button"
                      data-testid="outline-entry"
                      data-level={entry.level}
                      onClick={() => {
                        void act(() => goTo(entry.file, entry.line));
                      }}
                    >
                      {entry.title || "(untitled)"}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <h3 style={{ marginBottom: "0.25rem" }}>
            {editing.path}{" "}
            <form
              style={{ display: "inline" }}
              onSubmit={(event) => {
                event.preventDefault();
                const name = renameTo.trim();
                if (name) void act(() => renameOpenFile(name));
              }}
            >
              <input
                data-testid="rename-to"
                aria-label={`Rename ${editing.path} to`}
                value={renameTo}
                placeholder={editing.path}
                style={{ fontSize: "0.8rem" }}
                onChange={(event) => setRenameTo(event.target.value)}
              />{" "}
              <button
                type="submit"
                data-testid="rename-file"
                style={{ fontSize: "0.8rem" }}
              >
                Rename
              </button>
            </form>
          </h3>
          {/*
            A binary file never reaches the text editor. Decoding one as
            UTF-8 to show it would also be what autosave writes back.
          */}
          {editing.asset ? (
            <AssetView
              key={`${editing.id}:${editing.path}`}
              path={editing.path}
              bytes={editing.asset}
            />
          ) : (
            <CodeEditor
              key={`${editing.id}:${editing.path}`}
              label={`Contents of ${editing.path}`}
              completions={{
                labels: [...(index?.labels.keys() ?? [])],
                citations: [...(index?.bibliographyKeys ?? [])],
              }}
              problems={editorProblems}
              onSubmit={() => setCompileSignal((signal) => signal + 1)}
              value={editing.content}
              reveal={reveal}
              onChange={(content) => {
                setEditing({
                  ...editing,
                  content,
                  sources: { ...editing.sources, [editing.path]: content },
                });
                autosaveRef.current?.queue(
                  editing.path,
                  new TextEncoder().encode(content),
                );
              }}
            />
          )}
          {/*
            Polite: autosave is continuous, and a save announced over the top of
            what someone is typing would be worse than silence. PLAN.md 13.1
            asks for save, compile and error to be audible, and these are the
            three regions that carry them.
          */}
          <p className="note" role="status" data-testid="save-status">
            {saveStatus?.state === "conflict"
              ? `Not saved: this project changed elsewhere (revision ${saveStatus.actualRevision}, this tab has ${saveStatus.revision}). Reopen it to continue.`
              : saveStatus?.state === "failed"
                ? `Not saved: ${saveStatus.message}`
                : saveStatus?.state === "saving"
                  ? "Saving…"
                  : saveStatus?.state === "pending"
                    ? "Unsaved changes"
                    : saveStatus?.state === "saved"
                      ? `Saved at revision ${saveStatus.revision}`
                      : "No unsaved changes"}
          </p>

          {/*
            Keyed on the project so opening another one builds a new session
            rather than pointing the old engine and the old PDF at new files.
          */}
          <Workspace
            key={editing.id}
            repository={repository}
            projectId={editing.id}
            mainFile={editing.mainFile}
            openPath={editing.path}
            content={editing.content}
            onDiagnostics={setCompiled}
            compileSignal={compileSignal}
            onClose={() => {
              setEditing(null);
            }}
          />
        </div>
      )}

      {status && (
        <p className="note" data-testid="storage-status">
          {status.persisted === null
            ? "Persistence unknown."
            : status.persisted
              ? "Storage is persistent: the browser will not evict these projects silently."
              : "Storage is not persistent — the browser may evict these projects under pressure."}{" "}
          {status.usageBytes !== null &&
            status.quotaBytes !== null &&
            `Using ${megabytes(status.usageBytes)} of ${megabytes(status.quotaBytes)}.`}{" "}
          {status.persisted === false &&
            typeof navigator.storage?.persist === "function" && (
              <button
                type="button"
                data-testid="request-persistence"
                onClick={() => {
                  // Only from a user gesture: browsers refuse or prompt, and a
                  // prompt the user did not ask for is one they will dismiss.
                  void act(async () => {
                    await navigator.storage.persist();
                  });
                }}
              >
                Request persistent storage
              </button>
            )}
        </p>
      )}
    </section>
  );
}
