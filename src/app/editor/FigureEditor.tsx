import { ImageIcon, Loader2Icon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Figure, writeFigure } from "@/core/latex/figure";
import type { ProjectPath } from "@/core/project/ids";
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
 * A figure as a form (investigation.md 14, Phase 3: structured editors).
 *
 * Desktop's figure picker, adapted. The five fields are the ones a person
 * actually decides; everything else in the environment is left alone, because
 * the reader edits in place rather than regenerating.
 *
 * The image list is the project's own files, and the path written is the path
 * the file list gives — which is what makes the project-health check agree
 * with what compiles. A project with no images yet is the ordinary case for a
 * new document, so importing one is part of this form rather than somewhere
 * else.
 */

const PLACEMENTS = [
  { value: "htbp", label: "Wherever it fits (htbp)" },
  { value: "h", label: "Here (h)" },
  { value: "t", label: "Top of a page (t)" },
  { value: "b", label: "Bottom of a page (b)" },
  { value: "p", label: "Its own page (p)" },
] as const;

/** The value the list uses for "the environment has no `[...]`". */
const NO_PLACEMENT = "none";

interface FigureEditorProps {
  figure: Figure;
  /** The project's image files, in the spelling the file list uses. */
  images: readonly ProjectPath[];
  /** Writes an image into the project and answers with its path. */
  onImport: (file: File) => Promise<ProjectPath>;
  onApply: (figure: Figure) => void;
  onCancel: () => void;
}

export function FigureEditor({
  figure,
  images,
  onImport,
  onApply,
  onCancel,
}: FigureEditorProps) {
  const [draft, setDraft] = useState(figure);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  /** The image is the one field without which the figure means nothing. */
  const ready = draft.path.trim().length > 0;

  return (
    <fieldset
      data-testid="figure-editor"
      className="rounded-lg border bg-card p-3 text-card-foreground shadow-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (
          event.key === "Enter" &&
          (event.ctrlKey || event.metaKey) &&
          ready
        ) {
          event.preventDefault();
          onApply(draft);
        }
      }}
    >
      <legend className="px-1 font-medium text-sm">Figure</legend>

      <div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <label htmlFor="figure-image">Image</label>
        <Select
          value={draft.path}
          onValueChange={(path) => setDraft({ ...draft, path })}
        >
          <SelectTrigger
            id="figure-image"
            data-testid="figure-image"
            className="h-7 min-w-56 font-mono text-xs"
          >
            <SelectValue placeholder="Choose a project image" />
          </SelectTrigger>
          <SelectContent>
            {images.map((path) => (
              <SelectItem key={path} value={path} className="font-mono">
                <span className="flex items-center gap-2">
                  <ImageIcon className="size-3.5" />
                  {path}
                </span>
              </SelectItem>
            ))}
            {/*
              A figure can name an image the project does not have yet — TeX
              resolves it at compile time — so an existing path is kept as an
              option rather than silently cleared.
            */}
            {draft.path && !images.includes(draft.path as ProjectPath) && (
              <SelectItem value={draft.path} className="font-mono">
                {draft.path} (not in this project)
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <Button
          ref={first}
          variant="outline"
          size="sm"
          data-testid="figure-import"
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={importing}
          onClick={() => fileInput.current?.click()}
        >
          {importing ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <UploadIcon className="size-3.5" />
          )}
          Import image
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf"
          data-testid="figure-file"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setImporting(true);
            setNotice(null);
            void onImport(file)
              .then((path) => setDraft((previous) => ({ ...previous, path })))
              .catch((cause: unknown) =>
                setNotice(
                  cause instanceof Error ? cause.message : "Import refused",
                ),
              )
              .finally(() => {
                setImporting(false);
                // Cleared, so importing the same file twice still fires.
                if (fileInput.current) fileInput.current.value = "";
              });
          }}
        />
      </div>

      {images.length === 0 && !draft.path && (
        <p className="mb-2 text-muted-foreground text-xs">
          This project has no images yet. Import one, or bring a project in as a
          ZIP with its figures.
        </p>
      )}

      {notice && (
        <p
          role="alert"
          data-testid="figure-notice"
          className="mb-2 text-destructive text-xs"
        >
          {notice}
        </p>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <label htmlFor="figure-caption">Caption</label>
        <Input
          id="figure-caption"
          data-testid="figure-caption"
          value={draft.caption}
          placeholder="What the reader is looking at"
          className="h-7 min-w-56 flex-1 text-xs"
          onChange={(event) =>
            setDraft({ ...draft, caption: event.target.value })
          }
        />
        <label htmlFor="figure-label">Label</label>
        <Input
          id="figure-label"
          data-testid="figure-label"
          value={draft.label}
          placeholder="fig:results"
          className="h-7 w-36 font-mono text-xs"
          onChange={(event) =>
            setDraft({ ...draft, label: event.target.value })
          }
        />
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <label htmlFor="figure-width">Width</label>
        <Input
          id="figure-width"
          data-testid="figure-width"
          type="number"
          min={1}
          max={200}
          value={draft.widthPercent ?? ""}
          placeholder="none"
          className="h-7 w-20 text-xs"
          onChange={(event) =>
            setDraft({
              ...draft,
              widthPercent:
                event.target.value === "" ? null : Number(event.target.value),
            })
          }
        />
        <span>% of {draft.widthUnit.replace("\\", "")}</span>

        <label htmlFor="figure-placement" className="ml-2">
          Float
        </label>
        <Select
          value={draft.placement ?? NO_PLACEMENT}
          onValueChange={(value) =>
            setDraft({
              ...draft,
              placement: value === NO_PLACEMENT ? null : value,
            })
          }
        >
          <SelectTrigger
            id="figure-placement"
            data-testid="figure-placement"
            className="h-7 min-w-48 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/*
              "Unset" is a real choice, not the absence of one: an author who
              wrote `\begin{figure}` took the class's default deliberately.
            */}
            <SelectItem value={NO_PLACEMENT}>The class's default</SelectItem>
            {PLACEMENTS.map((placement) => (
              <SelectItem key={placement.value} value={placement.value}>
                {placement.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            data-testid="figure-centered"
            checked={draft.centered}
            onChange={(event) =>
              setDraft({ ...draft, centered: event.target.checked })
            }
          />
          Centre it
        </label>
      </div>

      {/*
        What Apply will write, as the table editor shows it. Here it carries a
        second meaning: an edit leaves everything this form does not model
        exactly where it was, and this is where that is visible.
      */}
      <details className="mb-2">
        <summary className="cursor-pointer text-muted-foreground text-xs">
          Source preview
        </summary>
        <pre
          data-testid="figure-source"
          className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-[11px]"
        >
          {writeFigure(draft)}
        </pre>
      </details>

      <p className="flex items-center gap-2">
        <span className="flex-1" />
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          data-testid="figure-apply"
          disabled={!ready}
          onClick={() => onApply(draft)}
        >
          Apply
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          data-testid="figure-cancel"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </p>
    </fieldset>
  );
}
