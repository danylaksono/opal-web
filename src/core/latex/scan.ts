/**
 * What a single LaTeX source says about itself (PLAN.md 14, Phase 3).
 *
 * The semantic index everything else in Phase 3 needs — completion,
 * cross-references, an outline, project health — starts here: one file in,
 * facts with line numbers out. It is deliberately a scanner and not a parser.
 * TeX is macro-expanded, not parsed, and the only thing that truly knows what a
 * document means is TeX; what an editor needs is different and much smaller —
 * where the labels are, what is referenced, what is cited, which files are
 * pulled in — and that is recoverable without expanding anything.
 *
 * It is a character scanner rather than a set of regular expressions, because
 * every regular expression that looks sufficient here is wrong on a real
 * document:
 *
 * - `%` starts a comment, so `% \label{old}` is not a label — but `\%` is a
 *   percent sign and `40\% \label{tax}` is one. The compiler adapter learned
 *   this the expensive way, from `thesis-standard`'s commented-out
 *   `\bibliography`.
 * - `\section{A \textbf{B}}` needs brace matching. A lazy `\{([^}]*)\}` takes
 *   `A \textbf{B` and a greedy one swallows the rest of the file.
 * - Arguments cross lines. `\cite{\n  knuth1984,\n  lamport1994\n}` is ordinary
 *   formatting and a line-based scan reports no citations at all.
 * - `\section[Short]{Long}` puts an optional argument in the way.
 * - Inside `verbatim` and `lstlisting`, none of the above applies: a `\label`
 *   there is text being shown to the reader, not a label being declared.
 */

export interface TexPosition {
  /** 1-based, because it is shown to a person and used to jump. */
  line: number;
}

export interface TexSection extends TexPosition {
  /** 0 for `\part`, rising to 6 for `\subparagraph`. */
  level: number;
  title: string;
  /** `\section*` does not number and does not enter the table of contents. */
  starred: boolean;
}

export interface TexKey extends TexPosition {
  key: string;
}

export interface TexFileReference extends TexPosition {
  /** Exactly as written: `chapter`, not `chapter.tex`. */
  target: string;
}

export interface TexFacts {
  sections: TexSection[];
  labels: TexKey[];
  references: TexKey[];
  citations: TexKey[];
  /**
   * `\bibitem{key}`: a citation key defined in the document itself.
   *
   * Three of the fourteen corpus projects have no `.bib` file at all and write
   * a `thebibliography` environment by hand — including both of the ones with
   * the most citations. Reading only `.bib` files would report every one of
   * their citations as undefined, which is worse than reporting nothing.
   */
  bibItems: TexKey[];
  inputs: TexFileReference[];
  /** `\bibliography{refs}` and `\addbibresource{refs.bib}`. */
  bibResources: TexFileReference[];
  graphics: TexFileReference[];
  /**
   * Packages the file loads.
   *
   * Kept because some packages define labels: `\pageref{LastPage}` is a
   * correct document with `lastpage` loaded and a typo without it, and only the
   * `\usepackage` line can tell those apart.
   */
  packages: string[];
}

const SECTION_LEVELS = new Map([
  ["part", 0],
  ["chapter", 1],
  ["section", 2],
  ["subsection", 3],
  ["subsubsection", 4],
  ["paragraph", 5],
  ["subparagraph", 6],
]);

/** Commands whose argument is a comma-separated list of label keys. */
const REFERENCE_COMMANDS = new Set([
  "ref",
  "eqref",
  "pageref",
  "autoref",
  "cref",
  "Cref",
  "crefrange",
  "nameref",
  "vref",
]);

/**
 * Commands whose argument is a comma-separated list of citation keys.
 *
 * natbib, biblatex and plain LaTeX spell this eleven ways between them, and a
 * document that uses `\textcite` is not less cited than one using `\cite`.
 */
const CITATION_COMMANDS = new Set([
  "cite",
  "citep",
  "citet",
  "citealp",
  "citealt",
  "citeauthor",
  "citeyear",
  "citeyearpar",
  "nocite",
  "parencite",
  "textcite",
  "autocite",
  "footcite",
  "fullcite",
]);

/** Environments whose contents are shown rather than interpreted. */
const VERBATIM_ENVIRONMENTS = new Set([
  "verbatim",
  "Verbatim",
  "lstlisting",
  "minted",
  "alltt",
  "comment",
]);

interface Cursor {
  index: number;
  line: number;
}

/** Advance past `count` characters, keeping the line number honest. */
function advance(source: string, cursor: Cursor, count: number): void {
  for (let step = 0; step < count && cursor.index < source.length; step += 1) {
    if (source[cursor.index] === "\n") cursor.line += 1;
    cursor.index += 1;
  }
}

/**
 * Read a balanced `{...}` group, skipping whitespace and any `[...]` before it.
 *
 * Returns null when the next thing is not an argument at all, which is how
 * `\section` at the end of a truncated file, or a `\ref` the user has not
 * finished typing, stops being a crash.
 */
function readArgument(source: string, cursor: Cursor): string | null {
  const start = { ...cursor };

  // Whitespace, then optional arguments, then the mandatory one. `\cite  [p.
  // 4] {knuth}` is legal and ugly, and both of those gaps may hold newlines.
  for (;;) {
    while (
      cursor.index < source.length &&
      /\s/.test(source[cursor.index] ?? "")
    ) {
      advance(source, cursor, 1);
    }
    if (source[cursor.index] !== "[") break;
    let depth = 0;
    do {
      if (source[cursor.index] === "[") depth += 1;
      if (source[cursor.index] === "]") depth -= 1;
      advance(source, cursor, 1);
    } while (cursor.index < source.length && depth > 0);
  }

  if (source[cursor.index] !== "{") {
    // Not an argument: rewind, so the scanner sees whatever this actually is.
    cursor.index = start.index;
    cursor.line = start.line;
    return null;
  }

  let depth = 0;
  const from = cursor.index + 1;
  do {
    const character = source[cursor.index];
    // A brace can be escaped, and `\{` inside a title is a brace the reader
    // sees rather than one that closes the argument.
    if (character === "\\") {
      advance(source, cursor, 2);
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    advance(source, cursor, 1);
  } while (cursor.index < source.length && depth > 0);

  return source.slice(from, Math.max(from, cursor.index - 1));
}

/** Split `a, b , c` into keys, dropping the empties a trailing comma leaves. */
function keys(argument: string): string[] {
  return argument
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

export function scanTex(source: string): TexFacts {
  const facts: TexFacts = {
    sections: [],
    labels: [],
    references: [],
    citations: [],
    bibItems: [],
    inputs: [],
    bibResources: [],
    graphics: [],
    packages: [],
  };
  const cursor: Cursor = { index: 0, line: 1 };

  while (cursor.index < source.length) {
    const character = source[cursor.index];

    if (character === "%") {
      while (cursor.index < source.length && source[cursor.index] !== "\n") {
        advance(source, cursor, 1);
      }
      continue;
    }

    if (character !== "\\") {
      advance(source, cursor, 1);
      continue;
    }

    const name = /^[a-zA-Z]+\*?/.exec(source.slice(cursor.index + 1))?.[0];
    if (!name) {
      // An escaped character: `\%`, `\$`, `\\`. Both characters are consumed,
      // which is what stops `\%` from opening a comment.
      advance(source, cursor, 2);
      continue;
    }
    const line = cursor.line;
    advance(source, cursor, 1 + name.length);

    if (name === "begin") {
      const environment = readArgument(source, cursor);
      if (environment && VERBATIM_ENVIRONMENTS.has(environment)) {
        const closing = `\\end{${environment}}`;
        const end = source.indexOf(closing, cursor.index);
        // An unterminated verbatim swallows the rest of the file, which is also
        // what TeX does with it.
        advance(
          source,
          cursor,
          (end === -1 ? source.length : end + closing.length) - cursor.index,
        );
      }
      continue;
    }

    const bare = name.endsWith("*") ? name.slice(0, -1) : name;

    if (SECTION_LEVELS.has(bare)) {
      const title = readArgument(source, cursor);
      if (title !== null) {
        facts.sections.push({
          line,
          level: SECTION_LEVELS.get(bare) ?? 0,
          title: title.trim(),
          starred: name.endsWith("*"),
        });
      }
      continue;
    }

    if (bare === "label") {
      const argument = readArgument(source, cursor);
      if (argument) facts.labels.push({ line, key: argument.trim() });
      continue;
    }

    if (REFERENCE_COMMANDS.has(bare)) {
      const argument = readArgument(source, cursor);
      for (const key of keys(argument ?? "")) {
        facts.references.push({ line, key });
      }
      continue;
    }

    if (CITATION_COMMANDS.has(bare)) {
      const argument = readArgument(source, cursor);
      for (const key of keys(argument ?? "")) {
        facts.citations.push({ line, key });
      }
      continue;
    }

    if (bare === "bibitem") {
      const argument = readArgument(source, cursor);
      if (argument) facts.bibItems.push({ line, key: argument.trim() });
      continue;
    }

    if (bare === "usepackage" || bare === "RequirePackage") {
      const argument = readArgument(source, cursor);
      facts.packages.push(...keys(argument ?? ""));
      continue;
    }

    if (bare === "input" || bare === "include" || bare === "subfile") {
      const argument = readArgument(source, cursor);
      if (argument) facts.inputs.push({ line, target: argument.trim() });
      continue;
    }

    if (bare === "bibliography" || bare === "addbibresource") {
      const argument = readArgument(source, cursor);
      for (const target of keys(argument ?? "")) {
        facts.bibResources.push({ line, target });
      }
      continue;
    }

    if (bare === "includegraphics") {
      const argument = readArgument(source, cursor);
      if (argument) facts.graphics.push({ line, target: argument.trim() });
    }
  }

  return facts;
}

/**
 * The citation keys a `.bib` file defines.
 *
 * Entry types are open-ended — biblatex adds its own and styles add more — so
 * this takes any `@word{key,` rather than a list of known types, and skips
 * `@string`, `@preamble` and `@comment`, which declare no entry.
 */
const BIB_ENTRY = /@([a-zA-Z]+)\s*\{\s*([^,\s}]+)\s*,/g;
const NOT_ENTRIES = new Set(["string", "preamble", "comment"]);

export function scanBib(source: string): TexKey[] {
  const found: TexKey[] = [];
  BIB_ENTRY.lastIndex = 0;
  for (const match of source.matchAll(BIB_ENTRY)) {
    if (NOT_ENTRIES.has((match[1] ?? "").toLowerCase())) continue;
    const key = match[2];
    if (!key) continue;
    const line = source.slice(0, match.index).split("\n").length;
    found.push({ line, key });
  }
  return found;
}
