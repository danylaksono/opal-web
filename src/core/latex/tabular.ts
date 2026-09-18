/**
 * A `tabular` as rows and cells (investigation.md 14, Phase 3: structured editors).
 *
 * The first structured editor is the table, because a table is where LaTeX
 * source stops resembling the thing it describes: a grid written as one long
 * run of `&` and `\\`, where a missing ampersand shifts every cell after it
 * and nothing says so until the compile does.
 *
 * Like the scanner, this reads rather than parses. It recovers exactly what a
 * grid editor needs — where the environment starts and ends, its column
 * specification, the cells of each row and the rules between them — and
 * refuses what it cannot write back without losing something. Refusing is the
 * point: an editor that silently drops a comment or rewrites a `longtable`'s
 * `\endhead` has turned a convenience into data loss.
 *
 * Everything works in character offsets, not lines, because the result is a
 * replacement of one span of the document.
 */

import { maskComments } from "./comments";

/** Environments laid out as a column spec followed by `&`/`\\` rows. */
const ENVIRONMENTS = ["tabular", "tabular*", "tabularx", "array"] as const;

/** The two that take a width before the spec: `\begin{tabularx}{\linewidth}{lX}`. */
const WIDTH_FIRST = new Set(["tabular*", "tabularx"]);

/**
 * Rules drawn between rows, kept verbatim with the row above them.
 *
 * Standard LaTeX, `booktabs`, and `arydshln`'s dashed line. A row-level command
 * not listed here — `\rowcolor`, say — is not lost: it reads as the start of
 * the next row's first cell, which is where TeX reads it too.
 */
const RULE =
  /\s*(\\(?:hline|toprule|midrule|bottomrule|hdashline|cline\s*\{[^}]*\}|cmidrule\s*(?:\([^)]*\))?\s*\{[^}]*\}|addlinespace\s*(?:\[[^\]]*\])?|specialrule\s*\{[^}]*\}\s*\{[^}]*\}\s*\{[^}]*\}))/y;

const MULTICOLUMN = /^\\multicolumn\s*\{\s*(\d+)\s*\}/;

export interface TabularRow {
  /** Each cell's source, trimmed. `\multicolumn{2}{c}{x}` is one cell. */
  cells: string[];
  /** `\\`, `\\[2pt]`, `\\*`, or empty for a last row written without one. */
  end: string;
  /** Rules after the row, space-separated: `\midrule`, `\hline \cline{2-3}`. */
  rules: string;
}

export interface Tabular {
  environment: string;
  /** Span replaced when the table is written back. */
  from: number;
  to: number;
  /**
   * The source the span held when this was read.
   *
   * Checked before writing back, because the document is still editable while
   * the grid is open: the same conditional-write rule the repository uses,
   * applied to one span instead of one file.
   */
  original: string;
  /** Everything before the spec: `\begin{tabular}[t]`, `\begin{tabularx}{\linewidth}`. */
  head: string;
  spec: string;
  /** Rules before the first row. */
  leading: string;
  rows: TabularRow[];
  /** The `\begin` line's own indentation, which the rows are indented from. */
  indent: string;
  /** Text written before the table: a line break when inserting mid-line. */
  lead: string;
}

export type TabularLookup =
  | { ok: true; table: Tabular }
  | { ok: false; environment: string; reason: string };

/** Index just past the balanced group opening at `at`, or -1. */
function closeGroup(source: string, at: number, open = "{", close = "}") {
  if (source[at] !== open) return -1;
  let depth = 0;
  for (let index = at; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function skipSpace(source: string, at: number): number {
  let index = at;
  while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
  return index;
}

/** The whitespace a line starts with, for the line containing `offset`. */
function indentAt(source: string, offset: number): string {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(start))?.[0] ?? "";
}

/** How many grid columns a cell covers. */
export function cellSpan(cell: string): number {
  const match = MULTICOLUMN.exec(cell);
  return match ? Math.max(1, Number(match[1])) : 1;
}

function rowWidth(row: TabularRow): number {
  return row.cells.reduce((total, cell) => total + cellSpan(cell), 0);
}

/**
 * The column specification, split into the parts an edit has to respect.
 *
 * A column is a letter, with its argument if it takes one (`p{3cm}`, `S[...]`)
 * and the `>{...}`/`<{...}` that decorate it. Everything else — `|`, `@{}`,
 * `!{}` — is a separator. `*{3}{c}` is neither, and its presence makes the spec
 * countable but not editable in place.
 */
type SpecToken =
  | { kind: "column"; text: string }
  | { kind: "separator"; text: string }
  | { kind: "repeat"; text: string; count: number };

function tokenizeSpec(spec: string): SpecToken[] | null {
  const tokens: SpecToken[] = [];
  let index = 0;
  let pending = "";
  while (index < spec.length) {
    const character = spec[index] ?? "";
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "|") {
      tokens.push({ kind: "separator", text: "|" });
      index += 1;
      continue;
    }
    if ("@!<>".includes(character)) {
      const end = closeGroup(spec, skipSpace(spec, index + 1));
      if (end === -1) return null;
      const text = spec.slice(index, end);
      if (character === ">") {
        // Belongs to the column after it.
        pending += text;
      } else if (character === "<") {
        const previous = tokens.at(-1);
        if (previous?.kind !== "column") return null;
        previous.text += text;
      } else {
        tokens.push({ kind: "separator", text });
      }
      index = end;
      continue;
    }
    if (character === "*") {
      const countEnd = closeGroup(spec, skipSpace(spec, index + 1));
      if (countEnd === -1) return null;
      const bodyStart = skipSpace(spec, countEnd);
      const bodyEnd = closeGroup(spec, bodyStart);
      if (bodyEnd === -1) return null;
      const repeat = Number(
        spec.slice(skipSpace(spec, index + 1) + 1, countEnd - 1),
      );
      const inner = columnCount(spec.slice(bodyStart + 1, bodyEnd - 1));
      if (!Number.isInteger(repeat) || inner === null) return null;
      tokens.push({
        kind: "repeat",
        text: spec.slice(index, bodyEnd),
        count: repeat * inner,
      });
      index = bodyEnd;
      continue;
    }
    if (/[a-zA-Z]/.test(character)) {
      let end = index + 1;
      // `p{3cm}`, `m{}`, `b{}` and `X`-like user columns take one argument;
      // `w{l}{2cm}` and `W` take two; siunitx's `S[...]` an optional one.
      const groups = "pmb".includes(character)
        ? 1
        : "wW".includes(character)
          ? 2
          : 0;
      for (let group = 0; group < groups; group += 1) {
        end = closeGroup(spec, skipSpace(spec, end));
        if (end === -1) return null;
      }
      if (spec[skipSpace(spec, end)] === "[") {
        end = closeGroup(spec, skipSpace(spec, end), "[", "]");
        if (end === -1) return null;
      }
      tokens.push({ kind: "column", text: pending + spec.slice(index, end) });
      pending = "";
      index = end;
      continue;
    }
    return null;
  }
  return pending ? null : tokens;
}

/** How many columns a spec declares, or null if it cannot be read. */
export function columnCount(spec: string): number | null {
  const tokens = tokenizeSpec(spec);
  if (!tokens) return null;
  return tokens.reduce(
    (total, token) =>
      total +
      (token.kind === "column" ? 1 : token.kind === "repeat" ? token.count : 0),
    0,
  );
}

/**
 * The table's grid width: the wider of what the spec declares and what the
 * rows hold, so a row with one ampersand too many is visible rather than cut.
 */
export function tableColumns(table: Tabular): number {
  return Math.max(columnCount(table.spec) ?? 0, ...table.rows.map(rowWidth), 1);
}

/**
 * Split an environment's body into rows, or say why it cannot be.
 *
 * `&` and `\\` count only at the top level: inside braces they belong to a
 * command's argument, and inside a nested environment they belong to it.
 */
function parseBody(
  body: string,
):
  | { ok: true; leading: string; rows: TabularRow[] }
  | { ok: false; reason: string } {
  const rows: TabularRow[] = [];
  let cells: string[] = [];
  let cellStart = 0;
  let depth = 0;
  let environments = 0;

  const consumeRules = (at: number): { rules: string; next: number } => {
    const found: string[] = [];
    let next = at;
    for (;;) {
      RULE.lastIndex = next;
      const match = RULE.exec(body);
      if (!match) break;
      found.push((match[1] ?? "").replace(/\s+/g, ""));
      next = RULE.lastIndex;
    }
    return { rules: found.join(" "), next };
  };

  const opening = consumeRules(0);
  const leading = opening.rules;
  cellStart = opening.next;

  let index = cellStart;
  while (index < body.length) {
    const character = body[index];
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth < 0) return { ok: false, reason: "its braces do not balance" };

    if (character === "&" && depth === 0 && environments === 0) {
      cells.push(body.slice(cellStart, index).trim());
      index += 1;
      cellStart = index;
      continue;
    }

    if (character !== "\\") {
      index += 1;
      continue;
    }

    const name = /^[a-zA-Z]+/.exec(body.slice(index + 1, index + 40))?.[0];
    const topLevel = depth === 0 && environments === 0;

    if (name === "begin" || name === "end") {
      environments += name === "begin" ? 1 : -1;
      index += 1 + name.length;
      continue;
    }

    const isBreak = body[index + 1] === "\\" || name === "tabularnewline";
    if (!isBreak || !topLevel) {
      // Any other command or escape: skip it whole, so `\&` is a character.
      index += name ? 1 + name.length : 2;
      continue;
    }

    cells.push(body.slice(cellStart, index).trim());
    let end = index + (name === "tabularnewline" ? 15 : 2);
    if (body[end] === "*") end += 1;
    const optional = skipSpace(body, end);
    if (body[optional] === "[") {
      const closed = closeGroup(body, optional, "[", "]");
      if (closed !== -1) end = closed;
    }
    const terminator = body.slice(index, end).replace(/\s+/g, "");
    const after = consumeRules(end);
    rows.push({ cells, end: terminator, rules: after.rules });
    cells = [];
    index = after.next;
    cellStart = index;
  }

  if (depth !== 0 || environments !== 0) {
    return { ok: false, reason: "its braces or environments do not balance" };
  }

  const tail = body.slice(cellStart).trim();
  if (tail || cells.length > 0) {
    cells.push(tail);
    rows.push({ cells, end: "", rules: "" });
  }
  return { ok: true, leading, rows };
}

/**
 * The innermost table environment around `offset`, read into a grid.
 *
 * Returns null when the cursor is not in one, and a refusal — naming the
 * environment and the reason — when it is in one this cannot write back.
 */
export function tabularAt(
  source: string,
  offset: number,
): TabularLookup | null {
  const masked = maskComments(source);
  const pattern = /\\(begin|end)\s*\{(tabular\*?|tabularx|array)\}/g;
  const open: { environment: string; from: number; bodyAt: number }[] = [];
  let found: {
    environment: string;
    from: number;
    to: number;
    bodyAt: number;
    endAt: number;
  } | null = null;

  for (const match of masked.matchAll(pattern)) {
    const environment = match[2] ?? "";
    if (match[1] === "begin") {
      open.push({
        environment,
        from: match.index,
        bodyAt: match.index + match[0].length,
      });
      continue;
    }
    // Pop to the matching \begin; a stray \end with no opener is ignored.
    let at = open.length - 1;
    while (at >= 0 && open[at]?.environment !== environment) at -= 1;
    if (at < 0) continue;
    const begin = open[at];
    open.length = at;
    if (!begin) continue;
    const to = match.index + match[0].length;
    // Innermost wins, and environments close inner-first, so the first one
    // found around the cursor is it.
    if (!found && begin.from <= offset && offset <= to) {
      found = { ...begin, to, endAt: match.index };
    }
  }
  if (!found) return null;

  const { environment, from, to, bodyAt, endAt } = found;
  const refuse = (reason: string): TabularLookup => ({
    ok: false,
    environment,
    reason,
  });

  if (!(ENVIRONMENTS as readonly string[]).includes(environment)) return null;

  // `\begin{tabular}[t]{spec}`, but `\begin{tabularx}{width}[t]{spec}`.
  let at = skipSpace(source, bodyAt);
  if (WIDTH_FIRST.has(environment)) {
    at = closeGroup(source, at);
    if (at === -1) return refuse("it has no width argument yet");
    at = skipSpace(source, at);
  }
  if (source[at] === "[") {
    at = closeGroup(source, at, "[", "]");
    if (at === -1) return refuse("its position argument is not closed");
    at = skipSpace(source, at);
  }
  const specEnd = closeGroup(source, at);
  if (specEnd === -1 || specEnd > endAt) {
    return refuse("it has no column specification yet");
  }

  const body = source.slice(specEnd, endAt);
  if (masked.slice(specEnd, endAt) !== body) {
    return refuse(
      "it contains comments, which the grid has nowhere to keep in place",
    );
  }
  const parsed = parseBody(body);
  if (!parsed.ok) return refuse(parsed.reason);

  return {
    ok: true,
    table: {
      environment,
      from,
      to,
      original: source.slice(from, to),
      head: source.slice(from, at),
      spec: source.slice(at + 1, specEnd - 1),
      leading: parsed.leading,
      rows: parsed.rows,
      indent: indentAt(source, from),
      lead: "",
    },
  };
}

/**
 * An empty table to insert at `offset`: a header row and two body rows.
 *
 * Starts on its own line, because `\begin{tabular}` in the middle of a
 * sentence is legal and almost never meant.
 */
export function newTabular(source: string, offset: number): Tabular {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const before = source.slice(lineStart, offset);
  const indent = /^[ \t]*/.exec(before)?.[0] ?? "";
  const midLine = before.trim().length > 0;
  const row = (): TabularRow => ({
    cells: ["", "", ""],
    end: "\\\\",
    rules: "",
  });
  return {
    environment: "tabular",
    from: offset,
    to: offset,
    original: "",
    head: "\\begin{tabular}",
    spec: "lll",
    leading: "\\hline",
    rows: [
      { ...row(), rules: "\\hline" },
      row(),
      { ...row(), rules: "\\hline" },
    ],
    indent,
    lead: midLine ? `\n${indent}` : "",
  };
}

/**
 * Write a table back as source, one row per line with its `&`s aligned.
 *
 * Alignment is by grid column, so a `\multicolumn` does not throw the rest of
 * its row out of line; a cell that spans more than one line gives up on
 * alignment for the whole table rather than producing something ragged.
 */
export function formatTabular(table: Tabular): string {
  const inner = `${table.indent}  `;
  const multiline = table.rows.some((row) =>
    row.cells.some((cell) => cell.includes("\n")),
  );
  const widths: number[] = [];
  if (!multiline) {
    for (const row of table.rows) {
      let column = 0;
      row.cells.forEach((cell, at) => {
        const span = cellSpan(cell);
        if (span === 1 && at < row.cells.length - 1) {
          widths[column] = Math.max(widths[column] ?? 0, cell.length);
        }
        column += span;
      });
    }
  }

  const lines = [`${table.head}{${table.spec}}`];
  if (table.leading) lines.push(`${inner}${table.leading}`);
  for (const row of table.rows) {
    let column = 0;
    const text = row.cells
      .map((cell, at) => {
        const span = cellSpan(cell);
        const padded =
          span === 1 && at < row.cells.length - 1
            ? cell.padEnd(widths[column] ?? 0)
            : cell;
        column += span;
        return padded;
      })
      .join(" & ");
    lines.push(`${inner}${text}${row.end ? ` ${row.end}` : ""}`.trimEnd());
    if (row.rules) lines.push(`${inner}${row.rules}`);
  }
  lines.push(`${table.indent}\\end{${table.environment}}`);
  return table.lead + lines.join("\n");
}

/**
 * Replace one cell's source. `cell` is the cell's index in its row.
 *
 * A cell whose span changes takes its neighbours with it. Typing
 * `\multicolumn{2}` into a cell means "this and the next one", and leaving the
 * next one in place writes a row one column too wide — which TeX rejects as
 * "Extra alignment tab", as the e2e that compiles a grid-written table found.
 * Only empty neighbours are absorbed: one with something in it is the author's,
 * and the grid's width note says the row no longer fits instead.
 */
export function setCell(
  table: Tabular,
  row: number,
  cell: number,
  value: string,
): Tabular {
  return {
    ...table,
    rows: table.rows.map((existing, at) => {
      if (at !== row) return existing;
      const cells = [...existing.cells];
      const grown = cellSpan(value) - cellSpan(cells[cell] ?? "");
      cells[cell] = value;
      if (grown > 0) {
        let absorbed = 0;
        while (absorbed < grown && cells[cell + 1] === "") {
          cells.splice(cell + 1, 1);
          absorbed += 1;
        }
      } else if (grown < 0) {
        cells.splice(cell + 1, 0, ...Array(-grown).fill(""));
      }
      return { ...existing, cells };
    }),
  };
}

/**
 * Give every row a cell for every column.
 *
 * `a & b \\` in a three-column table is legal and renders the same as
 * `a & b & \\`, and a grid needs somewhere to type the third cell.
 */
export function padRows(table: Tabular): Tabular {
  const columns = tableColumns(table);
  return {
    ...table,
    rows: table.rows.map((row) => {
      const missing = columns - rowWidth(row);
      return missing > 0
        ? { ...row, cells: [...row.cells, ...Array(missing).fill("")] }
        : row;
    }),
  };
}

/**
 * Insert an empty row at `index`.
 *
 * Appending takes over the old last row's rules and terminator: a closing
 * `\bottomrule` belongs to the bottom of the table, not to whichever row
 * happened to be last when it was written.
 */
export function insertRow(table: Tabular, index: number): Tabular {
  const rows = [...table.rows];
  const fresh: TabularRow = {
    cells: Array(tableColumns(table)).fill(""),
    end: "\\\\",
    rules: "",
  };
  const last = rows.at(-1);
  if (index >= rows.length && last) {
    fresh.end = last.end || "\\\\";
    fresh.rules = last.rules;
    rows[rows.length - 1] = { ...last, end: last.end || "\\\\", rules: "" };
  }
  rows.splice(Math.min(index, rows.length), 0, fresh);
  return { ...table, rows };
}

/** Remove a row; removing the last one hands its rules to the row above. */
export function removeRow(table: Tabular, index: number): Tabular {
  const rows = [...table.rows];
  const [removed] = rows.splice(index, 1);
  const above = rows[index - 1];
  if (removed && index === rows.length && above) {
    rows[index - 1] = { ...above, end: removed.end, rules: removed.rules };
  }
  return { ...table, rows };
}

/**
 * Append an empty column, to the rows and — where it can be edited in place —
 * to the spec, before any trailing `|` or `@{}` that closes it.
 */
export function appendColumn(table: Tabular): Tabular {
  const padded = padRows(table);
  const tokens = tokenizeSpec(table.spec);
  let spec = table.spec;
  if (tokens && !tokens.some((token) => token.kind === "repeat")) {
    let at = tokens.length;
    while (at > 0 && tokens[at - 1]?.kind === "separator") at -= 1;
    tokens.splice(at, 0, { kind: "column", text: "l" });
    spec = tokens.map((token) => token.text).join("");
  }
  return {
    ...padded,
    spec,
    rows: padded.rows.map((row) => ({ ...row, cells: [...row.cells, ""] })),
  };
}

/**
 * Remove grid column `column`, or say why not.
 *
 * Refused when a `\multicolumn` covers it: shrinking the span would be a guess
 * about what the author meant, and the grid is not the place to guess.
 */
export function removeColumn(
  table: Tabular,
  column: number,
): { ok: true; table: Tabular } | { ok: false; reason: string } {
  const rows: TabularRow[] = [];
  for (const [index, row] of table.rows.entries()) {
    let start = 0;
    let cell = -1;
    for (const [at, text] of row.cells.entries()) {
      const span = cellSpan(text);
      if (column < start + span) {
        if (span > 1) {
          return {
            ok: false,
            reason: `row ${index + 1} spans column ${column + 1} with \\multicolumn`,
          };
        }
        cell = at;
        break;
      }
      start += span;
    }
    rows.push(
      cell === -1
        ? row
        : { ...row, cells: row.cells.filter((_, at) => at !== cell) },
    );
  }

  const tokens = tokenizeSpec(table.spec);
  let spec = table.spec;
  if (tokens && !tokens.some((token) => token.kind === "repeat")) {
    const at = tokens
      .map((token, index) => (token.kind === "column" ? index : -1))
      .filter((index) => index !== -1)[column];
    if (at !== undefined) {
      // `l|c|r` without `c` is `l|r`, not `l||r`.
      const doubled =
        tokens[at - 1]?.text === "|" && tokens[at + 1]?.text === "|";
      tokens.splice(at, doubled ? 2 : 1);
      spec = tokens.map((token) => token.text).join("");
    }
  }
  return { ok: true, table: { ...table, spec, rows } };
}
