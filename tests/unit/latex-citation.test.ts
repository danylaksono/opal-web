import { describe, expect, it } from "vitest";
import {
  citationAt,
  citationCommands,
  formatCitation,
  plainTex,
  readBib,
  readBibItems,
  readBibliography,
  searchBibliography,
} from "@/core/latex/citation";
import { buildProjectIndex } from "@/core/latex/project-index";
import { scanTex } from "@/core/latex/scan";
import { projectPath } from "@/core/project/ids";

const BIB = projectPath("refs.bib");
const MAIN = projectPath("main.tex");

describe("plainTex", () => {
  it.each([
    ['G{\\"o}del', "Gödel"],
    ["Erd\\H{o}s", "Erdős"],
    ["Fran\\c{c}ois", "François"],
    ["The {\\TeX}book", "The TeXbook"],
    [
      "{\\LaTeX}: A Document Preparation System",
      "LaTeX: A Document Preparation System",
    ],
    ["\\emph{Attention} Is All You Need", "Attention Is All You Need"],
    ["pages 1--10", "pages 1–10"],
    ["Stra\\ss e", "Straße"],
  ])("%s reads as %s", (source, expected) => {
    expect(plainTex(source)).toBe(expected);
  });
});

describe("readBib", () => {
  it("reads authors, title and year from braces, quotes and bare values", () => {
    const [first, second, third] = readBib(
      [
        "@string{aw = {Addison-Wesley}}",
        "@book{knuth1984,",
        "  author = {Knuth, Donald E.},",
        '  title = "The {\\TeX}book",',
        "  publisher = aw,",
        "  year = 1984",
        "}",
        "",
        "@article{vaswani2017,",
        "  author = {Ashish Vaswani and Noam Shazeer and others},",
        "  title = {Attention Is All You Need},",
        "  date = {2017-06-12},",
        "}",
        "@misc{bn, author = {{Barnes and Noble}}, title = {Catalogue}}",
      ].join("\n"),
      BIB,
    );

    expect(first).toMatchObject({
      key: "knuth1984",
      line: 2,
      type: "book",
      authors: "Knuth",
      title: "The TeXbook",
      year: "1984",
    });
    expect(second).toMatchObject({
      key: "vaswani2017",
      line: 9,
      authors: "Vaswani et al.",
      year: "2017",
    });
    // A corporate author in double braces is one name, not two.
    expect(third?.authors).toBe("Barnes and Noble");
  });

  it("keeps an entry whose fields it cannot read", () => {
    expect(readBib("@book{odd, title = {unclosed", BIB)).toMatchObject([
      { key: "odd", title: "" },
    ]);
  });
});

describe("readBibItems", () => {
  it("reads a hand-written bibliography as searchable text", () => {
    const [item] = readBibItems(
      [
        "\\begin{thebibliography}{9}",
        "\\bibitem{knuth} D.~E. Knuth.",
        "\\newblock \\emph{The {\\TeX}book}. Addison-Wesley, 1984.",
        "\\end{thebibliography}",
      ].join("\n"),
      MAIN,
    );
    expect(item).toMatchObject({
      key: "knuth",
      line: 2,
      year: "1984",
      title: "D. E. Knuth. The TeXbook. Addison-Wesley, 1984.",
    });
  });
});

describe("searchBibliography", () => {
  const entries = readBib(
    [
      "@book{knuth1984, author = {Knuth, Donald}, title = {The {\\TeX}book}, year = {1984}}",
      '@article{godel1931, author = {G{\\"o}del, Kurt}, title = {{\\"U}ber formal unentscheidbare S{\\"a}tze}, year = {1931}}',
      "@book{lamport1994, author = {Lamport, Leslie}, title = {{\\LaTeX}}, year = {1994}, publisher = {Addison-Wesley}}",
    ].join("\n"),
    BIB,
  );
  const keys = (query: string) =>
    searchBibliography(entries, query).map((entry) => entry.key);

  it("matches every word, in any order, across fields", () => {
    expect(keys("1994 lamport")).toEqual(["lamport1994"]);
    expect(keys("addison")).toEqual(["lamport1994"]);
  });

  it("ignores accents and case", () => {
    expect(keys("godel uber")).toEqual(["godel1931"]);
  });

  it("puts a key prefix first", () => {
    // "tex" is in knuth's title; "lam" is a key prefix and a title word.
    expect(keys("la")[0]).toBe("lamport1994");
  });

  it("returns everything for an empty query", () => {
    expect(keys("  ")).toHaveLength(3);
  });
});

describe("citationAt", () => {
  const at = (marked: string) => {
    const offset = marked.indexOf("¶");
    return citationAt(marked.replace("¶", ""), offset);
  };

  it("finds the command with its notes and keys, from the backslash on", () => {
    const found = at("See \\ci¶tep[see][p.~4]{knuth1984, lamport1994} here.");
    expect(found).toEqual({
      ok: true,
      citation: {
        command: "citep",
        starred: false,
        prenote: "see",
        postnote: "p.~4",
        keys: ["knuth1984", "lamport1994"],
        from: 4,
        to: 45,
        original: "\\citep[see][p.~4]{knuth1984, lamport1994}",
      },
    });
  });

  it("reads one optional as the postnote", () => {
    const found = at("\\cite[ch.~2]{k¶}");
    expect(
      found?.ok && [found.citation.prenote, found.citation.postnote],
    ).toEqual(["", "ch.~2"]);
  });

  it("does not take a comment inside a broken key list as a key", () => {
    const found = at("\\cite{a, % first\n  b¶}");
    expect(found?.ok && found.citation.keys).toEqual(["a", "b"]);
  });

  it("is not in a citation that is commented out, or next to one", () => {
    expect(at("% \\cite{a¶}")).toBeNull();
    expect(at("\\cite{a} and ¶then")).toBeNull();
    expect(at("\\textbf{a¶}")).toBeNull();
  });

  it("refuses a citation that has no argument yet", () => {
    expect(at("\\cite¶")).toMatchObject({ ok: false });
  });
});

describe("formatCitation", () => {
  const base = {
    command: "citep",
    starred: false,
    prenote: "",
    postnote: "",
    keys: ["a", "b"],
    from: 0,
    to: 0,
    original: "",
  };

  it("writes keys without spaces and omits empty notes", () => {
    expect(formatCitation(base)).toBe("\\citep{a,b}");
  });

  it("keeps an empty postnote when there is a prenote", () => {
    // natbib reads a lone optional as the postnote, so the prenote needs its
    // empty partner or it renders on the wrong side.
    expect(formatCitation({ ...base, prenote: "see" })).toBe(
      "\\citep[see][]{a,b}",
    );
  });

  it("round-trips what it reads", () => {
    const source = "\\citet*[e.g.][p.~3]{x,y}";
    const found = citationAt(source, 3);
    expect(found?.ok && formatCitation(found.citation)).toBe(source);
  });
});

describe("citationCommands", () => {
  it("offers only what the loaded packages define", () => {
    expect(citationCommands(new Set())).toEqual(["cite", "nocite"]);
    expect(citationCommands(new Set(["natbib"]))).toContain("citet");
    expect(citationCommands(new Set(["natbib"]))).not.toContain("parencite");
    expect(citationCommands(new Set(["biblatex"]))).toContain("parencite");
  });
});

/**
 * Against the corpus, and against the index.
 *
 * Two readers of the same bibliography must agree on which keys exist, or the
 * picker would offer a key the health list calls undefined — or hide one it
 * calls defined. And every citation the scanner counts must be one the picker
 * can open and write back unchanged.
 */
const RAW = import.meta.glob("../fixtures/compiler-corpus/*/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("the corpus", () => {
  const projects = new Map<string, { path: string; content: string }[]>();
  for (const [key, content] of Object.entries(RAW)) {
    const parts = key.split("/");
    const project = parts.at(-2) ?? "";
    const file = parts.at(-1) ?? "";
    if (!/\.(tex|bib|cls|sty)$/.test(file)) continue;
    projects.set(project, [
      ...(projects.get(project) ?? []),
      { path: file, content },
    ]);
  }

  it("has citations to check", () => {
    const cited = [...projects.values()]
      .flat()
      .filter((file) => file.path.endsWith(".tex"))
      .reduce(
        (total, file) => total + scanTex(file.content).citations.length,
        0,
      );
    expect(cited).toBeGreaterThan(10);
  });

  it("reads the same keys the index does", () => {
    for (const [name, files] of projects) {
      const inputs = files.map((file) => ({
        path: projectPath(file.path),
        content: file.content,
      }));
      const index = buildProjectIndex(inputs, projectPath("main.tex"));
      const keys = new Set(readBibliography(inputs).map((entry) => entry.key));
      expect([...keys].sort(), name).toEqual(
        [...index.bibliographyKeys].sort(),
      );
    }
  });

  it("opens every citation command and writes it back unchanged", () => {
    for (const [name, files] of projects) {
      for (const file of files.filter((item) => item.path.endsWith(".tex"))) {
        const pattern =
          /\\(?:no|paren|text|auto|foot|full)?cite[a-z]*\*?\s*[[{]/g;
        for (const match of file.content.matchAll(pattern)) {
          const found = citationAt(file.content, match.index + 1);
          if (found?.ok === false) continue;
          expect(found, `${name}/${file.path}@${match.index}`).not.toBeNull();
          if (!found?.ok) continue;
          const { citation } = found;
          // Rewritten from parts, the source differs only in the spaces a
          // writer put between keys.
          expect(formatCitation(citation), name).toBe(
            citation.original.replace(/,\s+/g, ","),
          );
        }
      }
    }
  });
});
