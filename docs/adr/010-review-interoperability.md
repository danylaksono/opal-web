# ADR-010: Desktop/web project and review interoperability

- **Status:** Proposed — data model and re-anchoring logic ported; renderer and SyncTeX binding, and all UI, still open
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

**Not wired up in this change:** `ReanchorContext.searchPage` and
`forwardSearch` have no implementation bound to them yet.
`src/workers/pdf/protocol.ts` has a `pageText` message but no `searchPage`
one, and `forwardSearch` needs SyncTeX, which PLAN.md's own "next, in order"
marks unproven pending a dedicated item (a harness compile on 2026-09-18
reported SyncTeX emitted; whether the offsets survive `xdvipdfmx` is
unmeasured). Neither `WorkspaceScreen` nor `PreviewPane` was touched. The next
increment is: add a `searchPage` worker message, verify SyncTeX forward
search, and only then build the comments panel, gutter marks, drawing
overlay, and PDF-side selection UI against real data.

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

- `pnpm test`: 392 passed, including 35 new (`review-model.test.ts`,
  `review-tags.test.ts`, `review-reanchor.test.ts`).
- `pnpm typecheck` and `pnpm lint`: clean.
- Desktop source read at `opal-editor@8f95519e63aeccd2341c23060fdad1f0413cd50b`.
