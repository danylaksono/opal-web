import { useEffect, useRef, useState } from "react";
import {
  appendColumn,
  cellSpan,
  columnCount,
  insertRow,
  padRows,
  removeColumn,
  removeRow,
  setCell,
  type Tabular,
  tableColumns,
} from "@/core/latex/tabular";

/**
 * A `tabular` as a grid of fields (PLAN.md 14, Phase 3: structured editors).
 *
 * Inline above the source rather than in a modal: the source stays visible, so
 * what the grid will write is never a surprise, and there is no focus trap to
 * get wrong. It edits a copy; nothing reaches the document until Apply, which
 * hands back the new table and leaves the writing — and the check that the
 * span has not changed underneath — to the caller.
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
      className="table-editor"
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
      <legend>
        Table editor: {draft.rows.length}{" "}
        {draft.rows.length === 1 ? "row" : "rows"} by {columns}{" "}
        {columns === 1 ? "column" : "columns"}
      </legend>
      <p className="note">
        <label>
          Columns{" "}
          <input
            data-testid="table-spec"
            value={draft.spec}
            spellCheck={false}
            onChange={(event) =>
              setDraft({ ...draft, spec: event.target.value })
            }
          />
        </label>{" "}
        {/*
          Said, not fixed: the spec may be deliberate (a column the rows leave
          empty) or a spec this cannot read, and either way it is the author's.
        */}
        {declared === null ? (
          <span data-testid="table-spec-note">
            This specification cannot be read, so column changes leave it alone.
          </span>
        ) : declared !== columns ? (
          <span data-testid="table-spec-note" className="optional-missing">
            It declares {declared} {declared === 1 ? "column" : "columns"}; the
            rows use {columns}.
          </span>
        ) : null}
      </p>

      {notice && (
        <p className="unavailable" role="alert" data-testid="table-notice">
          {notice}
        </p>
      )}

      <div className="table-editor-scroll">
        <table ref={grid}>
          <thead>
            <tr>
              <td />
              {Array.from({ length: columns }, (_, column) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity but their position
                <th key={column} scope="col">
                  {column + 1}{" "}
                  <button
                    type="button"
                    data-testid="table-remove-column"
                    aria-label={`Remove column ${column + 1}`}
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
                    ×
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {draft.rows.map((row, rowIndex) => {
              let column = 0;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their position
                <tr key={rowIndex}>
                  <th scope="row">
                    {rowIndex + 1}{" "}
                    <button
                      type="button"
                      data-testid="table-remove-row"
                      aria-label={`Remove row ${rowIndex + 1}`}
                      disabled={draft.rows.length === 1}
                      onClick={() => setDraft(removeRow(draft, rowIndex))}
                    >
                      ×
                    </button>
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
                  <td>
                    {/*
                      The rules under a row are kept and shown, not edited: they
                      are the table's typography, and a checkbox for
                      `\hline` would be wrong for every booktabs table.
                    */}
                    {row.rules && (
                      <code className="table-rule">{row.rules}</code>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="note">
        <button
          type="button"
          data-testid="table-add-row"
          onClick={() => {
            const next = insertRow(draft, draft.rows.length);
            setDraft(next);
            // Onto the row just added: adding a row is how a person says
            // what they are about to type.
            requestAnimationFrame(() =>
              cellInput(next.rows.length - 1, 0)?.focus(),
            );
          }}
        >
          Add row
        </button>{" "}
        <button
          type="button"
          data-testid="table-add-column"
          onClick={() => setDraft(appendColumn(draft))}
        >
          Add column
        </button>{" "}
        <button
          type="button"
          data-testid="table-apply"
          onClick={() => onApply(draft)}
        >
          Apply
        </button>{" "}
        <button type="button" data-testid="table-cancel" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </fieldset>
  );
}
