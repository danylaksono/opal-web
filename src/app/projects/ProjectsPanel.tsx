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

import { useCallback, useEffect, useState } from "react";
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

  const refresh = useCallback(async () => {
    try {
      setProjects(await repository.list());
      setStatus(await readStorageStatus());
      setError(null);
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
      try {
        await work();
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Storage refused");
      }
      await refresh();
    },
    [refresh],
  );

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
                      void act(() => repository.open(project.id));
                    }}
                  >
                    Open
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
