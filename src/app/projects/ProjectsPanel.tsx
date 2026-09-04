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

import { useCallback, useEffect, useRef, useState } from "react";
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

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** A starter document, so a new project compiles rather than being empty. */
const STARTER = `\\documentclass{article}
\\begin{document}
Hello from Opal Web.
\\end{document}
`;

export function ProjectsPanel({
  repository,
}: {
  repository: ProjectRepository;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled project");
  const importInput = useRef<HTMLInputElement | null>(null);
  const [editing, setEditing] = useState<{
    id: ProjectId;
    path: ProjectPath;
    content: string;
  } | null>(null);
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
   * Open a project's main file for editing.
   *
   * The autosave scheduler is rebuilt per open because it holds the revision
   * this session is writing against, and carrying one over from a different
   * project would make its conditional writes meaningless.
   */
  const openForEditing = useCallback(
    async (id: ProjectId) => {
      await autosaveRef.current?.flush();
      autosaveRef.current?.stop();

      const record = await repository.open(id);
      const path = record.rootTexPath ?? (await repository.listFiles(id))[0];
      if (!path) {
        setEditing(null);
        return;
      }
      const content = new TextDecoder().decode(
        await repository.readFile(id, path),
      );
      setEditing({ id, path, content });
      setSaveStatus({ state: "idle", revision: record.revision });
      autosaveRef.current = createAutosave({
        repository,
        projectId: id,
        revision: record.revision,
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
        <button
          type="button"
          data-testid="create-project"
          onClick={() => {
            void act(() =>
              repository.create({
                title,
                files: [
                  {
                    path: projectPath("main.tex"),
                    bytes: new TextEncoder().encode(STARTER),
                  },
                ],
                rootTexPath: projectPath("main.tex"),
              }),
            );
          }}
        >
          Create project
        </button>
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
      </div>

      {error && (
        <div className="banner bad" data-testid="projects-error">
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
                <td className="note">{project.lastOpenedAt}</td>
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
          <h3 style={{ marginBottom: "0.25rem" }}>{editing.path}</h3>
          <textarea
            data-testid="editor-content"
            aria-label={`Contents of ${editing.path}`}
            value={editing.content}
            rows={8}
            style={{ width: "100%", fontFamily: "monospace" }}
            onChange={(event) => {
              const content = event.target.value;
              setEditing({ ...editing, content });
              autosaveRef.current?.queue(
                editing.path,
                new TextEncoder().encode(content),
              );
            }}
          />
          <p className="note" data-testid="save-status">
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
