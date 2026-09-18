import { ImageIcon, QuoteIcon, SigmaIcon, TableIcon } from "lucide-react";
import { AssetView } from "@/app/editor/AssetView";
import { CitationEditor } from "@/app/editor/CitationEditor";
import type { Completions, EditorProblem } from "@/app/editor/CodeEditor";
import { CodeEditor } from "@/app/editor/CodeEditor";
import { FigureEditor } from "@/app/editor/FigureEditor";
import { MathEditor } from "@/app/editor/MathEditor";
import { TableEditor } from "@/app/editor/TableEditor";
import type { BibEntry, Citation, CitationLookup } from "@/core/latex/citation";
import type { Figure, FigureLookup } from "@/core/latex/figure";
import type { MathBlock, MathLookup } from "@/core/latex/math";
import type { Tabular, TabularLookup } from "@/core/latex/tabular";
import type { ProjectId, ProjectPath } from "@/core/project/ids";
import { Button } from "@/ui/button";

/**
 * The document, and the tools that write into it.
 *
 * The toolbar carries what the cursor can do here — the structured editors —
 * and nothing that belongs to the project as a whole: files, outline and
 * health are in the side panel, compiling is over the preview.
 */

export type StructuredEdit =
  | { kind: "table"; path: ProjectPath; table: Tabular }
  | {
      kind: "citation";
      path: ProjectPath;
      citation: Citation;
      entries: BibEntry[];
    }
  | { kind: "figure"; path: ProjectPath; figure: Figure }
  | { kind: "math"; path: ProjectPath; math: MathBlock };

interface EditorPaneProps {
  projectId: ProjectId;
  openPath: ProjectPath;
  mainFile: ProjectPath;
  content: string;
  asset: Uint8Array | null;
  completions: Completions;
  problems: readonly EditorProblem[];
  reveal: { line: number; nonce: number } | null;
  edit: { from: number; to: number; insert: string; nonce: number } | null;
  tableHere: TabularLookup | null;
  citationHere: CitationLookup | null;
  figureHere: FigureLookup | null;
  mathHere: MathLookup | null;
  /** The project's image files, for the figure form to choose from. */
  images: readonly ProjectPath[];
  structured: StructuredEdit | null;
  citationCommands: readonly string[];
  prenotes: boolean;
  onChange: (content: string) => void;
  onCursor: (offset: number) => void;
  onCompile: () => void;
  onOpenTable: () => void;
  onOpenCitation: () => void;
  onOpenFigure: () => void;
  onOpenMath: () => void;
  onImportImage: (file: File) => Promise<ProjectPath>;
  onApplyTable: (table: Tabular) => void;
  onApplyCitation: (citation: Citation) => void;
  onApplyFigure: (figure: Figure) => void;
  onApplyMath: (math: MathBlock) => void;
  onCancelStructured: () => void;
}

export function EditorPane({
  projectId,
  openPath,
  mainFile,
  content,
  asset,
  completions,
  problems,
  reveal,
  edit,
  tableHere,
  citationHere,
  figureHere,
  mathHere,
  images,
  structured,
  citationCommands,
  prenotes,
  onChange,
  onCursor,
  onCompile,
  onOpenTable,
  onOpenCitation,
  onOpenFigure,
  onOpenMath,
  onImportImage,
  onApplyTable,
  onApplyCitation,
  onApplyFigure,
  onApplyMath,
  onCancelStructured,
}: EditorPaneProps) {
  const refusal =
    tableHere?.ok === false
      ? `This ${tableHere.environment} cannot be edited as a grid: ${tableHere.reason}.`
      : citationHere?.ok === false
        ? `This citation cannot be edited yet: ${citationHere.reason}.`
        : figureHere?.ok === false
          ? `This figure cannot be edited as a form: ${figureHere.reason}.`
          : mathHere?.ok === false
            ? `This maths cannot be edited as a form: ${mathHere.reason}.`
            : null;

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-border border-b px-2">
        <span
          data-testid="open-file-name"
          className="mr-2 min-w-0 truncate font-medium text-sm"
        >
          {openPath}
          {openPath === mainFile && (
            <span className="ml-1.5 text-muted-foreground text-xs">main</span>
          )}
        </span>

        {!asset && (
          <div
            data-testid="structured-tools"
            className="flex items-center gap-1"
          >
            {/*
              One button per structure, and each says what it will do here:
              inside a table the question is "edit this one", outside it is
              "put one here".
            */}
            <Button
              variant="ghost"
              size="sm"
              data-testid="table-open"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={tableHere?.ok === false || structured !== null}
              onClick={onOpenTable}
              title={tableHere ? "Edit this table as a grid" : "Insert a table"}
            >
              <TableIcon className="size-3.5" />
              {tableHere ? "Edit table" : "Insert table"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="citation-open"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={citationHere?.ok === false || structured !== null}
              onClick={onOpenCitation}
              title={
                citationHere
                  ? "Edit what this citation cites"
                  : "Insert a citation"
              }
            >
              <QuoteIcon className="size-3.5" />
              {citationHere ? "Edit citation" : "Insert citation"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="figure-open"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={figureHere?.ok === false || structured !== null}
              onClick={onOpenFigure}
              title={
                figureHere
                  ? "Edit this figure"
                  : "Insert a figure with a caption"
              }
            >
              <ImageIcon className="size-3.5" />
              {figureHere ? "Edit figure" : "Insert figure"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="math-open"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={mathHere?.ok === false || structured !== null}
              onClick={onOpenMath}
              title={
                mathHere
                  ? "Edit this equation"
                  : "Insert mathematics, with a preview"
              }
            >
              <SigmaIcon className="size-3.5" />
              {mathHere ? "Edit maths" : "Insert maths"}
            </Button>
          </div>
        )}
      </div>

      {refusal && (
        <p
          data-testid={
            tableHere?.ok === false
              ? "table-refused"
              : citationHere?.ok === false
                ? "citation-refused"
                : figureHere?.ok === false
                  ? "figure-refused"
                  : "math-refused"
          }
          className="shrink-0 border-border border-b bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs"
        >
          {refusal}
        </p>
      )}

      {structured?.kind === "table" && structured.path === openPath && (
        <div className="shrink-0 overflow-x-auto border-border border-b p-2">
          <TableEditor
            key={`${structured.table.from}:${structured.table.original}`}
            table={structured.table}
            onApply={onApplyTable}
            onCancel={onCancelStructured}
          />
        </div>
      )}
      {structured?.kind === "citation" && structured.path === openPath && (
        <div className="shrink-0 border-border border-b p-2">
          <CitationEditor
            key={`${structured.citation.from}:${structured.citation.original}`}
            citation={structured.citation}
            entries={structured.entries}
            commands={citationCommands}
            prenotes={prenotes}
            onApply={onApplyCitation}
            onCancel={onCancelStructured}
          />
        </div>
      )}
      {structured?.kind === "figure" && structured.path === openPath && (
        <div className="shrink-0 border-border border-b p-2">
          <FigureEditor
            key={`${structured.figure.from}:${structured.figure.original}`}
            figure={structured.figure}
            images={images}
            onImport={onImportImage}
            onApply={onApplyFigure}
            onCancel={onCancelStructured}
          />
        </div>
      )}
      {structured?.kind === "math" && structured.path === openPath && (
        <div className="shrink-0 border-border border-b p-2">
          <MathEditor
            key={`${structured.math.from}:${structured.math.original}`}
            math={structured.math}
            onApply={onApplyMath}
            onCancel={onCancelStructured}
          />
        </div>
      )}

      <div className="min-h-0 flex-1" data-testid="editor">
        {/*
          A binary file never reaches the text editor. Decoding one as UTF-8 to
          show it would also be what autosave writes back.
        */}
        {asset ? (
          <div className="h-full overflow-auto p-3">
            <AssetView
              key={`${projectId}:${openPath}`}
              path={openPath}
              bytes={asset}
            />
          </div>
        ) : (
          <CodeEditor
            key={`${projectId}:${openPath}`}
            label={`Contents of ${openPath}`}
            completions={completions}
            problems={problems}
            onSubmit={onCompile}
            value={content}
            reveal={reveal}
            edit={edit}
            onCursor={onCursor}
            onChange={onChange}
          />
        )}
      </div>
    </div>
  );
}
