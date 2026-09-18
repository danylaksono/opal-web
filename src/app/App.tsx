import { ThemeProvider } from "next-themes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { HarnessPage } from "@/app/harness/HarnessPage";
import {
  ProjectPicker,
  type StorageStatus,
} from "@/app/projects/ProjectPicker";
import { WorkspaceScreen } from "@/app/workspace/WorkspaceScreen";
import {
  ArchiveRejectedError,
  packProject,
  unpackProject,
} from "@/core/project/archive";
import type { ProjectId } from "@/core/project/ids";
import type {
  ProjectRepository,
  ProjectSummary,
} from "@/core/project/repository";
import { templateById } from "@/core/project/templates";
import { OpfsProjectRepository } from "@/platform/browser/storage/opfs-project-repository";

/**
 * The application: a project picker, or a project open in the workspace.
 *
 * Opal Web is an adaptation of the Opal desktop editor, so the shell is the
 * desktop's — activity rail, side panel, editor, preview, status bar — rather
 * than a page of panels. What differs is what the browser makes different:
 * storage is OPFS instead of a directory, and there is no window chrome to
 * account for.
 *
 * The Phase 0 harness that used to be this page now lives at `?harness=1`.
 */

/**
 * One repository for the app's lifetime.
 *
 * It owns an IndexedDB connection, and a second instance would open a second
 * one for no benefit. Constructed at module scope rather than in a hook so that
 * a re-render cannot quietly create another.
 */
const repository: ProjectRepository = new OpfsProjectRepository();

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

function harnessRequested(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("harness");
}

export function App() {
  const harness = useMemo(harnessRequested, []);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<ProjectId | null>(null);

  /**
   * Re-read the list.
   *
   * Reports its own failure but never clears someone else's: `act` runs this
   * after every action, and a `setError(null)` here would wipe the message the
   * action had just set.
   */
  const refresh = useCallback(async () => {
    try {
      setProjects(await repository.list());
      setStatus(await readStorageStatus());
    } catch (cause) {
      // A storage layer that cannot list is the one failure this must not
      // hide: everything else the app offers would silently do nothing.
      setError(cause instanceof Error ? cause.message : "Storage unavailable");
      setProjects([]);
    }
  }, []);

  /** A stable callback, so the workspace is not rebuilt on every render. */
  const refreshList = useCallback(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (harness) return;
    void refresh();
  }, [refresh, harness]);

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
    [],
  );

  const importArchive = useCallback(async (file: File) => {
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
  }, []);

  const openProject = projects?.find((project) => project.id === openId);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      {harness ? (
        <HarnessPage />
      ) : openId && openProject ? (
        <ErrorBoundary label="Workspace">
          <WorkspaceScreen
            key={openId}
            repository={repository}
            projectId={openId}
            title={openProject.title}
            onClose={() => setOpenId(null)}
            onExport={() =>
              void act(() => exportProject(openId, openProject.title))
            }
            onChanged={refreshList}
          />
        </ErrorBoundary>
      ) : (
        <ErrorBoundary label="Projects">
          <ProjectPicker
            projects={projects}
            status={status}
            error={error}
            onCreate={(title, templateId) => {
              const template = templateById(templateId);
              void act(() =>
                repository.create({
                  title,
                  files: template.files,
                  rootTexPath: template.rootTexPath,
                }),
              );
            }}
            onImport={(file) => void act(() => importArchive(file))}
            onOpen={(id) => {
              setOpenId(id);
              void act(() => repository.open(id));
            }}
            onExport={(id, title) => void act(() => exportProject(id, title))}
            onDelete={(id) => void act(() => repository.delete(id))}
            onRequestPersistence={() =>
              void act(async () => {
                await navigator.storage.persist();
              })
            }
          />
        </ErrorBoundary>
      )}
    </ThemeProvider>
  );
}
