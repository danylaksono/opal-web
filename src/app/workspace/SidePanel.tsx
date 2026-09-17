import {
  AlertTriangleIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  PlusIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import type { SidePanel as SidePanelId } from "@/app/store/layout-store";
import type { ProjectIndex } from "@/core/latex/project-index";
import type { ProjectPath } from "@/core/project/ids";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { cn } from "@/ui/utils";

/**
 * The panel beside the rail: the project's files, its outline, its health
 * (desktop's `Sidebar`).
 *
 * These were three stacked `<details>` above the editor, which meant a person
 * scrolled past the project's structure to reach the document. In a panel they
 * are one click each and never in the way.
 */

interface SidePanelProps {
  panel: SidePanelId;
  files: readonly ProjectPath[];
  openPath: ProjectPath;
  mainFile: ProjectPath;
  index: ProjectIndex | null;
  onOpenFile: (path: ProjectPath) => void;
  onCreateFile: (name: string) => void;
  onRenameFile: (name: string) => void;
  onDeleteFile: (path: ProjectPath) => void;
  onGoTo: (path: ProjectPath, line: number) => void;
  /** Set on delete, so focus lands on a file that still exists. */
  focusFile: ProjectPath | null;
  onFocused: () => void;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

function FileGlyph({ path }: { path: string }) {
  if (IMAGE.test(path)) return <ImageIcon className="size-3.5 shrink-0" />;
  if (/\.(tex|ltx|cls|sty|bib)$/i.test(path)) {
    return <FileTextIcon className="size-3.5 shrink-0" />;
  }
  return <FileIcon className="size-3.5 shrink-0" />;
}

function PanelHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center px-3 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
      {children}
    </div>
  );
}

export function SidePanel({
  panel,
  files,
  openPath,
  mainFile,
  index,
  onOpenFile,
  onCreateFile,
  onRenameFile,
  onDeleteFile,
  onGoTo,
  focusFile,
  onFocused,
}: SidePanelProps) {
  const [newFileName, setNewFileName] = useState("");
  const [renameTo, setRenameTo] = useState("");

  if (panel === "files") {
    return (
      <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
        <PanelHeading>Files</PanelHeading>
        <div
          data-testid="file-list"
          className="min-h-0 flex-1 overflow-y-auto px-1"
        >
          {files.map((path) => {
            const active = path === openPath;
            return (
              <div key={path} className="group/file flex items-center">
                <button
                  type="button"
                  data-testid="file-open"
                  data-path={path}
                  aria-current={active ? "true" : undefined}
                  aria-label={path === mainFile ? `${path}, main file` : path}
                  ref={
                    focusFile === path
                      ? (node) => {
                          node?.focus();
                          onFocused();
                        }
                      : undefined
                  }
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    active &&
                      "bg-sidebar-accent text-sidebar-accent-foreground",
                  )}
                  onClick={() => onOpenFile(path)}
                >
                  <FileGlyph path={path} />
                  <span className="truncate">{path}</span>
                  {/* The star is decoration; the name above carries the word. */}
                  {path === mainFile && (
                    <StarIcon
                      aria-hidden="true"
                      className="ml-auto size-3 shrink-0 fill-amber-400 text-amber-500"
                    />
                  )}
                </button>
                {path !== mainFile && (
                  <button
                    type="button"
                    data-testid="file-delete"
                    data-path={path}
                    aria-label={`Delete ${path}`}
                    className="mr-1 rounded p-1 text-muted-foreground opacity-0 hover:bg-sidebar-accent hover:text-destructive focus-visible:opacity-100 group-hover/file:opacity-100"
                    onClick={() => onDeleteFile(path)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="shrink-0 space-y-2 border-sidebar-border border-t p-2">
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newFileName.trim();
              if (!name) return;
              onCreateFile(name);
              setNewFileName("");
            }}
          >
            <Input
              data-testid="new-file-name"
              aria-label="New file name"
              value={newFileName}
              placeholder="chapter.tex"
              className="h-7 text-xs"
              onChange={(event) => setNewFileName(event.target.value)}
            />
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              data-testid="create-file"
              title="Add file"
              aria-label="Add file"
              className="size-7 shrink-0"
            >
              <PlusIcon className="size-4" />
            </Button>
          </form>
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const name = renameTo.trim();
              if (!name) return;
              onRenameFile(name);
              setRenameTo("");
            }}
          >
            <Input
              data-testid="rename-to"
              aria-label={`Rename ${openPath} to`}
              value={renameTo}
              placeholder={`Rename ${openPath}`}
              className="h-7 text-xs"
              onChange={(event) => setRenameTo(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="ghost"
              data-testid="rename-file"
              className="h-7 shrink-0 px-2 text-xs"
            >
              Rename
            </Button>
          </form>
        </div>
      </div>
    );
  }

  if (panel === "outline") {
    const outline = index?.outline ?? [];
    return (
      <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
        <PanelHeading>Outline</PanelHeading>
        <div
          data-testid="outline"
          className="min-h-0 flex-1 overflow-y-auto px-1 pb-2"
        >
          {outline.length === 0 ? (
            <p className="px-2 py-1 text-muted-foreground text-xs">
              No sections yet.
            </p>
          ) : (
            outline.map((entry) => (
              <button
                key={`${entry.file}:${entry.line}:${entry.title}`}
                type="button"
                data-testid="outline-entry"
                data-level={entry.level}
                // Indented by sectioning level, which is the only thing an
                // outline has to get right to be readable.
                style={{ paddingLeft: `${0.5 + entry.level * 0.6}rem` }}
                className="block w-full truncate rounded-md py-1 pr-2 text-left text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                onClick={() => onGoTo(entry.file, entry.line)}
              >
                {entry.title || "(untitled)"}
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  const problems = index?.problems ?? [];
  return (
    <div
      data-testid="project-health"
      className="flex h-full flex-col bg-sidebar text-sidebar-foreground"
    >
      <PanelHeading>
        Project health
        {problems.length > 0 && (
          <span className="ml-2 text-amber-500 normal-case">
            {problems.length} {problems.length === 1 ? "problem" : "problems"}
          </span>
        )}
      </PanelHeading>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {problems.length === 0 ? (
          <p className="px-1 py-1 text-muted-foreground text-xs">
            Nothing to report: every reference, citation, input and figure
            resolves. This is checked as you type, without compiling.
          </p>
        ) : (
          <ul className="space-y-1">
            {problems.slice(0, 50).map((problem) => (
              <li
                key={`${problem.kind}:${problem.file}:${problem.line}:${problem.subject}`}
                className="text-xs"
              >
                <button
                  type="button"
                  data-testid="problem-go-to"
                  className="flex w-full items-start gap-1.5 rounded-md px-1 py-1 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  onClick={() => onGoTo(problem.file, problem.line)}
                >
                  <AlertTriangleIcon className="mt-0.5 size-3 shrink-0 text-amber-500" />
                  <span className="min-w-0">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {problem.file}:{problem.line}
                    </span>{" "}
                    {problem.message}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
