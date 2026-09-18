/**
 * Displayed mathematics as a body and a kind
 * (PLAN.md 14, Phase 3: structured editors).
 *
 * The form's job is small and specific: choose how the maths is displayed,
 * write the body with a preview beside it, and name it so `\eqref` can reach
 * it. Everything inside the body is the author's, and is carried through
 * untouched — this reader does not parse mathematics, and nothing here would
 * be improved by trying.
 *
 * **Inline `$…$` is written but never read.** Pairing dollars in a real
 * document means deciding whether the `$` ending one expression opens the
 * next, across lines, through `\$`, and inside verbatim; getting it wrong
 * replaces a span that was never maths. Inserting `$x$` is safe and useful, so
 * the form offers it; `mathAt` answers only for delimiters that cannot be
 * mistaken for anything else.
 */

import { maskComments } from "./comments";

export type MathKind =
  | "inline"
  | "display"
  | "equation"
  | "align"
  | "gather"
  | "multline";

/** Environments amsmath provides, each with a starred, unnumbered form. */
const ENVIRONMENTS = ["equation", "align", "gather", "multline"] as const;

export interface MathBlock {
  kind: MathKind;
  /** `equation*` and friends: displayed, but not numbered. */
  starred: boolean;
  /** Exactly what stands between the delimiters, minus the label. */
  body: string;
  /** `\label{eq:euler}`, lifted out of the body so the form owns it. */
  label: string;
  from: number;
  to: number;
  /** The source the span held when read; checked before writing back. */
  original: string;
  indent: string;
  lead: string;
}

export type MathLookup =
  | { ok: true; math: MathBlock }
  | { ok: false; reason: string };

const LABEL = /\\label\s*\{([^}]*)\}/;

/** The whitespace a line starts with, for the line containing `offset`. */
function indentAt(source: string, offset: number): string {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(start))?.[0] ?? "";
}

/** A span of the masked source, with what it means. */
interface Span {
  kind: MathKind;
  starred: boolean;
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
}

function spansIn(masked: string): Span[] {
  const spans: Span[] = [];

  const environments = new RegExp(
    `\\\\begin\\s*\\{(${ENVIRONMENTS.join("|")})(\\*?)\\}([\\s\\S]*?)\\\\end\\s*\\{\\1\\2\\}`,
    "g",
  );
  for (const match of masked.matchAll(environments)) {
    const body = match[3] ?? "";
    const bodyFrom =
      match.index +
      (match[0].length - body.length) -
      `\\end{${match[1]}${match[2]}}`.length;
    spans.push({
      kind: (match[1] ?? "equation") as MathKind,
      starred: match[2] === "*",
      from: match.index,
      to: match.index + match[0].length,
      bodyFrom,
      bodyTo: bodyFrom + body.length,
    });
  }

  // `\[…\]` and `$$…$$`: both unambiguous, unlike a single dollar.
  for (const match of masked.matchAll(/\\\[([\s\S]*?)\\\]/g)) {
    spans.push({
      kind: "display",
      starred: false,
      from: match.index,
      to: match.index + match[0].length,
      bodyFrom: match.index + 2,
      bodyTo: match.index + 2 + (match[1] ?? "").length,
    });
  }
  for (const match of masked.matchAll(/\$\$([\s\S]*?)\$\$/g)) {
    spans.push({
      kind: "display",
      starred: false,
      from: match.index,
      to: match.index + match[0].length,
      bodyFrom: match.index + 2,
      bodyTo: match.index + 2 + (match[1] ?? "").length,
    });
  }

  return spans;
}

/**
 * The displayed mathematics around `offset`.
 *
 * Innermost first, so a `matrix` inside an `equation` gives the equation — the
 * inner one is body, and the body is what the form edits.
 */
export function mathAt(source: string, offset: number): MathLookup | null {
  const masked = maskComments(source);
  const found = spansIn(masked)
    .filter((span) => offset >= span.from && offset <= span.to)
    .sort((left, right) => right.from - left.from)[0];
  if (!found) return null;

  const original = source.slice(found.from, found.to);
  if (maskComments(original) !== original) {
    return {
      ok: false,
      reason: "it contains comments, which the form has nowhere to keep",
    };
  }

  const raw = source.slice(found.bodyFrom, found.bodyTo);
  const label = LABEL.exec(raw)?.[1]?.trim() ?? "";
  return {
    ok: true,
    math: {
      kind: found.kind,
      starred: found.starred,
      // The label is lifted out: the form owns it as a field, and leaving it
      // in the body as well would write it twice.
      body: raw.replace(LABEL, "").trim(),
      label,
      from: found.from,
      to: found.to,
      original,
      indent: indentAt(source, found.from),
      lead: "",
    },
  };
}

/** Maths to insert at `offset`, displayed unless it is inline. */
export function newMath(
  source: string,
  offset: number,
  kind: MathKind = "equation",
): MathBlock {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const before = source.slice(lineStart, offset);
  const indent = /^[ \t]*/.exec(before)?.[0] ?? "";
  return {
    kind,
    starred: false,
    body: "",
    label: "",
    from: offset,
    to: offset,
    original: "",
    indent,
    // Inline maths belongs in the sentence it is part of; displayed maths does
    // not, and a `\begin{equation}` mid-line is almost never meant.
    lead: kind !== "inline" && before.trim().length > 0 ? `\n${indent}` : "",
  };
}

/** Whether this kind can carry a number, and so a `\label` worth referring to. */
export function isNumbered(math: Pick<MathBlock, "kind" | "starred">): boolean {
  return math.kind !== "inline" && math.kind !== "display" && !math.starred;
}

/** The maths written back as source. */
export function writeMath(math: MathBlock): string {
  const body = math.body.trim();
  if (math.kind === "inline") return `${math.lead}$${body}$`;

  const inner = `${math.indent}  `;
  // A label on an unnumbered environment is a reference to a number that will
  // never be printed, so it is written only where it means something.
  const label =
    isNumbered(math) && math.label.trim()
      ? `\n${inner}\\label{${math.label.trim()}}`
      : "";

  if (math.kind === "display") {
    return `${math.lead}\\[\n${inner}${body}\n${math.indent}\\]`;
  }

  const environment = `${math.kind}${math.starred ? "*" : ""}`;
  return `${math.lead}\\begin{${environment}}\n${inner}${body}${label}\n${math.indent}\\end{${environment}}`;
}

/**
 * The first unbalanced delimiter in a body, if there is one.
 *
 * Said rather than enforced: this is the mistake that makes TeX report an
 * error hundreds of lines later, in a place that has nothing to do with it.
 */
export function delimiterProblem(body: string): string | null {
  const closing: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? "";
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (closing[character]) {
      stack.push(closing[character]);
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      if (stack.pop() !== character) {
        return `An unmatched ${character}`;
      }
    }
  }
  const unclosed = stack.pop();
  return unclosed ? `A ${unclosed} is missing` : null;
}
