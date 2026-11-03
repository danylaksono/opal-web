import { describe, expect, it } from "vitest";
import {
  forwardSearchSyncTex,
  parseSyncTex,
  synctexBoxToRect,
} from "@/core/synctex/parse";

/**
 * ADR-012's evidence, replayed as a test.
 *
 * `main.synctex.txt` is not synthetic: it is the real, decompressed
 * `.synctex.gz` this engine produced compiling `main.tex`, captured once by
 * hand and committed (see the ADR for the exact session). `main.tex` puts one
 * marker word, findable nowhere else, on a known line — line 5. The ground
 * truth below is not computed by this parser either: it is the rect MuPDF's
 * own `searchPage` found for that word in the resulting PDF, read from the
 * same session. This test checks the parser against an independent source,
 * the only way "the offsets are usable" is a checked claim rather than a
 * hopeful one.
 */

const FIXTURES = import.meta.glob("../fixtures/synctex-probe/*.synctex.txt", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const RAW_SYNCTEX = Object.values(FIXTURES)[0];
if (RAW_SYNCTEX === undefined) {
  throw new Error("fixture main.synctex.txt not found");
}

/** `searchPage(0, "SYNCTEXPROBEMARKER", 4)` on the real compiled PDF. */
const GROUND_TRUTH = { x: 148.712, y: 150.645, width: 130.371, height: 9.963 };

describe("parseSyncTex", () => {
  it("reads the preamble's offsets and the one input file", () => {
    const doc = parseSyncTex(RAW_SYNCTEX);
    expect(doc.magnification).toBe(1000);
    // Both offsets are TeX's standard 1-inch margin, 4736287 sp = 72.27 pt.
    expect(doc.xOffset).toBe(4736287);
    expect(doc.yOffset).toBe(4736287);
    expect([...doc.inputs.values()]).toContainEqual(
      expect.stringContaining("main.tex"),
    );
  });

  it("collects at least one page of records", () => {
    const doc = parseSyncTex(RAW_SYNCTEX);
    expect(doc.pages.size).toBe(1);
    expect(doc.pages.get(1)?.length).toBeGreaterThan(5);
  });
});

describe("forwardSearchSyncTex", () => {
  it("finds nothing for a file the document never mentions", () => {
    const doc = parseSyncTex(RAW_SYNCTEX);
    expect(forwardSearchSyncTex(doc, "nonexistent.tex", 5)).toEqual([]);
  });

  it("finds nothing for a line the marker is not on", () => {
    const doc = parseSyncTex(RAW_SYNCTEX);
    // Line 1 is `\documentclass`, never itself the target of a text record.
    expect(forwardSearchSyncTex(doc, "main.tex", 1)).toEqual([]);
  });

  it("matches main.tex by suffix against the engine's own absolute path", () => {
    const doc = parseSyncTex(RAW_SYNCTEX);
    // The recorded path is /home/web_user/project_dir/./main.tex — this is
    // the case a naive `===` path comparison fails.
    expect(forwardSearchSyncTex(doc, "main.tex", 5).length).toBeGreaterThan(0);
  });

  it("locates the marker's line within the tolerance review re-anchoring needs", () => {
    const doc = parseSyncTex(RAW_SYNCTEX);
    const hits = forwardSearchSyncTex(doc, "main.tex", 5);
    expect(hits.length).toBeGreaterThan(0);

    const first = hits[0];
    if (!first) throw new Error("unreachable");
    expect(first.page).toBe(1);

    const rect = synctexBoxToRect(doc, first.box);

    // Coarse by design (PLAN.md: SyncTeX resolves a source line, not a
    // span) — the box is expected to be bigger than the word and to start a
    // little before it, so this checks containment and a generous distance
    // bound rather than pixel equality.
    expect(rect.x).toBeLessThanOrEqual(GROUND_TRUTH.x + 1);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(
      GROUND_TRUTH.x + GROUND_TRUTH.width,
    );
    expect(Math.abs(rect.y - GROUND_TRUTH.y)).toBeLessThan(5);
    expect(Math.abs(rect.height - GROUND_TRUTH.height)).toBeLessThan(5);
  });
});
