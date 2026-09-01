import { describe, expect, it } from "vitest";
import { normalizeStructuredText } from "@/platform/browser/pdf/structured-text";

/**
 * Both shapes below are real MuPDF structured-text output. The older nested
 * form is kept working because reading only the newer one fails silently —
 * every line normalises to an empty string, which empties text selection and
 * word count without raising anything.
 */

const modernLine = {
  blocks: [
    {
      type: "text",
      lines: [
        {
          wmode: 0,
          bbox: { x: 285, y: 118, w: 40, h: 18 },
          font: { name: "Times", family: "serif", size: 20, weight: "bold" },
          x: 285,
          y: 132,
          text: "Title",
        },
      ],
    },
  ],
};

const legacySpans = {
  blocks: [
    {
      type: "text",
      lines: [
        {
          wmode: 0,
          bbox: { x: 10, y: 20, w: 50, h: 12 },
          spans: [
            {
              font: { name: "Helvetica", family: "sans", size: 11 },
              chars: [
                { c: "H", origin: { x: 10, y: 29 } },
                { c: "i", origin: { x: 16, y: 29 } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("normalizeStructuredText", () => {
  it("reads the modern line shape", () => {
    const [line] = normalizeStructuredText(modernLine);
    expect(line?.text).toBe("Title");
    expect(line?.font.family).toBe("serif");
    expect(line?.font.size).toBe(20);
  });

  it("reconstructs text from the legacy nested span shape", () => {
    const [line] = normalizeStructuredText(legacySpans);
    expect(line?.text).toBe("Hi");
    expect(line?.font.family).toBe("sans");
  });

  it("uses the baseline, not the bottom of the bounding box", () => {
    const [line] = normalizeStructuredText(modernLine);
    // bbox bottom is 118 + 18 = 136. Using it would drop the line by its
    // descender and misalign selection and review highlights.
    expect(line?.baselineY).toBe(132);
    expect(line?.baselineY).not.toBe(136);
  });

  it("falls back to the first char origin when the line has no y", () => {
    const [line] = normalizeStructuredText(legacySpans);
    expect(line?.baselineY).toBe(29);
  });

  it("falls back to the bbox bottom only when nothing better exists", () => {
    const [line] = normalizeStructuredText({
      blocks: [
        {
          type: "text",
          lines: [{ bbox: { x: 0, y: 100, w: 10, h: 12 }, text: "x" }],
        },
      ],
    });
    expect(line?.baselineY).toBe(112);
  });

  it("converts bbox width and height into the neutral rect shape", () => {
    const [line] = normalizeStructuredText(modernLine);
    expect(line?.bbox).toEqual({ x: 285, y: 118, width: 40, height: 18 });
  });

  it("skips non-text blocks and flattens the rest in order", () => {
    const lines = normalizeStructuredText({
      blocks: [
        { type: "image" },
        {
          type: "text",
          lines: [
            { text: "one", y: 1 },
            { text: "two", y: 2 },
          ],
        },
        { type: "text", lines: [{ text: "three", y: 3 }] },
      ],
    });
    expect(lines.map((line) => line.text)).toEqual(["one", "two", "three"]);
  });

  it("tolerates empty and malformed input", () => {
    expect(normalizeStructuredText(null)).toEqual([]);
    expect(normalizeStructuredText({})).toEqual([]);
    expect(normalizeStructuredText({ blocks: [] })).toEqual([]);
    expect(normalizeStructuredText({ blocks: [{ type: "text" }] })).toEqual([]);
  });

  it("defaults a missing writing mode to horizontal", () => {
    const [line] = normalizeStructuredText({
      blocks: [{ type: "text", lines: [{ text: "x", y: 1 }] }],
    });
    expect(line?.wmode).toBe(0);
  });
});
