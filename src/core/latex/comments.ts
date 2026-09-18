/**
 * Blank out comments, keeping every offset where it was.
 *
 * Three readers need this — the table reader, the citation reader and the
 * figure reader — and all three need the same rule: `%` opens a comment and
 * `\%` does not, because an escape consumes the character after it. That is
 * also what stops `\\%` being misread, which is a line break followed by a
 * comment.
 *
 * Masked rather than removed, so an offset into the masked text is the same
 * offset into the source. Every one of these readers hands back a span to
 * replace, and a span measured against a shortened string would cut the
 * document in the wrong place.
 */
export function maskComments(source: string): string {
  let masked = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      masked += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === "%") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      masked += " ".repeat(stop - index);
      index = stop;
      continue;
    }
    masked += character;
    index += 1;
  }
  return masked;
}
