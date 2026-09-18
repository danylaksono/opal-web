# ADR-010: Desktop/web project and review interoperability

- **Status:** Proposed — data model, re-anchoring logic, the renderer's `searchPage`, and SyncTeX forward search (ADR-012) are in and tested; all UI still open
- **Date:** 2026-09-18
- **Deciders:** danylaksono

## Context

PLAN.md's "Next, in order" names review annotations as the largest remaining
port and the reason ADR-004 chose MuPDF.js: the desktop review subsystem is
built against MuPDF's structured-text geometry, and keeping that geometry is
what lets an annotation survive a recompile. The number this ADR opens to
close: whether a project's `review/` folder means the same thing on both
products, so a project moves between them without losing or corrupting a
reviewer's comments.

The desktop source (`opal-editor`, commit `8f95519e63aeccd2341c23060fdad1f0413cd50b`)
was cloned into a scratch directory and read directly for this decision —
`apps/desktop/src/stores/review-store.ts`, `review-reanchor.ts`, and
`review-tags.ts` — rather than reconstructed from PLAN.md's summary. That
matters here specifically: this ADR's interoperability claim is only as good
as the schema it was checked against, and inventing one from a two-line
PLAN.md description would have produced a format that merely resembled
desktop's, not one that round-trips its files.

## Options considered

| Option | Consequence | Why not chosen |
| --- | --- | --- |
| Design a review schema for the web product | Free to shape around this product's needs | Breaks the interoperability PLAN.md and ADR-004 were written to keep; a project could no longer move between products without a converter |
| Port desktop's file shape verbatim | A `review/` folder means the same thing everywhere; desktop's re-anchoring algorithm and its four states transfer with their tests | Carries one desktop bug forward (below) and a v1 migration path that does not apply here |

## Decision

**Port desktop's file shape verbatim**, landed in this change as:

- `src/core/review/model.ts` — `ReviewComment`, `ReviewAnchor`, `ReviewReply`,
  `ReviewDrawing`, the `ReviewFile` container, validation, and
  `parseReviewFile` / `serializeReviewFile`. One reviewer, one file:
  `review/<slug>.json`, so two reviewers on the same project never touch the
  same file and each only rewrites the authors they changed.
- `src/core/review/tags.ts` — tag normalisation, unchanged from desktop.
- `src/core/review/reanchor.ts` — the four-state check (`ok` / `shifted` /
  `drifted` / `unverified`) that reports whether an annotation's anchor still
  holds against a fresh compile. It never moves an annotation; see the
  module's own comment for why a confidently wrong new position is worse than
  a stale one.

**Not ported:** the v1 file at `.tectonic-editor/review-comments.json` and its
migration. Opal Web has never written that shape, so there is nothing to
migrate from — porting the migration would be dead code for a state that
cannot exist here.

**Also landed, in a second increment the same day:** `searchPage` on the PDF
worker protocol (`src/workers/pdf/protocol.ts`), backed by MuPDF's own
`page.search()` in `mupdf.worker.ts`, exposed on `PdfDocumentHandle`
(`src/core/pdf/types.ts`) and `MupdfRenderer`
(`src/platform/browser/pdf/mupdf-renderer.ts`). `quadToRect`
(`src/platform/browser/pdf/quad.ts`) converts MuPDF's four-corner `Quad` to
this repo's axis-aligned `Rect`, kept out of the worker module — same
reasoning as `structured-text.ts` — so it stays unit-testable without booting
WASM. `ReanchorContext.searchPage` now has a real implementation it can be
bound to; `tests/e2e/renderer-spike.spec.ts` proves it against the actual
worker and a committed reference PDF, not a mock: every page's own first line
of extracted text is searched for on that same page and must be found.

**Also landed, in a third increment the same week:** `ReanchorContext.forwardSearch`
now has a real implementation — `synctexForwardSearch` in
`src/platform/browser/compiler/synctex.ts`, backed by a from-scratch SyncTeX
parser (ADR-012). PLAN.md's "next, in order" item 4 asked whether the offsets
survive `xdvipdfmx`; ADR-012 answers that empirically (yes, within the
tolerance `reanchor.ts` needs) against a real compile and a fixture, not an
assumption.

**Still not wired up:** neither `WorkspaceScreen` nor `PreviewPane` was
touched — `reanchorAnnotations` is not called from application code yet. Both
of `ReanchorContext`'s routes (`searchPage`, `forwardSearch`) now have real
implementations to bind; the next increment is the UI itself — comments
panel, gutter marks, drawing overlay, PDF-side selection — built against
them.

## Consequences

- **The interoperability claim is tested, not asserted.**
  `tests/fixtures/review/dany-laksono.json` is a hand-built fixture — three
  annotation kinds, a reply, a tag, a colour, a SyncTeX source location —
  produced with Node's own `JSON.stringify(file, null, 2)`, independently of
  `serializeReviewFile`, with key order matching desktop's `addComment`
  object literal as read at `8f95519`. It is not a file desktop actually
  wrote — no desktop instance ran to produce it — but it is a faithful
  reconstruction of what one would write, checked against the source rather
  than guessed. `tests/unit/review-model.test.ts` parses it and asserts
  `serializeReviewFile` reproduces it byte for byte. It is excluded from
  Biome's formatter (`biome.json`) for the same reason: Biome collapses a
  single-element array onto one line where `JSON.stringify` never does, so
  reformatting the fixture would make it agree with this port by construction
  instead of by matching the shape desktop's code actually emits.
- **`reviewerFileName` collides**, and this port keeps the collision rather
  than fix it. "Dany Laksono" and "dany-laksono" slug to the same file, so the
  second author to save silently overwrites the first's annotations. Desktop
  has this bug; a different slugging scheme here would be a *worse* outcome,
  because it would mean two products opening the same project disagree on
  which file a reviewer's comments live in. Worth its own fix, upstream in
  desktop first.
- **`review/*.json` needs no new storage primitive.** It is a `ProjectPath`
  like any other file under `ProjectRepository`, written through the same
  `writeFile` conditional-write path everything else uses.
- `src/core/review/reanchor.ts` types `searchPage` against this repo's own
  `Rect` (`{ x, y, width, height }` in `src/core/pdf/types.ts`), not desktop's
  `{ x, y, w, h }` — `src/core/` knows nothing of a renderer, per PLAN.md's
  "what not to re-litigate."
- Drawing rendering (`review-drawing.ts`'s SVG path generation), the gutter,
  search, and report export were read but not ported: they are UI-adjacent
  and have no consumer yet in this product. Porting them ahead of the worker
  and SyncTeX work would be code with no way to be exercised.

## Evidence

- `pnpm test`: 401 passed, including 44 new across three increments
  (`review-model.test.ts`, `review-tags.test.ts`, `review-reanchor.test.ts`,
  `pdf-quad.test.ts`, `synctex-parse.test.ts`).
- `pnpm typecheck` and `pnpm lint`: clean.
- `pnpm build` + `pnpm exec playwright test`: 74 passed, including the
  `searchPage` test in `renderer-spike.spec.ts` and every previously-existing
  test (compile, offline, storage, accessibility) — no regression across any
  increment.
- SyncTeX forward search checked against a real compile and real
  `searchPage` ground truth: see ADR-012.
- Desktop source read at `opal-editor@8f95519e63aeccd2341c23060fdad1f0413cd50b`.
