import { describe, expect, it } from "vitest";
import { scanBib, scanTex } from "@/core/latex/scan";

/**
 * Each case here is a shape that broke a regular expression first.
 *
 * The scanner exists because `\label{([^}]*)\}` and friends look sufficient
 * until they meet a document someone actually wrote, and every test below is
 * one of those documents in miniature.
 */

describe("scanTex", () => {
  it("finds labels, references and citations with their lines", () => {
    const facts = scanTex(
      [
        "\\section{Method}",
        "\\label{sec:method}",
        "As shown in \\ref{sec:method}, and \\cite{knuth1984}.",
      ].join("\n"),
    );

    expect(facts.labels).toEqual([{ line: 2, key: "sec:method" }]);
    expect(facts.references).toEqual([{ line: 3, key: "sec:method" }]);
    expect(facts.citations).toEqual([{ line: 3, key: "knuth1984" }]);
  });

  it("ignores a commented-out command but not an escaped percent", () => {
    // The distinction that cost the compiler adapter a defect: a `%` opens a
    // comment, `\%` is a character, and a document with both must not lose the
    // label that follows the second one.
    const facts = scanTex(
      ["% \\label{old}", "Inflation of 40\\% \\label{tax}"].join("\n"),
    );

    expect(facts.labels).toEqual([{ line: 2, key: "tax" }]);
  });

  it("reads an argument that contains braces of its own", () => {
    const facts = scanTex("\\section{A \\textbf{bold} title}");
    expect(facts.sections[0]?.title).toBe("A \\textbf{bold} title");
  });

  it("reads an argument spread over several lines", () => {
    // Ordinary formatting in a paper with many references, and invisible to
    // any scan that works a line at a time.
    const facts = scanTex("\\cite{\n  knuth1984,\n  lamport1994\n}");
    expect(facts.citations.map((entry) => entry.key)).toEqual([
      "knuth1984",
      "lamport1994",
    ]);
    // The line of the command, which is where a diagnostic should point.
    expect(facts.citations[0]?.line).toBe(1);
  });

  it("skips the optional argument to reach the real one", () => {
    const facts = scanTex("\\section[Short]{The longer title}");
    expect(facts.sections[0]?.title).toBe("The longer title");
  });

  it("records starred sections as unnumbered", () => {
    const facts = scanTex("\\section*{Acknowledgements}");
    expect(facts.sections[0]).toMatchObject({
      title: "Acknowledgements",
      starred: true,
      level: 2,
    });
  });

  it("orders sections by level, not by appearance", () => {
    const facts = scanTex(
      ["\\chapter{One}", "\\section{Two}", "\\subsection{Three}"].join("\n"),
    );
    expect(facts.sections.map((entry) => entry.level)).toEqual([1, 2, 3]);
  });

  it("treats verbatim content as text rather than as commands", () => {
    // A tutorial showing a reader how to write a label must not thereby
    // declare one — nor lose the real label after it.
    const facts = scanTex(
      [
        "\\begin{verbatim}",
        "\\label{not-a-label}",
        "\\end{verbatim}",
        "\\label{real}",
      ].join("\n"),
    );

    expect(facts.labels).toEqual([{ line: 4, key: "real" }]);
  });

  it("survives an unfinished command at the end of a file", () => {
    // What a half-typed document looks like, which is most of them while
    // someone is writing.
    expect(() => scanTex("\\ref{")).not.toThrow();
    expect(() => scanTex("\\section")).not.toThrow();
    expect(scanTex("\\section").sections).toEqual([]);
  });

  it("collects inputs, bibliographies and graphics as written", () => {
    const facts = scanTex(
      [
        "\\input{chapters/one}",
        "\\includegraphics[width=0.5\\textwidth]{figures/plot.pdf}",
        "\\bibliography{refs,extra}",
      ].join("\n"),
    );

    expect(facts.inputs).toEqual([{ line: 1, target: "chapters/one" }]);
    expect(facts.graphics).toEqual([{ line: 2, target: "figures/plot.pdf" }]);
    expect(facts.bibResources.map((entry) => entry.target)).toEqual([
      "refs",
      "extra",
    ]);
  });

  it("reads every natbib and biblatex spelling of a citation", () => {
    const facts = scanTex(
      "\\citep{a} \\citet{b} \\textcite{c} \\autocite{d} \\nocite{e}",
    );
    expect(facts.citations.map((entry) => entry.key)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});

describe("scanBib", () => {
  it("finds entry keys and skips declarations that define none", () => {
    const keys = scanBib(
      [
        "@string{tex = {TeX}}",
        "@article{knuth1984,",
        "  title = {The {TeXbook}},",
        "}",
        "@inproceedings{ lamport1994 ,",
        "  year = {1994},",
        "}",
      ].join("\n"),
    );

    expect(keys).toEqual([
      { line: 2, key: "knuth1984" },
      { line: 5, key: "lamport1994" },
    ]);
  });
});
