import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  appendColumn,
  cellSpan,
  columnCount,
  formatTabular,
  insertRow,
  padRows,
  removeColumn,
  removeRow,
  setCell,
  type Tabular,
  tableColumns,
} from "@/core/latex/tabular";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

/**
 * A `tabular` as a grid of fields (PLAN.md 14, Phase 3: structured editors).
 *
 * Inline above the source rather than in a modal — desktop opens this in a
 * dialog, but the web workspace already shows the source beside it, and a
 * dialog over the document would hide the thing being edited. Nothing reaches
 * the document until Apply, which hands the table back and leaves the writing,
 * and the check that the span has not changed underneath, to the caller.
 *
 * Keyboard: Tab moves between cells as it does in any form, Enter moves down a
 * row as it does in a spreadsheet, Ctrl/Cmd+Enter applies and Escape cancels.
 */

interface TableEditorProps {
  table: Tabular;
  onApply: (table: Tabular) => void;
  onCancel: () => void;
}

export function TableEditor({ table, onApply, onCancel }: TableEditorProps) {
  const [draft, setDraft] = useState(() => padRows(table));
  const [notice, setNotice] = useState<string | null>(null);
  const grid = useRef<HTMLTableElement>(null);

  const columns = tableColumns(draft);
  const declared = columnCount(draft.spec);

  // Into the grid on open, so a keyboard user who asked for the table editor
  // is in it rather than on the button that opened it.
  useEffect(() => {
    grid.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  const cellInput = (row: number, cell: number) =>
    grid.current?.querySelector<HTMLInputElement>(
      `input[data-row="${row}"][data-cell="${cell}"]`,
    );

  return (
    <fieldset
      data-testid="table-editor"
      className="rounded-lg border bg-card p-3 text-card-foreground shadow-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          onApply(draft);
        }
      }}
    >
      {/*
        A legend rather than an aria-label, so the size is read out when focus
        enters the grid — which is when it is useful — and seen as well.
      */}
      <legend className="px-1 font-medium text-sm">
        Table: {draft.rows.length} {draft.rows.length === 1 ? "row" : "rows"} by{" "}
        {columns} {columns === 1 ? "column" : "columns"}
      </legend>

      <p className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <label htmlFor="table-spec" className="flex items-center gap-1.5">
          Columns
        </label>
        <Input
          id="table-spec"
          data-testid="table-spec"
          value={draft.spec}
          spellCheck={false}
          className="h-7 w-44 font-mono text-xs"
          onChange={(event) => setDraft({ ...draft, spec: event.target.value })}
        />
        {/*
          Said, not fixed: the spec may be deliberate (a column the rows leave
          empty) or a spec this cannot read, and either way it is the author's.
        */}
        {declared === null ? (
          <span data-testid="table-spec-note">
            This specification cannot be read, so column changes leave it alone.
          </span>
        ) : declared !== columns ? (
          <span
            data-testid="table-spec-note"
            className="text-amber-600 dark:text-amber-400"
          >
            It declares {declared} {declared === 1 ? "column" : "columns"}; the
            rows use {columns}.
          </span>
        ) : null}
      </p>

      {notice && (
        <p
          role="alert"
          data-testid="table-notice"
          className="mb-2 text-destructive text-xs"
        >
          {notice}
        </p>
      )}

      <div className="overflow-x-auto rounded border">
        <table ref={grid} className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <td className="w-10 p-1" />
              {Array.from({ length: columns }, (_, column) => (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity but their position
                  key={column}
                  scope="col"
                  className="border-l p-1 font-normal text-muted-foreground text-xs"
                >
                  {column + 1}{" "}
                  <Button
                    variant="ghost"
                    size="icon"
                    data-testid="table-remove-column"
                    aria-label={`Remove column ${column + 1}`}
                    className="size-5"
                    disabled={columns === 1}
                    onClick={() => {
                      const result = removeColumn(draft, column);
                      if (result.ok) {
                        setDraft(result.table);
                        setNotice(null);
                      } else {
                        setNotice(
                          `Column ${column + 1} was not removed: ${result.reason}.`,
                        );
                      }
                    }}
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                </th>
              ))}
              <td className="w-px" />
            </tr>
          </thead>
          <tbody>
            {/*
              The rule above the first row, shown where it sits. It is kept
              either way, and a `\toprule` that is preserved but invisible
              looks like one the grid is about to lose.
            */}
            {draft.leading && (
              <tr>
                <td />
                <td colSpan={columns + 1} className="px-2 py-0.5">
                  <code
                    className="table-rule text-[11px] text-muted-foreground"
                    data-testid="table-rule"
                  >
                    {draft.leading}
                  </code>
                </td>
              </tr>
            )}
            {draft.rows.map((row, rowIndex) => {
              let column = 0;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their position
                <tr key={rowIndex}>
                  <th
                    scope="row"
                    className="border-t p-1 font-normal text-muted-foreground text-xs"
                  >
                    {rowIndex + 1}{" "}
                    <Button
                      variant="ghost"
                      size="icon"
                      data-testid="table-remove-row"
                      aria-label={`Remove row ${rowIndex + 1}`}
                      className="size-5"
                      disabled={draft.rows.length === 1}
                      onClick={() => setDraft(removeRow(draft, rowIndex))}
                    >
                      <Trash2Icon className="size-3" />
                    </Button>
                  </th>
                  {row.cells.map((cell, cellIndex) => {
                    const span = cellSpan(cell);
                    const first = column;
                    column += span;
                    return (
                      <td
                        // biome-ignore lint/suspicious/noArrayIndexKey: as above
                        key={cellIndex}
                        colSpan={span}
                        className="border-t border-l p-1"
                      >
                        <input
                          data-testid="table-cell"
                          data-row={rowIndex}
                          data-cell={cellIndex}
                          aria-label={
                            span > 1
                              ? `Row ${rowIndex + 1}, columns ${first + 1} to ${first + span}`
                              : `Row ${rowIndex + 1}, column ${first + 1}`
                          }
                          value={cell}
                          spellCheck={false}
                          className="h-8 w-full min-w-32 rounded border bg-background px-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          onChange={(event) =>
                            setDraft(
                              setCell(
                                draft,
                                rowIndex,
                                cellIndex,
                                event.target.value,
                              ),
                            )
                          }
                          onKeyDown={(event) => {
                            if (
                              event.key !== "Enter" ||
                              event.ctrlKey ||
                              event.metaKey
                            ) {
                              return;
                            }
                            event.preventDefault();
                            const below = draft.rows[rowIndex + 1];
                            if (!below) return;
                            cellInput(
                              rowIndex + 1,
                              Math.min(cellIndex, below.cells.length - 1),
                            )?.focus();
                          }}
                        />
                      </td>
                    );
                  })}
                  <td className="border-t px-2">
                    {/*
                      The rules under a row are kept and shown, not edited: they
                      are the table's typography, and a checkbox for `\hline`
                      would be wrong for every booktabs table.
                    */}
                    {row.rules && (
                      <code
                        className="table-rule whitespace-nowrap text-[11px] text-muted-foreground"
                        data-testid="table-rule"
                      >
                        {row.rules}
                      </code>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/*
        What Apply will write, as desktop's table editor shows it: the grid is
        a convenience over LaTeX source, and a person who knows LaTeX should be
        able to see what it is about to put in their document.
      */}
      <details className="mt-2">
        <summary className="cursor-pointer text-muted-foreground text-xs">
          Source preview
        </summary>
        <pre
          data-testid="table-source"
          className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-[11px]"
        >
          {formatTabular(draft)}
        </pre>
      </details>

      <p className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          data-testid="table-add-row"
          onClick={() => {
            const next = insertRow(draft, draft.rows.length);
            setDraft(next);
            // Onto the row just added: adding a row is how a person says what
            // they are about to type.
            requestAnimationFrame(() =>
              cellInput(next.rows.length - 1, 0)?.focus(),
            );
          }}
        >
          <PlusIcon className="size-3.5" />
          Add row
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          data-testid="table-add-column"
          onClick={() => setDraft(appendColumn(draft))}
        >
          <PlusIcon className="size-3.5" />
          Add column
        </Button>
        <span className="flex-1" />
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          data-testid="table-apply"
          onClick={() => onApply(draft)}
        >
          Apply
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          data-testid="table-cancel"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </p>
    </fieldset>
  );
}
