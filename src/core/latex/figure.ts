/**
 * A `figure` as the few things a person fills in
 * (investigation.md 14, Phase 3: structured editors).
 *
 * A figure is five decisions — which image, how wide, what it says, what to
 * call it, where it may float — wrapped in an environment whose syntax is easy
 * to get subtly wrong: a `\label` before its `\caption` numbers the section
 * rather than the figure, and a width given in the wrong unit silently
 * overflows the margin.
 *
 * Unlike the table reader, this **edits in place** rather than regenerating.
 * A figure body legitimately holds things this knows nothing about —
 * `\subcaptionbox`, `\vspace`, a `\footnotesize` — and rewriting the
 * environment from its five fields would delete them. What is recognised is
 * replaced; everything else is left exactly where the author put it.
 */

import { maskComments } from "./comments";

export interface FigureDraft {
  /**
   * The image, spelled as the project spells it.
   *
   * Written exactly as the file list gives it, because that is what the index
   * resolves against: a basename where the project holds `figures/plot.png`
   * compiles (TeX searches `\graphicspath`) but makes project health report a
   * missing graphic, which is the false positive the corpus index test exists
   * to prevent.
   */
  path: string;
  caption: string;
  label: string;
  /**
   * `htbp` and friends, or null when the environment has no `[...]` at all.
   *
   * The distinction is kept because adding one is not a neutral act: an author
   * who wrote `\begin{figure}` chose the class's default, and editing a
   * caption should not quietly pin the float.
   */
  placement: string | null;
  /** A percentage of `widthUnit`, or null when no width option is written. */
  widthPercent: number | null;
  centered: boolean;
}

export interface Figure extends FigureDraft {
  /** `figure` or `figure*`. */
  environment: string;
  from: number;
  to: number;
  /** The source the span held when read; checked before writing back. */
  original: string;
  /** `\linewidth`, `\textwidth`, `\columnwidth` — whichever was written. */
  widthUnit: string;
  /** Graphic options that are not the width: `keepaspectratio`, `angle=90`. */
  otherOptions: string[];
  /** The `\begin` line's own indentation, which the body is indented from. */
  indent: string;
  /** Text written before the figure: a line break when inserting mid-line. */
  lead: string;
}

export type FigureLookup =
  | { ok: true; figure: Figure }
  | { ok: false; reason: string };

const BEGIN = /\\begin\s*\{(figure\*?)\}[ \t]*(?:\[([^\]]*)\])?/g;
const GRAPHIC = /\\includegraphics\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;
const CAPTION = /\\caption(?:\[[^\]]*\])?\s*\{([^}]*)\}/;
const LABEL = /\\label\s*\{([^}]*)\}/;
const CENTERING = /\\centering\b/;
const WIDTH = /^width\s*=\s*([0-9]*\.?[0-9]+)\s*(\\[a-zA-Z]+)$/i;

const DEFAULT_UNIT = "\\linewidth";

/** Split `width=0.8\linewidth, keepaspectratio` into what each part means. */
function readOptions(options: string | undefined): {
  widthPercent: number | null;
  widthUnit: string;
  otherOptions: string[];
} {
  let widthPercent: number | null = null;
  let widthUnit = DEFAULT_UNIT;
  const otherOptions: string[] = [];
  for (const part of (options ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const width = WIDTH.exec(trimmed);
    if (width) {
      widthPercent = Math.round(Number(width[1]) * 100);
      // The unit the author wrote, kept: `\linewidth` and `\textwidth` differ
      // in two-column documents, and swapping them is a layout change nobody
      // asked for.
      widthUnit = width[2] ?? DEFAULT_UNIT;
      continue;
    }
    otherOptions.push(trimmed);
  }
  return { widthPercent, widthUnit, otherOptions };
}

function writeOptions(
  figure: FigureDraft & {
    widthUnit: string;
    otherOptions: string[];
  },
): string {
  const width =
    figure.widthPercent === null
      ? []
      : [
          `width=${Math.max(1, Math.min(200, figure.widthPercent)) / 100}${figure.widthUnit}`,
        ];
  return [...width, ...figure.otherOptions].join(",");
}

/** The whitespace a line starts with, for the line containing `offset`. */
function indentAt(source: string, offset: number): string {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(start))?.[0] ?? "";
}

/**
 * The figure environment around `offset`, or a reason it cannot be edited.
 *
 * Returns null when the cursor is not in one at all, which is what makes the
 * button read "Insert figure" instead.
 */
export function figureAt(source: string, offset: number): FigureLookup | null {
  const masked = maskComments(source);
  BEGIN.lastIndex = 0;
  for (const begin of masked.matchAll(BEGIN)) {
    const environment = begin[1] ?? "figure";
    const closing = `\\end{${environment}}`;
    const end = masked.indexOf(closing, begin.index);
    if (end === -1) continue;
    const to = end + closing.length;
    if (offset < begin.index || offset > to) continue;

    const from = begin.index;
    const body = source.slice(from, to);
    if (maskComments(body) !== body) {
      return {
        ok: false,
        reason:
          "it contains comments, which the form has nowhere to keep in place",
      };
    }

    GRAPHIC.lastIndex = 0;
    const graphics = [...body.matchAll(GRAPHIC)];
    if (graphics.length === 0) {
      return { ok: false, reason: "it has no \\includegraphics yet" };
    }
    if (graphics.length > 1) {
      // Subfigures. Editing "the image" would mean editing the first of
      // several, which is not what the form says it does.
      return {
        ok: false,
        reason: `it holds ${graphics.length} images, and the form edits one`,
      };
    }

    const graphic = graphics[0];
    const { widthPercent, widthUnit, otherOptions } = readOptions(graphic?.[1]);
    return {
      ok: true,
      figure: {
        environment,
        from,
        to,
        original: body,
        path: (graphic?.[2] ?? "").trim(),
        caption: CAPTION.exec(body)?.[1]?.trim() ?? "",
        label: LABEL.exec(body)?.[1]?.trim() ?? "",
        placement: begin[2]?.trim() ?? null,
        widthPercent,
        widthUnit,
        otherOptions,
        centered: CENTERING.test(body),
        indent: indentAt(source, from),
        lead: "",
      },
    };
  }
  return null;
}

/**
 * A figure to insert at `offset`, centred and a caption wide.
 *
 * Starts on its own line: `\begin{figure}` in the middle of a sentence is
 * legal and almost never meant.
 */
export function newFigure(source: string, offset: number): Figure {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const before = source.slice(lineStart, offset);
  const indent = /^[ \t]*/.exec(before)?.[0] ?? "";
  return {
    environment: "figure",
    from: offset,
    to: offset,
    original: "",
    path: "",
    caption: "",
    label: "",
    placement: "htbp",
    widthPercent: 80,
    widthUnit: DEFAULT_UNIT,
    otherOptions: [],
    centered: true,
    indent,
    lead: before.trim().length > 0 ? `\n${indent}` : "",
  };
}

/** The environment written from scratch, for a figure being inserted. */
function formatFigure(figure: Figure): string {
  const inner = `${figure.indent}  `;
  const options = writeOptions(figure);
  const lines = [
    `\\begin{${figure.environment}}${figure.placement ? `[${figure.placement}]` : ""}`,
    ...(figure.centered ? [`${inner}\\centering`] : []),
    `${inner}\\includegraphics${options ? `[${options}]` : ""}{${figure.path.trim()}}`,
    // Caption before label, always: a `\label` that precedes its `\caption`
    // numbers whatever was last numbered — usually the section — and the
    // reference then points somewhere else entirely.
    ...(figure.caption.trim()
      ? [`${inner}\\caption{${figure.caption.trim()}}`]
      : []),
    ...(figure.label.trim() ? [`${inner}\\label{${figure.label.trim()}}`] : []),
    `${figure.indent}\\end{${figure.environment}}`,
  ];
  return figure.lead + lines.join("\n");
}

/**
 * The figure written back.
 *
 * Fresh when it is being inserted; otherwise the source it came from with the
 * recognised parts replaced, so anything this reader does not model survives
 * the edit.
 */
export function writeFigure(figure: Figure): string {
  if (!figure.original) return formatFigure(figure);

  const inner = `${figure.indent}  `;
  let source = figure.original;

  source = source.replace(
    /\\begin\s*\{figure\*?\}[ \t]*(?:\[[^\]]*\])?/,
    `\\begin{${figure.environment}}${figure.placement ? `[${figure.placement}]` : ""}`,
  );

  const options = writeOptions(figure);
  source = source.replace(
    GRAPHIC,
    `\\includegraphics${options ? `[${options}]` : ""}{${figure.path.trim()}}`,
  );

  if (figure.centered && !CENTERING.test(source)) {
    source = source.replace(
      /(\\begin\s*\{figure\*?\}[ \t]*(?:\[[^\]]*\])?)/,
      `$1\n${inner}\\centering`,
    );
  } else if (!figure.centered) {
    source = source.replace(/[ \t]*\\centering[ \t]*\r?\n?/, "");
  }

  const caption = figure.caption.trim();
  if (CAPTION.test(source)) {
    source = caption
      ? source.replace(CAPTION, `\\caption{${caption}}`)
      : source.replace(
          /[ \t]*\\caption(?:\[[^\]]*\])?\s*\{[^}]*\}[ \t]*\r?\n?/,
          "",
        );
  } else if (caption) {
    source = source.replace(
      /(\\includegraphics\s*(?:\[[^\]]*\])?\s*\{[^}]*\})/,
      `$1\n${inner}\\caption{${caption}}`,
    );
  }

  const label = figure.label.trim();
  if (LABEL.test(source)) {
    source = label
      ? source.replace(LABEL, `\\label{${label}}`)
      : source.replace(/[ \t]*\\label\s*\{[^}]*\}[ \t]*\r?\n?/, "");
  } else if (label) {
    // After the caption when there is one, because that is the only place it
    // numbers the figure.
    const after = CAPTION.test(source)
      ? /(\\caption(?:\[[^\]]*\])?\s*\{[^}]*\})/
      : /(\\includegraphics\s*(?:\[[^\]]*\])?\s*\{[^}]*\})/;
    source = source.replace(after, `$1\n${inner}\\label{${label}}`);
  }

  return source;
}

/** Project files that `\includegraphics` can take. */
export function isGraphic(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|pdf|eps|svg)$/i.test(path);
}
