import { describe, expect, it } from "vitest";
import { needsBibtex } from "@/platform/browser/compiler/texlyre-compiler";

/**
 * Whether to run bibtex is a question about citations, not about bibliographies.
 *
 * Getting that backwards cost `report-scientific` a ninth page for two months:
 * it declares `\bibliography{references}`, cites nothing, and running bibtex
 * wrote an empty `thebibliography` that the `report` class renders as a chapter
 * heading on a page desktop Tectonic does not have.
 */
describe("needsBibtex", () => {
  it("is true for the citation commands documents actually use", () => {
    expect(needsBibtex("text \\cite{smith}")).toBe(true);
    expect(needsBibtex("text \\citep{smith}")).toBe(true);
    expect(needsBibtex("text \\citet[p.~5]{smith}")).toBe(true);
    expect(needsBibtex("text \\citeauthor{smith}")).toBe(true);
    expect(needsBibtex("\\nocite{*}")).toBe(true);
  });

  it("is false for a bibliography that nothing cites", () => {
    // report-scientific, exactly: a declaration and no citation anywhere.
    expect(
      needsBibtex("\\bibliographystyle{plainnat}\n\\bibliography{references}"),
    ).toBe(false);
    expect(needsBibtex("\\printbibliography")).toBe(false);
    expect(needsBibtex("\\addbibresource{refs.bib}")).toBe(false);
  });

  it("does not read a comment as a command", () => {
    // thesis-standard comments its \bibliography out above a hand-written
    // thebibliography; a commented citation is not a citation either.
    expect(needsBibtex("% \\cite{smith}")).toBe(false);
    expect(needsBibtex("text % see \\cite{smith}")).toBe(false);
    expect(needsBibtex("\\bibitem[X(2006)]{key} not a citation")).toBe(false);
  });

  it("still sees a citation after an escaped percent sign", () => {
    // `\%` is a percent sign, not the start of a comment, so the rest of the
    // line is still code.
    expect(needsBibtex("100\\% agreement \\cite{smith}")).toBe(true);
  });

  it("sees the biblatex spellings, not only \\cite", () => {
    // These were invisible to the regular expression this replaced, so a
    // biblatex document's bibliography pass never ran — while the project
    // index, using the scanner, reported the very same keys as resolved.
    for (const command of [
      "parencite",
      "textcite",
      "autocite",
      "footcite",
      "fullcite",
    ]) {
      expect(needsBibtex(`\\${command}{knuth1984}`), command).toBe(true);
    }
  });

  it("is not fooled by a command that merely starts the same way", () => {
    expect(needsBibtex("\\pagecolor{white}")).toBe(false);
    expect(needsBibtex("\\notecolour{grey}")).toBe(false);
  });
});
