import { describe, expect, it } from "vitest";
import { bodyInsertionPoint } from "@/core/latex/insertion";

/**
 * Every case here is a cursor that is not where the person is looking.
 *
 * The one that cost a compile: a file opened but never clicked in has its
 * cursor at 0, and 0 is in front of `\documentclass`.
 */

const DOCUMENT = [
  "\\documentclass[11pt]{article}",
  "\\usepackage{graphicx}",
  "\\begin{document}",
  "Hello.",
  "\\end{document}",
  "",
].join("\n");

describe("bodyInsertionPoint", () => {
  it("honours a cursor that is already in the body", () => {
    const inside = DOCUMENT.indexOf("Hello.") + 3;
    expect(bodyInsertionPoint(DOCUMENT, inside)).toBe(inside);
  });

  it("moves an untouched cursor out of the preamble", () => {
    // Offset 0 is where a freshly opened file puts it, and inserting there
    // puts an equation above `\documentclass`.
    const at = bodyInsertionPoint(DOCUMENT, 0);
    expect(at).toBe(DOCUMENT.indexOf("\\end{document}"));
    expect(DOCUMENT.slice(0, at)).toContain("Hello.");
  });

  it("moves a cursor that is past the end of the document", () => {
    expect(bodyInsertionPoint(DOCUMENT, DOCUMENT.length)).toBe(
      DOCUMENT.indexOf("\\end{document}"),
    );
  });

  it("leaves a fragment alone, because all of it is body", () => {
    // A chapter reached by `\input` has no `\begin{document}` of its own.
    const chapter = "\\section{One}\nProse.\n";
    expect(bodyInsertionPoint(chapter, 0)).toBe(0);
    expect(bodyInsertionPoint(chapter, 8)).toBe(8);
  });

  it("is not fooled by a commented-out \\begin{document}", () => {
    const source = "% \\begin{document}\n\\documentclass{article}\n";
    // Nothing here is a body, so the cursor stands rather than being moved
    // into a document that does not exist.
    expect(bodyInsertionPoint(source, 0)).toBe(0);
  });

  it("puts the insertion on its own line, not inside \\end{document}", () => {
    const at = bodyInsertionPoint(DOCUMENT, 0);
    expect(DOCUMENT[at - 1]).toBe("\n");
  });
});
