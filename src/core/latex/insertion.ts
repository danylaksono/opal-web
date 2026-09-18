/**
 * Where a structured editor may put something
 * (investigation.md 14, Phase 3: structured editors).
 *
 * The forms insert at the cursor, which is right whenever there is one. But a
 * file that has just been opened has its cursor at offset 0, and offset 0 is
 * in front of `\documentclass` — so a person who opened a project and reached
 * straight for "Insert maths" got an equation above the class, a document that
 * no longer compiles, and an error message about `\begin{document}` or about
 * `\normalsize` that says nothing about what they did.
 *
 * Preamble and body are different places. A table, a figure, a citation or an
 * equation belongs in the body; if the cursor is not there, the end of the
 * body is the closest thing to what was meant.
 */

import { maskComments } from "./comments";

const BEGIN = /\\begin\s*\{document\}/;
const END = /\\end\s*\{document\}/;

/**
 * The offset to insert at, given where the cursor is.
 *
 * A file with no `\begin{document}` — a chapter, an included fragment — is all
 * body, so the cursor stands. Otherwise the cursor is honoured inside the
 * body and replaced by the last line of it anywhere else.
 */
export function bodyInsertionPoint(source: string, cursor: number): number {
  const masked = maskComments(source);
  const begin = BEGIN.exec(masked);
  if (!begin) return cursor;

  const bodyFrom = begin.index + begin[0].length;
  const end = END.exec(masked);
  const bodyTo = end ? end.index : masked.length;

  if (cursor >= bodyFrom && cursor <= bodyTo) return cursor;

  // The start of the line `\end{document}` is on, so the insertion reads as
  // the last thing in the document rather than as part of that line.
  if (!end) return masked.length;
  return masked.lastIndexOf("\n", end.index - 1) + 1;
}
