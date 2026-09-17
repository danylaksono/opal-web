import {
  AlertTriangleIcon,
  CircleCheckIcon,
  CircleXIcon,
  HardDriveIcon,
  Loader2Icon,
} from "lucide-react";
import type { CompileState } from "@/app/workspace/compile-session";
import type { SaveStatus } from "@/core/project/autosave";
import type { ProjectPath } from "@/core/project/ids";

/**
 * The strip along the bottom: what is open, whether it is saved, whether it
 * compiles (desktop's `status-bar`).
 *
 * Everything here was on the page before as a paragraph of prose. A status bar
 * says the same things in the place a person already looks for them, and
 * — because it is always visible — it is where save and compile state belong
 * rather than in a region that scrolls away.
 */

interface StatusBarProps {
  openPath: ProjectPath;
  mainFile: ProjectPath;
  content: string;
  saveStatus: SaveStatus | null;
  compile: CompileState;
  errors: number;
  warnings: number;
  onShowProblems: () => void;
}

function words(text: string): number {
  // Commands are not words a person counts; neither is the maths between `$`.
  const prose = text
    .replace(/%[^\n]*/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^}]*\})?/g, " ");
  return prose.split(/[\s~]+/).filter((word) => /[a-zA-Z0-9]/.test(word))
    .length;
}

function saveLabel(status: SaveStatus | null): string {
  switch (status?.state) {
    case "conflict":
      return `Not saved — changed elsewhere (revision ${status.actualRevision})`;
    case "failed":
      return `Not saved: ${status.message}`;
    case "saving":
      return "Saving…";
    case "pending":
      return "Unsaved changes";
    case "saved":
      return `Saved · revision ${status.revision}`;
    default:
      return "No unsaved changes";
  }
}

export function StatusBar({
  openPath,
  mainFile,
  content,
  saveStatus,
  compile,
  errors,
  warnings,
  onShowProblems,
}: StatusBarProps) {
  const result = compile.status === "done" ? compile.result : null;
  const unsaved =
    saveStatus?.state === "conflict" || saveStatus?.state === "failed";

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 overflow-x-auto border-sidebar-border border-t bg-sidebar px-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        {compile.status === "compiling" ? (
          <>
            <Loader2Icon className="size-3 animate-spin" />
            Compiling…
          </>
        ) : result && !result.ok ? (
          <span className="flex items-center gap-1.5 text-destructive">
            <CircleXIcon className="size-3" />
            Compile failed
          </span>
        ) : result?.ok ? (
          <>
            <CircleCheckIcon className="size-3 text-emerald-500" />
            Compiled in {Math.round(result.durationMs)} ms
          </>
        ) : (
          <>
            <CircleCheckIcon className="size-3 opacity-40" />
            Not compiled yet
          </>
        )}
      </span>

      {(errors > 0 || warnings > 0) && (
        <button
          type="button"
          data-testid="status-problems"
          className="flex items-center gap-2 rounded px-1 hover:bg-sidebar-accent"
          onClick={onShowProblems}
          title="Show project health"
        >
          {errors > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              <CircleXIcon className="size-3" />
              {errors}
            </span>
          )}
          {warnings > 0 && (
            <span className="flex items-center gap-1 text-amber-500">
              <AlertTriangleIcon className="size-3" />
              {warnings}
            </span>
          )}
        </button>
      )}

      <span className="ml-auto flex items-center gap-3">
        <span data-testid="status-words">{words(content)} words</span>
        {/*
          Named, because "saved" on this product means "in this browser's
          storage on this device" and nowhere else.
        */}
        <span
          role="status"
          data-testid="save-status"
          className={`flex items-center gap-1.5 ${unsaved ? "text-destructive" : ""}`}
        >
          <HardDriveIcon className="size-3" />
          {saveLabel(saveStatus)}
        </span>
        <span data-testid="status-file" className="truncate">
          {openPath}
          {openPath === mainFile ? " · main" : ""}
        </span>
      </span>
    </div>
  );
}
