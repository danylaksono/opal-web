import type { TextLine } from "@/core/pdf/types";

/**
 * Normalise MuPDF structured-text JSON into the renderer-neutral line model.
 *
 * Ported from the desktop `lib/mupdf/structured-text.ts`, with the output
 * changed to `TextLine[]` so nothing renderer-shaped crosses the port. Two
 * behaviours are carried over deliberately, because desktop found both the hard
 * way:
 *
 * - Newer MuPDF emits each line as a `text` string with its own `font` and
 *   baseline `y`; older releases nested spans of chars under the line. Reading
 *   only the newer shape silently yields an empty string per line, which empties
 *   text selection and word count with no error anywhere.
 * - A line's `y` is its *baseline*. Falling back to the bottom of the bounding
 *   box drops every line by its descender and misaligns selection and review
 *   highlights.
 *
 * Kept out of the worker module so it stays directly testable: importing the
 * worker boots the WASM runtime as a side effect.
 */

interface RawBBox {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

interface RawFont {
  name?: string;
  family?: string;
  size?: number;
  weight?: string;
  style?: string;
}

interface RawChar {
  c?: string;
  origin?: { x?: number; y?: number };
}

interface RawSpan {
  chars?: RawChar[];
  font?: RawFont;
  size?: number;
}

interface RawLine {
  bbox?: RawBBox;
  wmode?: number;
  x?: number;
  y?: number;
  text?: string;
  font?: RawFont;
  spans?: RawSpan[];
}

interface RawBlock {
  type?: string;
  lines?: RawLine[];
}

interface RawStructuredText {
  blocks?: RawBlock[];
}

function normalizeLine(line: RawLine): TextLine {
  const spans = line.spans ?? [];
  const firstSpan = spans[0];

  const text =
    typeof line.text === "string"
      ? line.text
      : spans
          .map((span) =>
            (span.chars ?? []).map((char) => char.c ?? "").join(""),
          )
          .join("");

  const fontSource = line.font ?? firstSpan?.font;

  const bbox = {
    x: line.bbox?.x ?? 0,
    y: line.bbox?.y ?? 0,
    width: line.bbox?.w ?? 0,
    height: line.bbox?.h ?? 0,
  };

  const spanOriginY = firstSpan?.chars?.[0]?.origin?.y;
  const baselineY =
    typeof line.y === "number"
      ? line.y
      : typeof spanOriginY === "number"
        ? spanOriginY
        : bbox.y + bbox.height;

  return {
    bbox,
    baselineY,
    text,
    wmode: line.wmode === 1 ? 1 : 0,
    font: {
      name: fontSource?.name ?? "",
      family: fontSource?.family ?? "",
      size: fontSource?.size ?? firstSpan?.size ?? 12,
      weight: fontSource?.weight ?? "normal",
      style: fontSource?.style ?? "normal",
    },
  };
}

/**
 * Flatten to lines in the order MuPDF emits them, which is reading order for
 * ordinary text. Non-text blocks (images, rules) carry no lines and drop out.
 */
export function normalizeStructuredText(raw: unknown): TextLine[] {
  const blocks = (raw as RawStructuredText | null)?.blocks ?? [];
  const lines: TextLine[] = [];
  for (const block of blocks) {
    if (block?.type !== "text") continue;
    for (const line of block.lines ?? []) {
      lines.push(normalizeLine(line));
    }
  }
  return lines;
}
