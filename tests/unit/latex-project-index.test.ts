import { describe, expect, it } from "vitest";
import { buildProjectIndex } from "@/core/latex/project-index";
import { projectPath } from "@/core/project/ids";

const main = projectPath("main.tex");

function index(files: Record<string, string>) {
  return buildProjectIndex(
    Object.entries(files).map(([path, content]) => ({
      path: projectPath(path),
      content,
    })),
    main,
  );
}

describe("buildProjectIndex", () => {
  it("resolves a reference against a label in another file", () => {
    // The question a person cannot answer by looking at their screen, which is
    // the only reason this index exists.
    const built = index({
      "main.tex": "\\input{chapter}\nSee \\ref{sec:one}.",
      "chapter.tex": "\\section{One}\\label{sec:one}",
    });

    expect(built.problems).toEqual([]);
    expect(built.labels.get("sec:one")).toEqual([
      { file: "chapter.tex", line: 1 },
    ]);
  });

  it("reports a reference with no label anywhere", () => {
    const built = index({ "main.tex": "See \\ref{sec:missing}." });

    expect(built.problems).toEqual([
      {
        kind: "undefined-reference",
        file: "main.tex",
        line: 1,
        subject: "sec:missing",
        message: "No \\label{sec:missing} in this project",
      },
    ]);
  });

  it("accepts a label the loaded package defines", () => {
    // `letter-formal` does exactly this, and it was the corpus's only
    // "undefined reference" before the index knew about packages.
    const built = index({
      "main.tex":
        "\\usepackage{lastpage}\nPage \\thepage\\ of \\pageref{LastPage}",
    });

    expect(built.problems).toEqual([]);
  });

  it("still reports that label when the package is not loaded", () => {
    const built = index({ "main.tex": "\\pageref{LastPage}" });

    expect(built.problems.map((problem) => problem.kind)).toEqual([
      "undefined-reference",
    ]);
  });

  it("reports a duplicate label at the later definition", () => {
    const built = index({
      "main.tex": "\\input{a}\n\\input{b}",
      "a.tex": "\\label{key}",
      "b.tex": "\\label{key}",
    });

    expect(built.problems).toHaveLength(1);
    expect(built.problems[0]).toMatchObject({
      kind: "duplicate-label",
      file: "b.tex",
      subject: "key",
    });
  });

  it("checks citations against a .bib file", () => {
    const built = index({
      "main.tex": "\\bibliography{refs}\n\\cite{knuth1984}\n\\cite{ghost}",
      "refs.bib": "@book{knuth1984, title={The TeXbook}}",
    });

    expect(built.problems.map((problem) => problem.subject)).toEqual(["ghost"]);
  });

  it("checks citations against a hand-written bibliography", () => {
    // Three corpus projects have no `.bib` at all, including the two with the
    // most citations in them.
    const built = index({
      "main.tex": [
        "\\cite{knuth1984} \\cite{ghost}",
        "\\begin{thebibliography}{9}",
        "\\bibitem{knuth1984} Knuth, The TeXbook.",
        "\\end{thebibliography}",
      ].join("\n"),
    });

    expect(built.problems.map((problem) => problem.subject)).toEqual(["ghost"]);
  });

  it("says nothing about citations when the bibliography is elsewhere", () => {
    // `\bibliography{refs}` with no `refs.bib` in the project means the keys
    // live somewhere this index cannot see. Reporting all of them as undefined
    // would be worse than reporting none.
    const built = index({ "main.tex": "\\bibliography{refs}\n\\cite{knuth}" });

    expect(
      built.problems.filter((problem) => problem.kind === "undefined-citation"),
    ).toEqual([]);
  });

  it("reports an input and a graphic the project does not have", () => {
    const built = index({
      "main.tex": "\\input{missing}\n\\includegraphics{figures/plot}",
    });

    expect(built.problems.map((problem) => problem.kind)).toEqual([
      "missing-input",
      "missing-graphic",
    ]);
  });

  it("resolves an input and a graphic that were written without extensions", () => {
    const built = index({
      "main.tex": "\\input{chapter}\n\\includegraphics{plot}",
      "chapter.tex": "",
      "plot.pdf": "",
    });

    expect(built.problems).toEqual([]);
  });

  it("builds an outline that follows inputs in reading order", () => {
    // A thesis is a main file of `\input` lines and nothing else; an outline
    // that stopped at the file would show a document with no chapters.
    const built = index({
      "main.tex": [
        "\\section{Before}",
        "\\input{middle}",
        "\\section{After}",
      ].join("\n"),
      "middle.tex": "\\section{Middle}\n\\subsection{Detail}",
    });

    expect(
      built.outline.map((entry) => [entry.file, entry.title, entry.level]),
    ).toEqual([
      ["main.tex", "Before", 2],
      ["middle.tex", "Middle", 2],
      ["middle.tex", "Detail", 3],
      ["main.tex", "After", 2],
    ]);
  });

  it("does not loop on files that input each other", () => {
    // Nothing stops a user writing this, and TeX's own answer is a stack
    // overflow. An editor's outline should not be the second thing to crash.
    const built = index({
      "main.tex": "\\section{One}\n\\input{other}",
      "other.tex": "\\section{Two}\n\\input{main}",
    });

    expect(built.outline.map((entry) => entry.title)).toEqual(["One", "Two"]);
  });

  it("resolves a graphic under a \\graphicspath root", () => {
    // A project that sets one writes the bare name, and checking only the
    // literal path reports every figure in it as missing — on a document that
    // compiles perfectly.
    const built = index({
      "main.tex": "\\graphicspath{{figures/}}\n\\includegraphics{plot}",
      "figures/plot.png": "",
    });

    expect(built.problems).toEqual([]);
  });

  it("checks citations project-wide, not file by file", () => {
    // The preamble points at a .bib the project does not have, so the keys
    // live somewhere this cannot see. Applied per file, the chapter — which
    // declares no bibliography of its own — was checked anyway and every
    // citation in it was called undefined.
    const built = index({
      "main.tex": "\\input{preamble}\n\\input{chapter}",
      "preamble.tex": "\\addbibresource{shared/global.bib}",
      "chapter.tex": "\\cite{keyFromGlobal}",
      "local.bib": "@book{somethingElse, title={A book}}",
    });

    expect(
      built.problems.filter((problem) => problem.kind === "undefined-citation"),
    ).toEqual([]);
  });
});
