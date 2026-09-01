# ADR-004: PDF renderer

- **Status:** Accepted
- **Date:** 2026-09-01
- **Deciders:** danylaksono

## Context

Desktop renders with MuPDF.js in a worker. The viewer builds canvas, text, link,
selection, SyncTeX and review-overlay layers on top of MuPDF's structured text.

Since PLAN.md was written, the review subsystem has grown substantially on the
desktop `features-1.5` branch — drawing, gutter, re-anchoring, reporting, tags,
search. Re-anchoring in particular depends on structured-text geometry being
good enough to find the same words again after a recompile, which makes text
fidelity, not raster quality, the deciding property.

## Options considered

| Option | Licence | Porting impact |
| --- | --- | --- |
| MuPDF.js | AGPL-3.0-or-later or commercial | Lowest; desktop worker and viewer concepts transfer nearly directly, and the review subsystem keeps the geometry it was built against |
| PDF.js | Apache-2.0 | Replace worker internals; normalise text and link output, then re-validate every review anchor against different geometry |

## Decision

**MuPDF.js.** Chosen for functional completeness and because the review
subsystem is already built against its structured-text model, so the port keeps
its geometry instead of re-deriving it. The licence consequence is accepted and
recorded in ADR-002.

PDF.js was not benchmarked. The comparison would only have mattered if licence
were a constraint, and it is not.

The port in `src/core/pdf/types.ts` is kept regardless. It costs little, it is
what the worker protocol is written against, and it is the difference between
revisiting this decision and rewriting the viewer.

## Evidence

Measured against `tests/fixtures/compiler-corpus`, Chromium, production build:

- MuPDF 1.28.0 boots in a plain module worker on a static host — not just in a
  Tauri webview. Desktop resolves its WASM through a dev-only `/@fs/` URL, which
  has no equivalent on a static deploy; the binary is imported as a Vite asset
  instead, so one content-hashed URL works in dev and production.
- `paper-standard`: opened in 94.5 ms, page 1 (612 × 792 pt) rasterised in
  31.7 ms, 16 text lines extracted.
- Per-line baselines are distinct from bounding-box bottoms (baseline 132.0
  against a box bottom of 136.0), so review anchoring keeps the precision it has
  on desktop.
- `poster-academic` (a0paper) renders without exhausting memory.
- Covered by `tests/e2e/renderer-spike.spec.ts` and
  `tests/unit/structured-text.test.ts`.

## Consequences

- The WASM binary is 10.4 MB raw, 4.8 MB gzipped, and dominates first load.
  Brotli is worth serving — MuPDF ships a `.br` — and the offline-preparation
  UX in Phase 4 has to account for a download this size.
- Two behaviours had to be carried over from desktop and are now pinned by unit
  tests: reading both the modern and legacy structured-text shapes, and using
  the glyph baseline rather than the box bottom.
- MuPDF rasterises synchronously in the worker, so an in-flight render can be
  abandoned but not interrupted. Genuinely stuck work needs `restart()`, which
  is why the port exposes it.
- Explicit `destroy()` and `shrinkStore()` are required. The JS GC sees only a
  small wrapper while the WASM heap holds the parsed document, so nothing
  creates pressure to collect it.

## Still open

Exit criteria from PLAN.md 8.2 not yet covered: Firefox and Safari, link
resolution (the corpus reference PDFs carry no links to exercise), stable scroll
and zoom across recompiles, worker crash recovery under a real crash, and
confirming no PDF-embedded JavaScript executes.
