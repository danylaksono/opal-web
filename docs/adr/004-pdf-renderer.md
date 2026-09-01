# ADR-004: PDF renderer

- **Status:** Open — spike in progress
- **Date:** 2026-09-01
- **Deciders:** danylaksono

## Context

Desktop renders with MuPDF.js in a worker. The viewer builds canvas, text, link,
selection, SyncTeX and review-overlay layers on top of MuPDF's structured text.

Since PLAN.md was written, the review subsystem has grown substantially on the
desktop `features-1.5` branch — drawing, gutter, re-anchoring, reporting, tags,
search — and re-anchoring in particular depends on structured-text geometry
being good enough to find the same words again after a recompile. That makes
text-geometry fidelity, not raster quality, the deciding measurement here.

## Options considered

| Option | Licence | Porting impact |
|---|---|---|
| MuPDF.js | AGPL-3.0-or-later or commercial | Lowest; desktop worker and viewer concepts transfer nearly directly |
| PDF.js | Apache-2.0 | Replace worker internals; normalise text and link output into the neutral model |

## Decision

**Open. Both are being implemented behind `PdfRenderer`** so the choice is made
on data, and so ADR-002 is not forced before that data exists.

The port in `src/core/pdf/types.ts` is the constraint that makes this possible:
no MuPDF or PDF.js object may enter Zustand state, component props, or any
module under `src/core` or `src/features`. Coordinates are PDF points, origin
top-left, y increasing downwards, matching desktop's structured-text convention
so ported review anchoring keeps its geometry.

`TextLine.baselineY` is the glyph baseline, not the bottom of the bounding box.
Desktop's `structured-text.ts` documents what happens otherwise: falling back to
the box bottom drops every line by its descender and misaligns both selection
and review highlights.

## Exit criteria

Per PLAN.md 8.2, measured on the corpus in Chrome, Firefox and Safari:

1. Correct rendering of all 13 corpus outputs.
2. Text extraction order and per-line geometry good enough for review anchoring,
   compared line-for-line against the desktop MuPDF output on the same PDFs.
3. Internal and external links resolve safely.
4. Incremental page rendering and working cancellation.
5. Stable scroll and zoom across recompiles.
6. Bounded memory on `poster-academic` (a0paper) and `thesis-standard` at high
   device pixel ratios.
7. Worker crash recovery.
8. No execution of PDF-embedded JavaScript.
