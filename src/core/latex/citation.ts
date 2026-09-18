/**
 * Citations as something to pick from (PLAN.md 14, Phase 3: structured editors).
 *
 * Completion already offers a project's citation keys, and a key is exactly
 * what a writer cannot remember: `knuth1984` is recoverable, `vaswani2017`
 * mostly is, `DBLP:journals/corr/abs-1706-03762` is not. What they remember is
 * the author, a word of the title, roughly the year. This reads the
 * bibliography far enough to search it by those, finds the citation command
 * under the cursor, and writes back a new list of keys.
 *
 * The bibliography is read on demand, not in the per-keystroke index: field
 * parsing costs more than key scanning, and only the picker needs fields.
 */

import type { ProjectPath } from "@/core/project/ids";
import { maskComments } from "./comments";
import { CITATION_COMMANDS } from "./scan";

export interface BibEntry {
  key: string;
  /** Where it is defined: a `.bib` file, or a `.tex` with `\bibitem`. */
  file: ProjectPath;
  line: number;
  /** `article`, `book`…; `bibitem` for a hand-written bibliography. */
  type: string;
  /** "Knuth", "Knuth and Lamport", "Vaswani et al.", or empty. */
  authors: string;
  title: string;
  year: string;
  /**
   * Everything searchable, folded: lower case, accents and TeX markup removed.
   * Computed once when read, because it is compared on every keystroke of a
   * search.
   */
  haystack: string;
}

export interface Citation {
  /** Without the backslash: `cite`, `citep`, `parencite`. */
  command: string;
  starred: boolean;
  /** `\citep[see][p.~4]{…}`: the prenote, when there are two optionals. */
  prenote: string;
  /** The postnote: the only optional there is, or the second of two. */
  postnote: string;
  keys: string[];
  from: number;
  to: number;
  /** The source the span held when read; checked before writing back. */
  original: string;
}

export type CitationLookup =
  | { ok: true; citation: Citation }
  | { ok: false; reason: string };

/** TeX's accent commands, as the combining marks Unicode spells them with. */
const ACCENTS: Record<string, string> = {
  "'": "\u0301",
  "`": "\u0300",
  "^": "\u0302",
  '"': "\u0308",
  "~": "\u0303",
  "=": "\u0304",
  ".": "\u0307",
  u: "\u0306",
  v: "\u030c",
  H: "\u030b",
  c: "\u0327",
  k: "\u0328",
};

const LETTERS: Record<string, string> = {
  ss: "ß",
  o: "ø",
  O: "Ø",
  ae: "æ",
  AE: "Æ",
  oe: "œ",
  OE: "Œ",
  aa: "å",
  AA: "Å",
  l: "ł",
  L: "Ł",
  i: "ı",
};

/**
 * A field value as a reader sees it: `G{\"o}del` is `Gödel`, `The {\TeX}book`
 * is `The TeXbook`, `--` is a dash.
 */
export function plainTex(value: string): string {
  return (
    value
      // `\"o`, `\"{o}`, `{\"o}` and `\c{c}`: an accent and the letter it sits on.
      .replace(
        /\\(['`^"~=.]|[uvHck](?=[\s{]))\s*\{?\s*([a-zA-Z])\}?/g,
        (_, accent: string, letter: string) =>
          `${letter}${ACCENTS[accent] ?? ""}`,
      )
      .replace(
        /\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i)(?![a-zA-Z])\s?/g,
        (_, name: string) => LETTERS[name] ?? name,
      )
      .replace(/\\&/g, "&")
      .replace(/---/g, "—")
      .replace(/--/g, "–")
      .replace(/~/g, " ")
      // A command wrapping an argument is formatting — `\emph{x}` reads as x —
      // and so is a bibliography's own punctuation. Anything else keeps its
      // name, so `{\TeX}book` reads as TeXbook; braces are grouping, not text.
      .replace(/\\([a-zA-Z]+)\{\}/g, "$1")
      .replace(/\\[a-zA-Z]+\s*(?=\{)/g, "")
      .replace(
        /\\(?:newblock|par|relax|em|it|bf|sc|sl|rm|tt|sf)(?![a-zA-Z])\s*/g,
        " ",
      )
      .replace(/\\([a-zA-Z]+)\s*/g, "$1")
      .replace(/[{}]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .normalize("NFC")
  );
}

/** Lower case with accents removed, so "godel" finds "Gödel". */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Split at top-level ` and `, the way BibTeX does.
 *
 * `{Barnes and Noble}` is one corporate author, and a naive split makes two.
 */
function splitNames(value: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (
      depth === 0 &&
      /\s/.test(character ?? "") &&
      /^\s+and\s/i.test(value.slice(index, index + 6))
    ) {
      names.push(value.slice(start, index));
      index += /^\s+and/i.exec(value.slice(index))?.[0].length ?? 0;
      start = index;
    }
  }
  names.push(value.slice(start));
  return names.map((name) => name.trim()).filter(Boolean);
}

/** `Knuth, Donald E.` and `Donald E. Knuth` are both Knuth. */
function surname(name: string): string {
  const trimmed = name.trim();
  if (/^\{.*\}$/.test(trimmed)) return plainTex(trimmed);
  const comma = trimmed.indexOf(",");
  if (comma !== -1) return plainTex(trimmed.slice(0, comma));
  const words = plainTex(trimmed).split(" ");
  return words.at(-1) ?? "";
}

/**
 * `and others` is BibTeX for "et al.", so it counts as more authors even
 * though it names none — dropping it first made "A and B and others" read as
 * two authors.
 */
function describeAuthors(value: string): string {
  const all = splitNames(value);
  const truncated = all.some((name) => name === "others");
  const names = all.filter((name) => name !== "others").map(surname);
  const first = names[0] ?? "";
  if (names.length === 0) return "";
  if (truncated || names.length > 2) return `${first} et al.`;
  return names.length === 2 ? `${first} and ${names[1]}` : first;
}

/** Read a `{…}`, `"…"` or bare value starting at `at`. */
function readValue(
  source: string,
  at: number,
): { value: string; next: number } | null {
  const open = source[at];
  if (open === "{" || open === '"') {
    let depth = 0;
    for (let index = at; index < source.length; index += 1) {
      const character = source[index];
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      const closed =
        open === "{" ? depth === 0 : character === '"' && index > at;
      if (closed && depth === 0) {
        return { value: source.slice(at + 1, index), next: index + 1 };
      }
    }
    return null;
  }
  const bare = /^[^,}\s]+/.exec(source.slice(at, at + 200));
  return bare ? { value: bare[0], next: at + bare[0].length } : null;
}

const ENTRY = /@([a-zA-Z]+)\s*\{\s*([^,\s}]+)\s*,/g;
const NOT_ENTRIES = new Set(["string", "preamble", "comment"]);
const FIELD = /\s*([a-zA-Z][\w-]*)\s*=\s*/y;

/**
 * Entries in a `.bib` file, with the fields a person searches by.
 *
 * A field it cannot read ends that entry's fields, not the file: the key is
 * already known, and an entry with a key and no title is still citable.
 */
export function readBib(source: string, file: ProjectPath): BibEntry[] {
  const entries: BibEntry[] = [];
  let line = 1;
  let counted = 0;
  for (const match of source.matchAll(ENTRY)) {
    for (let at = counted; at < match.index; at += 1) {
      if (source[at] === "\n") line += 1;
    }
    counted = match.index;
    const type = (match[1] ?? "").toLowerCase();
    const key = match[2];
    if (!key || NOT_ENTRIES.has(type)) continue;

    const fields: Record<string, string> = {};
    let at = match.index + match[0].length;
    for (;;) {
      FIELD.lastIndex = at;
      const field = FIELD.exec(source);
      if (!field) break;
      const read = readValue(source, FIELD.lastIndex);
      if (!read) break;
      fields[(field[1] ?? "").toLowerCase()] = read.value;
      at = read.next;
      const comma = /^\s*,/.exec(source.slice(at, at + 50));
      if (!comma) break;
      at += comma[0].length;
    }

    entries.push(
      entry({
        key,
        file,
        line,
        type,
        authors: describeAuthors(fields.author ?? fields.editor ?? ""),
        title: plainTex(fields.title ?? ""),
        // biblatex writes `date = {2017-06-12}` where BibTeX writes `year`.
        year: plainTex(fields.year ?? fields.date?.slice(0, 4) ?? ""),
        extra: `${plainTex(fields.author ?? fields.editor ?? "")} ${plainTex(
          fields.journal ?? fields.booktitle ?? fields.publisher ?? "",
        )}`,
      }),
    );
  }
  return entries;
}

/**
 * `\bibitem` entries from a hand-written `thebibliography`.
 *
 * There are no fields, only typeset text, so all of it becomes the title and
 * all of it is searched. That is enough to find `Knuth` in
 * `D.~E. Knuth. \emph{The TeXbook}. Addison-Wesley, 1984.`
 */
export function readBibItems(source: string, file: ProjectPath): BibEntry[] {
  const entries: BibEntry[] = [];
  const pattern =
    /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}([\s\S]*?)(?=\\bibitem|\\end\s*\{thebibliography\}|$)/g;
  for (const match of source.matchAll(pattern)) {
    const key = (match[1] ?? "").trim();
    if (!key) continue;
    const text = plainTex((match[2] ?? "").replace(/%.*$/gm, ""));
    entries.push(
      entry({
        key,
        file,
        line: source.slice(0, match.index).split("\n").length,
        type: "bibitem",
        authors: "",
        title: text.length > 160 ? `${text.slice(0, 157)}…` : text,
        year: /\b(1[5-9]\d\d|20\d\d)\b/.exec(text)?.[1] ?? "",
        extra: text,
      }),
    );
  }
  return entries;
}

function entry(
  fields: Omit<BibEntry, "haystack"> & { extra: string },
): BibEntry {
  const { extra, ...rest } = fields;
  return {
    ...rest,
    haystack: fold(
      [rest.key, rest.authors, rest.title, rest.year, extra].join(" "),
    ),
  };
}

/**
 * Every entry a project defines, first definition of a key winning — which is
 * also the one the index's duplicate check treats as the real one.
 */
export function readBibliography(
  files: readonly { path: ProjectPath; content: string }[],
): BibEntry[] {
  const seen = new Set<string>();
  const entries: BibEntry[] = [];
  for (const file of files) {
    const found = file.path.endsWith(".bib")
      ? readBib(file.content, file.path)
      : /\.(tex|ltx)$/.test(file.path)
        ? readBibItems(file.content, file.path)
        : [];
    for (const item of found) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      entries.push(item);
    }
  }
  return entries;
}

/**
 * Entries matching every word of `query`, best first.
 *
 * Every word must appear somewhere, in any order: "lamport 94" and "94
 * lamport" are the same search. A key that starts with the query ranks first,
 * because someone typing a key prefix already knows which entry they mean.
 */
export function searchBibliography(
  entries: readonly BibEntry[],
  query: string,
): BibEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  const folded = fold(query.trim());
  return entries
    .filter((item) => words.every((word) => item.haystack.includes(word)))
    .sort(
      (left, right) =>
        Number(fold(right.key).startsWith(folded)) -
        Number(fold(left.key).startsWith(folded)),
    );
}

/**
 * Commands worth offering, from the packages the project loads.
 *
 * Offering `\parencite` in a document without biblatex is offering an
 * undefined control sequence. The command already in the document is always
 * kept, whatever this says.
 */
export function citationCommands(packages: ReadonlySet<string>): string[] {
  const offered = ["cite"];
  if (packages.has("natbib")) {
    offered.push("citep", "citet", "citealp", "citeauthor", "citeyear");
  }
  if (packages.has("biblatex")) {
    offered.push("parencite", "textcite", "autocite", "footcite");
  }
  offered.push("nocite");
  return offered.filter((name) => CITATION_COMMANDS.has(name));
}

/**
 * The citation command around `offset`: from its backslash to its closing
 * brace, so a cursor on the command name counts as much as one on a key.
 */
export function citationAt(
  source: string,
  offset: number,
): CitationLookup | null {
  const masked = maskComments(source);
  const pattern = /\\([a-zA-Z]+)(\*?)/g;
  for (const match of masked.matchAll(pattern)) {
    if (match.index > offset) break;
    const command = match[1] ?? "";
    if (!CITATION_COMMANDS.has(command)) continue;

    let at = match.index + match[0].length;
    const optionals: string[] = [];
    for (;;) {
      const space = /^\s*/.exec(masked.slice(at))?.[0].length ?? 0;
      if (masked[at + space] !== "[") break;
      const close = masked.indexOf("]", at + space);
      if (close === -1) break;
      optionals.push(source.slice(at + space + 1, close));
      at = close + 1;
    }
    const space = /^\s*/.exec(masked.slice(at))?.[0].length ?? 0;
    const open = at + space;
    const from = match.index;

    if (masked[open] !== "{") {
      // `\cite` with nothing after it yet: the cursor is on it, and it is not
      // something the editor can write back without inventing its argument.
      if (offset <= open) {
        return { ok: false, reason: "it has no key argument yet" };
      }
      continue;
    }
    const close = masked.indexOf("}", open);
    if (close === -1) {
      if (offset >= from) {
        return { ok: false, reason: "its key argument is not closed" };
      }
      continue;
    }
    const to = close + 1;
    if (offset < from || offset > to) continue;
    if (optionals.length > 2) {
      return { ok: false, reason: "it has more optional arguments than two" };
    }

    return {
      ok: true,
      citation: {
        command,
        starred: match[2] === "*",
        prenote: optionals.length === 2 ? (optionals[0] ?? "") : "",
        postnote: optionals.at(-1) ?? "",
        // Masked, so a key list broken across lines with a comment on one of
        // them does not gain the comment as a key.
        keys: masked
          .slice(open + 1, close)
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean),
        from,
        to,
        original: source.slice(from, to),
      },
    };
  }
  return null;
}

/** An empty `\cite{}` to insert at `offset`. */
export function newCitation(offset: number): Citation {
  return {
    command: "cite",
    starred: false,
    prenote: "",
    postnote: "",
    keys: [],
    from: offset,
    to: offset,
    original: "",
  };
}

/**
 * Write a citation back.
 *
 * A prenote with no postnote still needs the empty second optional —
 * `\citep[see][]{key}` — because natbib reads a single optional as the
 * postnote, and `\citep[see]{key}` renders as "(key, see)".
 */
export function formatCitation(citation: Citation): string {
  const notes = citation.prenote
    ? `[${citation.prenote}][${citation.postnote}]`
    : citation.postnote
      ? `[${citation.postnote}]`
      : "";
  return `\\${citation.command}${citation.starred ? "*" : ""}${notes}{${citation.keys.join(",")}}`;
}

/** A key BibTeX will accept: no whitespace, comma, brace, `#` or `%`. */
export function isCitationKey(text: string): boolean {
  return /^[^\s,{}#%"=()\\]+$/.test(text);
}
