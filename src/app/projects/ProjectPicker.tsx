import {
  FilePlusIcon,
  HardDriveIcon,
  ImportIcon,
  PackageIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WifiOffIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import type { ProjectId } from "@/core/project/ids";
import type { ProjectSummary } from "@/core/project/repository";
import { PROJECT_TEMPLATES } from "@/core/project/templates";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

/**
 * The screen with no project open (desktop's `ProjectPicker`).
 *
 * It answers the two questions someone arriving has — what have I got, and how
 * do I start something — and states the product's one claim, which is that
 * none of it leaves the device.
 */

export interface StorageStatus {
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
}

interface ProjectPickerProps {
  projects: ProjectSummary[] | null;
  status: StorageStatus | null;
  error: string | null;
  onCreate: (title: string, templateId: string) => void;
  onImport: (file: File) => void;
  onOpen: (id: ProjectId) => void;
  onExport: (id: ProjectId, title: string) => void;
  onDelete: (id: ProjectId) => void;
  onRequestPersistence: () => void;
}

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

export function ProjectPicker({
  projects,
  status,
  error,
  onCreate,
  onImport,
  onOpen,
  onExport,
  onDelete,
  onRequestPersistence,
}: ProjectPickerProps) {
  const [title, setTitle] = useState("Untitled project");
  const [templateId, setTemplateId] = useState("blank");
  const importInput = useRef<HTMLInputElement | null>(null);

  return (
    <div
      data-testid="projects-panel"
      className="min-h-dvh overflow-y-auto bg-background"
    >
      <main className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-10 px-6 py-12 lg:grid-cols-[1fr_1fr] lg:items-start">
        <section className="max-w-xl">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary font-serif text-lg text-primary-foreground shadow-sm">
              O
            </span>
            <div>
              <div className="font-semibold text-sm tracking-tight">Opal</div>
              <div className="text-muted-foreground text-xs">Web</div>
            </div>
          </div>

          <h1 className="max-w-lg font-serif text-4xl leading-[1.08] tracking-[-0.025em]">
            Write LaTeX in the browser.
            <span className="block text-muted-foreground">
              Nothing leaves this device.
            </span>
          </h1>
          <p className="mt-5 max-w-lg text-muted-foreground text-sm leading-6">
            Projects are stored in this browser — file bytes in OPFS, metadata
            in IndexedDB — and the TeX engine runs here too, on a worker. There
            is no account and no server to send a document to.
          </p>

          <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-muted-foreground text-xs">
            <span className="flex items-center gap-1.5">
              <WifiOffIcon className="size-3.5 text-primary" />
              Compiles offline
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheckIcon className="size-3.5 text-primary" />
              No document leaves the device
            </span>
            <span className="flex items-center gap-1.5">
              <PackageIcon className="size-3.5 text-primary" />
              ZIP in and out
            </span>
          </div>

          {status && (
            <p
              data-testid="storage-status"
              className="mt-8 flex flex-wrap items-center gap-2 text-muted-foreground text-xs"
            >
              <HardDriveIcon className="size-3.5" />
              {status.persisted === null
                ? "Persistence unknown."
                : status.persisted
                  ? "Storage is persistent: the browser will not evict these projects silently."
                  : "Storage is not persistent — the browser may evict these projects under pressure."}{" "}
              {status.usageBytes !== null &&
                status.quotaBytes !== null &&
                `Using ${megabytes(status.usageBytes)} of ${megabytes(status.quotaBytes)}.`}
              {status.persisted === false &&
                typeof navigator.storage?.persist === "function" && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="request-persistence"
                    className="h-6 px-2 text-xs"
                    // Only from a user gesture: browsers refuse or prompt, and
                    // a prompt the user did not ask for is one they dismiss.
                    onClick={onRequestPersistence}
                  >
                    Make storage persistent
                  </Button>
                )}
            </p>
          )}
        </section>

        <section className="rounded-3xl border border-border/80 bg-card/90 p-4 shadow-sm">
          {error && (
            <div
              role="alert"
              data-testid="projects-error"
              className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-xs"
            >
              {error}
            </div>
          )}

          <form
            className="flex flex-col gap-2 rounded-xl border border-border/70 bg-background/60 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              onCreate(title, templateId);
            }}
          >
            <Input
              data-testid="project-title"
              aria-label="New project title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="flex gap-2">
              {/*
                Beside the title rather than behind a wizard: choosing a
                starting point is one decision, and a second screen to make it
                would be a second screen between a person and their document.
              */}
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger
                  data-testid="project-template"
                  aria-label="Start from"
                  className="flex-1"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROJECT_TEMPLATES.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="submit"
                data-testid="create-project"
                className="gap-1.5"
              >
                <FilePlusIcon className="size-4" />
                Create
              </Button>
            </div>
          </form>

          <label className="group mt-2 flex w-full cursor-pointer items-center gap-3 rounded-xl border border-border/70 bg-background/45 px-3 py-2.5 text-left transition-colors hover:bg-muted/70">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <ImportIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-sm">Import a ZIP</span>
              <span className="block text-muted-foreground text-xs">
                A project exported from Opal, or any folder of `.tex` files
              </span>
            </span>
            <input
              ref={importInput}
              type="file"
              accept=".zip,application/zip"
              data-testid="import-archive"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                onImport(file);
                // Cleared, so importing the same file twice after fixing it
                // still fires a change event.
                if (importInput.current) importInput.current.value = "";
              }}
            />
          </label>

          <div className="mt-4">
            <h2 className="px-1 pb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Your projects
            </h2>
            {projects === null ? (
              <p className="px-1 text-muted-foreground text-sm">
                Reading storage…
              </p>
            ) : projects.length === 0 ? (
              <p
                data-testid="projects-empty"
                className="px-1 text-muted-foreground text-sm"
              >
                No projects yet.
              </p>
            ) : (
              <ul data-testid="projects-list" className="space-y-1">
                {projects.map((project) => (
                  <li
                    key={project.id}
                    data-testid="project-row"
                    className="group flex items-center gap-2 rounded-xl border border-border/70 bg-background/45 px-3 py-2 transition-colors hover:bg-muted/60"
                  >
                    <button
                      type="button"
                      data-testid="open-project"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => onOpen(project.id)}
                    >
                      <span
                        data-testid="project-row-title"
                        className="block truncate font-medium text-sm"
                      >
                        {project.title}
                      </span>
                      <span className="block text-muted-foreground text-xs">
                        {project.fileCount}{" "}
                        {project.fileCount === 1 ? "file" : "files"} ·{" "}
                        {project.byteSize} B · revision{" "}
                        <span data-testid="project-row-revision">
                          {project.revision}
                        </span>{" "}
                        · {when(project.lastOpenedAt)}
                      </span>
                    </button>
                    <Button
                      size="icon"
                      variant="ghost"
                      data-testid="export-project"
                      title={`Export ${project.title} as ZIP`}
                      aria-label={`Export ${project.title} as ZIP`}
                      className="size-8 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => onExport(project.id, project.title)}
                    >
                      <PackageIcon className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      data-testid="delete-project"
                      title={`Delete ${project.title}`}
                      aria-label={`Delete ${project.title}`}
                      className="size-8 text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => onDelete(project.id)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
