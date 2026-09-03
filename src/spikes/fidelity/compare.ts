/**
 * Comparing a compiled PDF against desktop Tectonic's, beyond page count
 * (ADR-003 exit criteria, PLAN.md 7.4).
 *
 * Page count says only that the document did not fall apart. What matters is
 * whether the same words are in the same places, and these are the metrics that
 * answer it without claiming more than they measure:
 *
 * - **Words.** Line breaking is an engine's own business and differs
 *   legitimately, so text is compared as a word sequence per page, never line
 *   by line. Nothing here compares bytes: PDFs carry timestamps and object
 *   ordering that differ between identical runs.
 * - **Ink.** The fraction of non-white pixels on a page, which survives
 *   sub-pixel shifts and still catches content that went missing or arrived
 *   twice.
 * - **Pixels.** A differing-pixel ratio, which is the strictest of the three
 *   and the easiest to misread: text rasterisation is so sensitive to sub-pixel
 *   positioning that a tenth-of-a-point baseline shift lights up every glyph.
 *   A low ratio means the page is laid out the same. A high one means *look*,
 *   not *fail*.
 *
 * Both sides go through the same renderer, so a difference here is a real
 * difference rather than two parsers disagreeing.
 */

import type { PageText } from "@/core/pdf/types";

/** The parts of `ImageData` these functions use, so tests need no DOM. */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  readonly data: Uint8ClampedArray;
}

/**
 * Characters that carry no textual meaning but do vary between engines: soft
 * hyphens inserted at a break, zero-width joiners, and the BOM.
 */
const INVISIBLE = /[\u00AD\u200B-\u200D\uFEFF]/g;

/**
 * Words on a page, in reading order, normalised for comparison.
 *
 * NFKC folds the ligatures a TeX engine emits as single glyphs — `ﬁ` becomes
 * `fi` — so a document typeset identically does not read as different text
 * merely because one engine used the ligature and the other did not.
 */
export function pageWords(page: PageText): string[] {
  return page.lines
    .map((line) => line.text.normalize("NFKC").replace(INVISIBLE, ""))
    .join(" ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

export interface WordComparison {
  /** Dice coefficient over the longest common subsequence, 0..1. */
  similarity: number;
  common: number;
  referenceWords: number;
  candidateWords: number;
  /** The first place the two sequences part company, for a human to read. */
  firstDivergence: {
    index: number;
    reference?: string;
    candidate?: string;
  } | null;
}

/**
 * Length of the longest common subsequence, computed over two rolling rows.
 *
 * A subsequence rather than a set: word *order* is most of what layout means,
 * and a set comparison would call a scrambled page identical.
 */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      current[j + 1] =
        a[i] === b[j]
          ? (previous[j] ?? 0) + 1
          : Math.max(current[j] ?? 0, previous[j + 1] ?? 0);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[b.length] ?? 0;
}

/** Compare two pages as word sequences. */
export function compareWords(
  reference: readonly string[],
  candidate: readonly string[],
): WordComparison {
  const common = lcsLength(reference, candidate);
  const total = reference.length + candidate.length;
  let firstDivergence: WordComparison["firstDivergence"] = null;
  const limit = Math.max(reference.length, candidate.length);
  for (let i = 0; i < limit; i++) {
    if (reference[i] !== candidate[i]) {
      firstDivergence = {
        index: i,
        ...(reference[i] === undefined ? {} : { reference: reference[i] }),
        ...(candidate[i] === undefined ? {} : { candidate: candidate[i] }),
      };
      break;
    }
  }
  return {
    // Two empty pages are identical, not undefined.
    similarity: total === 0 ? 1 : (2 * common) / total,
    common,
    referenceWords: reference.length,
    candidateWords: candidate.length,
    firstDivergence,
  };
}

/**
 * Fraction of pixels with any ink on them.
 *
 * "Ink" is deliberately generous — anything not near-white — because the
 * measure exists to catch content that vanished or doubled, not to judge
 * greyscale rendering.
 */
const WHITE_THRESHOLD = 250;

export function inkCoverage(bitmap: Bitmap): number {
  const { data } = bitmap;
  const pixels = data.length / 4;
  if (pixels === 0) return 0;
  let inked = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] ?? 0;
    if (alpha === 0) continue;
    if (
      (data[i] ?? 255) < WHITE_THRESHOLD ||
      (data[i + 1] ?? 255) < WHITE_THRESHOLD ||
      (data[i + 2] ?? 255) < WHITE_THRESHOLD
    ) {
      inked++;
    }
  }
  return inked / pixels;
}

export interface BitmapComparison {
  /** Fraction of pixels differing by more than `tolerance` on any channel. */
  differingRatio: number;
  referenceInk: number;
  candidateInk: number;
  /** False when the two rasters are not the same size, which voids the ratio. */
  comparable: boolean;
}

/**
 * Per-channel difference allowed before a pixel counts as changed.
 *
 * Not zero: the same renderer rasterising two structurally identical pages
 * still differs by a unit or two on antialiased glyph edges, and counting that
 * would drown the signal.
 */
const DEFAULT_TOLERANCE = 8;

export function compareBitmaps(
  reference: Bitmap,
  candidate: Bitmap,
  tolerance: number = DEFAULT_TOLERANCE,
): BitmapComparison {
  const referenceInk = inkCoverage(reference);
  const candidateInk = inkCoverage(candidate);
  if (
    reference.width !== candidate.width ||
    reference.height !== candidate.height
  ) {
    return {
      differingRatio: 1,
      referenceInk,
      candidateInk,
      comparable: false,
    };
  }

  const a = reference.data;
  const b = candidate.data;
  const pixels = a.length / 4;
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > tolerance ||
      Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) > tolerance ||
      Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)) > tolerance
    ) {
      differing++;
    }
  }

  return {
    differingRatio: pixels === 0 ? 0 : differing / pixels,
    referenceInk,
    candidateInk,
    comparable: true,
  };
}

export interface PageComparison {
  pageIndex: number;
  words: WordComparison;
  raster: BitmapComparison;
  /** Page size in points, reference then candidate. */
  size: { reference: [number, number]; candidate: [number, number] };
  sizeMatches: boolean;
}

export interface DocumentComparison {
  referencePages: number;
  candidatePages: number;
  pages: PageComparison[];
  /**
   * Word similarity averaged over pages.
   *
   * The companion to `worstWordSimilarity`: the worst page answers "how bad
   * does this get", the mean answers "how close is this overall", and a change
   * that helps most pages a little moves only the second.
   */
  meanWordSimilarity: number;
  /** Lowest per-page word similarity, which is the number worth quoting. */
  worstWordSimilarity: number;
  worstDifferingRatio: number;
  /** Largest absolute difference in ink coverage on any page. */
  worstInkDelta: number;
  /**
   * Pages whose text matches the reference word for word.
   *
   * The worst page alone hides progress: a change that fixes eleven pages of a
   * twelve-page document leaves the worst figure exactly where it was.
   */
  exactPages: number;
}

/** Roll per-page comparisons up into the figures a report should quote. */
export function summarise(
  referencePages: number,
  candidatePages: number,
  pages: readonly PageComparison[],
): DocumentComparison {
  // A document with no comparable pages must not report a perfect score.
  const worstWordSimilarity =
    pages.length === 0
      ? 0
      : Math.min(...pages.map((page) => page.words.similarity));
  const worstDifferingRatio =
    pages.length === 0
      ? 1
      : Math.max(...pages.map((page) => page.raster.differingRatio));
  const worstInkDelta =
    pages.length === 0
      ? 1
      : Math.max(
          ...pages.map((page) =>
            Math.abs(page.raster.referenceInk - page.raster.candidateInk),
          ),
        );
  return {
    referencePages,
    candidatePages,
    pages: [...pages],
    exactPages: pages.filter((page) => page.words.similarity === 1).length,
    meanWordSimilarity:
      pages.length === 0
        ? 0
        : pages.reduce((total, page) => total + page.words.similarity, 0) /
          pages.length,
    worstWordSimilarity,
    worstDifferingRatio,
    worstInkDelta,
  };
}
