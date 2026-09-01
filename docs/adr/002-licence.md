# ADR-002: Application licence and third-party licence policy

- **Status:** Open
- **Date:** 2026-09-01
- **Deciders:** danylaksono

## Context

The desktop repository is MIT (with an assistant-ui copyright line carried from
its origins). Opal Web is a sibling product and may licence differently, but the
choice is not free: it decides which PDF renderer and which engine artifacts can
be used at all.

The forcing constraint is MuPDF.js, which is AGPL-3.0-or-later or commercial.
For a static web app, AGPL's network clause means every visitor is a recipient
with a source offer, since the JavaScript is conveyed to them directly.

## Options considered

| Option | Consequence | Status |
|---|---|---|
| MIT, matching desktop | Rules out MuPDF.js; renderer must be PDF.js (Apache-2.0). Fresh renderer adapter and text-geometry normalisation needed. | Open |
| AGPL-3.0 | Keeps MuPDF.js and the desktop viewer concepts, materially cheaper for the review-overlay port. Whole app becomes AGPL. | Open |
| Commercial MuPDF licence | Keeps MuPDF under any app licence, at a cost. | Not evaluated |

## Decision

**Deferred pending ADR-004 spike data.** Both renderers are being implemented
behind the `PdfRenderer` port so the licence choice can be made against measured
porting cost rather than a guess.

This deferral is only affordable because the port exists. If renderer-specific
types start leaking into UI or state, this ADR must be forced immediately.

## Consequences

- No `LICENSE` file is added to this repository until this ADR is accepted.
- No code is copied from an AGPL project in the meantime, including engine glue.
- Every third-party artifact added during Phase 0 is recorded in
  `docs/licence-inventory.md` with its exact version and terms.
