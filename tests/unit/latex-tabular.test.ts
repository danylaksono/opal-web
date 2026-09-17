import { describe, expect, it } from "vitest";
import {
  appendColumn,
  columnCount,
  formatTabular,
  insertRow,
  newTabular,
  padRows,
  removeColumn,
  removeRow,
  setCell,
  type Tabular,
  tabularAt,
} from "@/core/latex/tabular";

/** Read the table at the `¶` marker, which is removed from the source. */
function tableIn(marked: string): { source: string; table: Tabular } {
  const offset = marked.indexOf("¶");
  const source = marked.slice(0, offset) + marked.slice(offset + 1);
  const found = tabularAt(source, offset);
  if (!found?.ok) {
    throw new Error(`no table: ${found ? found.reason : "not in one"}`);
  }
  return { source, table: found.table };
}

describe("tabularAt", () => {
  it("reads cells, terminators and booktabs rules", () => {
    const { table } = tableIn(
      [
        "Before.",
        "\\begin{tabular}{@{}lc@{}}",
        "\\toprule",
        "Model & Score \\\\",
        "\\midrule",
        "A¶ & 1.0 \\\\[2pt]",
        "B & 2.0 \\\\",
        "\\bottomrule",
        "\\end{tabular}",
      ].join("\n"),
    );

    expect(table.spec).toBe("@{}lc@{}");
    expect(table.leading).toBe("\\toprule");
    expect(table.rows).toEqual([
      { cells: ["Model", "Score"], end: "\\\\", rules: "\\midrule" },
      { cells: ["A", "1.0"], end: "\\\\[2pt]", rules: "" },
      { cells: ["B", "2.0"], end: "\\\\", rules: "\\bottomrule" },
    ]);
  });

  it("does not split on an ampersand that is escaped, braced or nested", () => {
    // Each of these is a cell a regular expression would cut in two.
    const { table } = tableIn(
      [
        "\\begin{tabular}{ll}",
        "R\\&D & \\textbf{a & b}¶ \\\\",
        "\\begin{tabular}{c}x & y\\\\z\\end{tabular} & \\shortstack{p\\\\q} \\\\",
        "\\end{tabular}",
      ].join("\n"),
    );

    expect(table.rows.map((row) => row.cells)).toEqual([
      ["R\\&D", "\\textbf{a & b}"],
      ["\\begin{tabular}{c}x & y\\\\z\\end{tabular}", "\\shortstack{p\\\\q}"],
    ]);
  });

  it("picks the innermost table around the cursor", () => {
    const { table } = tableIn(
      "\\begin{tabular}{l}\\begin{tabular}{cc}a & b¶\\end{tabular}\\end{tabular}",
    );
    expect(table.spec).toBe("cc");
  });

  it("reads the width and position arguments that come before the spec", () => {
    const { table } = tableIn(
      "\\begin{tabularx}{\\linewidth}[t]{lX}\na & b¶\\\\\n\\end{tabularx}",
    );
    expect(table.head).toBe("\\begin{tabularx}{\\linewidth}[t]");
    expect(table.spec).toBe("lX");
  });

  it("is not fooled by a table that is commented out", () => {
    expect(tabularAt("% \\begin{tabular}{l} x \\end{tabular}", 22)).toBeNull();
  });

  it("refuses a table with a comment inside, rather than dropping it", () => {
    const source = "\\begin{tabular}{l}\na \\\\ % keep me\n\\end{tabular}";
    expect(tabularAt(source, 20)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("comments"),
    });
  });

  it("refuses a table whose spec has not been typed yet", () => {
    expect(tabularAt("\\begin{tabular}\n\\end{tabular}", 5)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("column specification"),
    });
  });

  it("returns null outside any table", () => {
    expect(tabularAt("\\begin{tabular}{l}a\\end{tabular} after", 38)).toBe(
      null,
    );
  });
});

describe("columnCount", () => {
  it.each([
    ["lcr", 3],
    ["|l|c|r|", 3],
    ["@{}lX@{}", 2],
    ["p{3cm}m{2cm}b{1cm}", 3],
    [">{\\bfseries}l<{\\,}c", 2],
    ["*{3}{c}l", 4],
    ["S[table-format=2.1]c", 2],
    ["w{l}{2cm}r", 2],
  ])("%s declares %i", (spec, expected) => {
    expect(columnCount(spec)).toBe(expected);
  });

  it("gives up on a spec it cannot read", () => {
    expect(columnCount("l{")).toBeNull();
  });
});

describe("formatTabular", () => {
  it("aligns ampersands and keeps rules on their own lines", () => {
    const { table } = tableIn(
      "  \\begin{tabular}{lr}\\hline Name&Count\\\\\\hline x¶&10\\\\\\end{tabular}",
    );

    expect(formatTabular(table)).toBe(
      [
        "\\begin{tabular}{lr}",
        "    \\hline",
        "    Name & Count \\\\",
        "    \\hline",
        "    x    & 10 \\\\",
        "  \\end{tabular}",
      ].join("\n"),
    );
  });

  it("round-trips what it reads", () => {
    const { source, table } = tableIn(
      "\\begin{tabular}{l|c}\n\\multicolumn{2}{c}{Head}¶\\\\\\hline\na & b \\\\\n\\end{tabular}",
    );
    const written = formatTabular(table);
    const again = tabularAt(written, 1);

    expect(again?.ok && again.table.rows).toEqual(table.rows);
    expect(source).not.toBe(written);
  });

  it("starts an inserted table on its own line", () => {
    const table = newTabular("See this: ", 10);
    expect(formatTabular(table).startsWith("\n\\begin{tabular}{lll}")).toBe(
      true,
    );
  });
});

describe("editing the grid", () => {
  const booktabs = () =>
    tableIn(
      "\\begin{tabular}{l|c|r}\\toprule a & b & c¶\\\\\\midrule d & e & f\\\\\\bottomrule\\end{tabular}",
    ).table;

  it("appending a row keeps the closing rule at the bottom", () => {
    const table = insertRow(booktabs(), 2);
    expect(table.rows.map((row) => row.rules)).toEqual([
      "\\midrule",
      "",
      "\\bottomrule",
    ]);
    expect(table.rows[2]?.cells).toEqual(["", "", ""]);
  });

  it("removing the last row hands its closing rule up", () => {
    const table = removeRow(booktabs(), 1);
    expect(table.rows).toEqual([
      { cells: ["a", "b", "c"], end: "\\\\", rules: "\\bottomrule" },
    ]);
  });

  it("appends a column before the separators that close the spec", () => {
    const table = appendColumn(
      tableIn("\\begin{tabular}{@{}|lc|@{}}a & b¶\\\\\\end{tabular}").table,
    );
    expect(table.spec).toBe("@{}|lcl|@{}");
    expect(table.rows[0]?.cells).toEqual(["a", "b", ""]);
  });

  it("removes a column from the rows and from the spec", () => {
    const result = removeColumn(booktabs(), 1);
    expect(result.ok && result.table.spec).toBe("l|r");
    expect(result.ok && result.table.rows.map((row) => row.cells)).toEqual([
      ["a", "c"],
      ["d", "f"],
    ]);
  });

  it("refuses to remove a column a \\multicolumn spans", () => {
    const { table } = tableIn(
      "\\begin{tabular}{lll}\\multicolumn{2}{c}{x} & y¶\\\\\\end{tabular}",
    );
    expect(removeColumn(table, 1)).toMatchObject({ ok: false });
    // The column after the span is still its own and can go.
    const result = removeColumn(table, 2);
    expect(result.ok && result.table.rows[0]?.cells).toEqual([
      "\\multicolumn{2}{c}{x}",
    ]);
  });

  it("leaves a spec it cannot edit in place alone", () => {
    const { table } = tableIn(
      "\\begin{tabular}{*{2}{c}}a & b¶\\\\\\end{tabular}",
    );
    expect(appendColumn(table).spec).toBe("*{2}{c}");
  });

  it("a cell that starts spanning absorbs the empty cells beside it", () => {
    const { table } = tableIn("\\begin{tabular}{lll}a & & ¶\\\\\\end{tabular}");
    const spanned = setCell(table, 0, 0, "\\multicolumn{2}{c}{a}");
    expect(spanned.rows[0]?.cells).toEqual(["\\multicolumn{2}{c}{a}", ""]);
    // And gives them back when it stops.
    expect(setCell(spanned, 0, 0, "a").rows[0]?.cells).toEqual(["a", "", ""]);
  });

  it("does not absorb a neighbour that has something in it", () => {
    const { table } = tableIn(
      "\\begin{tabular}{lll}a & b & ¶\\\\\\end{tabular}",
    );
    expect(
      setCell(table, 0, 0, "\\multicolumn{2}{c}{a}").rows[0]?.cells,
    ).toEqual(["\\multicolumn{2}{c}{a}", "b", ""]);
  });

  it("pads a short row, which renders the same", () => {
    const { table } = tableIn("\\begin{tabular}{lll}a & b¶\\\\\\end{tabular}");
    expect(padRows(table).rows[0]?.cells).toEqual(["a", "b", ""]);
  });
});

/**
 * The corpus, as in `latex-corpus-index.test.ts`: tables nobody wrote to test
 * this. Every one of them compiles, so every one must either be read or
 * refused with a reason — and a table that is read must survive being written
 * back, cell for cell.
 */
const RAW = import.meta.glob("../fixtures/compiler-corpus/*/*.tex", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("the corpus", () => {
  const tables = Object.entries(RAW).flatMap(([file, source]) =>
    [...source.matchAll(/\\begin\{(?:tabular\*?|tabularx)\}/g)].map(
      (match) => ({ file, source, offset: match.index + 1 }),
    ),
  );

  it("has tables to check", () => {
    expect(tables.length).toBeGreaterThan(5);
  });

  it("reads every table and writes it back without losing a cell", () => {
    for (const { file, source, offset } of tables) {
      const found = tabularAt(source, offset);
      expect(found?.ok, `${file}@${offset}`).toBe(true);
      if (!found?.ok) continue;

      const written = formatTabular(found.table);
      const replaced =
        source.slice(0, found.table.from) +
        written +
        source.slice(found.table.to);
      const again = tabularAt(replaced, found.table.from + 1);

      expect(again?.ok && again.table.rows, file).toEqual(found.table.rows);
      expect(again?.ok && again.table.spec, file).toBe(found.table.spec);
      // The declared width agrees with the rows in documents that compile.
      expect(
        Math.max(...found.table.rows.map((row) => row.cells.length)),
        file,
      ).toBeLessThanOrEqual(columnCount(found.table.spec) ?? 0);
    }
  });
});
