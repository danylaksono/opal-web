import { describe, expect, it } from "vitest";
import type { PageText, TextLine } from "@/core/pdf/types";
import {
  type Bitmap,
  compareBitmaps,
  compareWords,
  inkCoverage,
  pageWords,
  summarise,
} from "@/spikes/fidelity/compare";

function line(text: string): TextLine {
  return {
    text,
    bbox: { x: 0, y: 0, width: 100, height: 12 },
    baselineY: 10,
    font: {
      name: "LMRoman10",
      family: "Latin Modern",
      size: 10,
      weight: "normal",
      style: "normal",
    },
    wmode: 0,
  };
}

function page(...texts: string[]): PageText {
  return { pageIndex: 0, lines: texts.map(line) };
}

/** A solid-colour bitmap, `inked` of whose pixels are black. */
function bitmap(width: number, height: number, inked: number): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let i = 0; i < inked; i++) {
    data[i * 4] = 0;
    data[i * 4 + 1] = 0;
    data[i * 4 + 2] = 0;
  }
  return { width, height, data };
}

describe("pageWords", () => {
  it("joins lines, because line breaking is the engine's own business", () => {
    expect(pageWords(page("the quick brown", "fox jumps"))).toEqual([
      "the",
      "quick",
      "brown",
      "fox",
      "jumps",
    ]);
  });

  it("folds ligatures, so one engine's fi is another's ﬁ", () => {
    expect(pageWords(page("ﬁnal"))).toEqual(["final"]);
  });

  it("drops soft hyphens inserted at a break", () => {
    expect(pageWords(page("hy­phen"))).toEqual(["hyphen"]);
  });

  it("ignores runs of whitespace rather than emitting empty words", () => {
    expect(pageWords(page("  a   b  "))).toEqual(["a", "b"]);
  });
});

describe("compareWords", () => {
  it("calls two empty pages identical, not undefined", () => {
    expect(compareWords([], []).similarity).toBe(1);
  });

  it("scores an exact match as 1 and finds no divergence", () => {
    const result = compareWords(["a", "b", "c"], ["a", "b", "c"]);
    expect(result.similarity).toBe(1);
    expect(result.firstDivergence).toBeNull();
  });

  it("scores disjoint pages as 0", () => {
    expect(compareWords(["a", "b"], ["c", "d"]).similarity).toBe(0);
  });

  it("counts order, so a scrambled page is not a match", () => {
    const ordered = compareWords(["a", "b", "c", "d"], ["a", "b", "c", "d"]);
    const scrambled = compareWords(["a", "b", "c", "d"], ["d", "c", "b", "a"]);
    expect(scrambled.similarity).toBeLessThan(ordered.similarity);
  });

  it("tolerates one inserted word without collapsing the score", () => {
    const result = compareWords(
      ["the", "quick", "brown", "fox"],
      ["the", "quick", "very", "brown", "fox"],
    );
    expect(result.common).toBe(4);
    expect(result.similarity).toBeCloseTo(8 / 9, 5);
  });

  it("reports where the two sequences part company", () => {
    const result = compareWords(["a", "b", "c"], ["a", "x", "c"]);
    expect(result.firstDivergence).toEqual({
      index: 1,
      reference: "b",
      candidate: "x",
    });
  });

  it("reports a truncated page as a divergence at the cut", () => {
    const result = compareWords(["a", "b"], ["a"]);
    expect(result.firstDivergence).toEqual({ index: 1, reference: "b" });
  });
});

describe("inkCoverage", () => {
  it("is 0 for a blank page", () => {
    expect(inkCoverage(bitmap(10, 10, 0))).toBe(0);
  });

  it("counts the inked fraction", () => {
    expect(inkCoverage(bitmap(10, 10, 25))).toBeCloseTo(0.25, 5);
  });
});

describe("compareBitmaps", () => {
  it("reports no difference between identical rasters", () => {
    const result = compareBitmaps(bitmap(10, 10, 20), bitmap(10, 10, 20));
    expect(result.differingRatio).toBe(0);
    expect(result.comparable).toBe(true);
  });

  it("refuses to compare rasters of different sizes", () => {
    const result = compareBitmaps(bitmap(10, 10, 0), bitmap(12, 10, 0));
    expect(result.comparable).toBe(false);
    expect(result.differingRatio).toBe(1);
  });

  it("still reports ink for each side when sizes differ", () => {
    const result = compareBitmaps(bitmap(10, 10, 50), bitmap(12, 10, 0));
    expect(result.referenceInk).toBeCloseTo(0.5, 5);
    expect(result.candidateInk).toBe(0);
  });

  it("counts the pixels that changed", () => {
    const result = compareBitmaps(bitmap(10, 10, 0), bitmap(10, 10, 10));
    expect(result.differingRatio).toBeCloseTo(0.1, 5);
  });

  it("ignores a difference inside the antialiasing tolerance", () => {
    const reference = bitmap(4, 4, 0);
    const candidate = bitmap(4, 4, 0);
    // Nudge every channel of the first pixel by less than the tolerance.
    candidate.data[0] = 250;
    candidate.data[1] = 250;
    candidate.data[2] = 250;
    expect(compareBitmaps(reference, candidate).differingRatio).toBe(0);
  });
});

describe("summarise", () => {
  const comparison = (similarity: number, differing: number, ink: number) => ({
    pageIndex: 0,
    words: {
      similarity,
      common: 0,
      referenceWords: 0,
      candidateWords: 0,
      firstDivergence: null,
    },
    raster: {
      differingRatio: differing,
      referenceInk: ink,
      candidateInk: 0,
      comparable: true,
    },
    size: {
      reference: [612, 792] as [number, number],
      candidate: [612, 792] as [number, number],
    },
    sizeMatches: true,
  });

  it("quotes the worst page as well as the average", () => {
    const result = summarise(2, 2, [
      comparison(1, 0, 0),
      comparison(0.4, 0.3, 0.2),
    ]);
    expect(result.worstWordSimilarity).toBe(0.4);
    expect(result.meanWordSimilarity).toBeCloseTo(0.7, 5);
    expect(result.worstDifferingRatio).toBe(0.3);
    expect(result.worstInkDelta).toBeCloseTo(0.2, 5);
  });

  it("counts pages that match word for word", () => {
    const result = summarise(3, 3, [
      comparison(1, 0, 0),
      comparison(1, 0, 0),
      comparison(0.9, 0, 0),
    ]);
    expect(result.exactPages).toBe(2);
  });

  it("does not report a perfect score when nothing was comparable", () => {
    const result = summarise(3, 0, []);
    expect(result.worstWordSimilarity).toBe(0);
    expect(result.meanWordSimilarity).toBe(0);
    expect(result.exactPages).toBe(0);
    expect(result.worstDifferingRatio).toBe(1);
  });
});
