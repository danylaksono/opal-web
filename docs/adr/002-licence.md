# ADR-002: Application licence and third-party licence policy

- **Status:** Accepted
- **Date:** 2026-09-01
- **Deciders:** danylaksono

## Context

The desktop repository is MIT (carrying an assistant-ui copyright line from its
origins). Opal Web is a sibling product and could licence differently, but the
choice is not free: it decides which PDF renderer can be used at all.

ADR-004 selects MuPDF.js, which is offered as AGPL-3.0-or-later or under a
commercial licence. No commercial licence has been obtained.

## Options considered

| Option | Consequence | Outcome |
| --- | --- | --- |
| MIT, matching desktop | Rules out MuPDF.js; renderer would have to be PDF.js, and every review anchor re-validated against different text geometry | Rejected |
| AGPL-3.0-or-later | Keeps MuPDF.js and the desktop viewer concepts. The whole web app becomes AGPL | **Accepted** |
| Commercial MuPDF licence | Keeps MuPDF under any app licence, at a cost | Not pursued |

## Decision

**AGPL-3.0-or-later**, as the consequence of keeping MuPDF.js.

## Consequences

- Every visitor receives the application's JavaScript directly, so every visitor
  is a recipient with a source offer. For a static site this is a stronger
  obligation than the same dependency creates in a desktop binary: the app must
  publish corresponding source and make the offer discoverable in the UI.
- Any third-party code combined into the app must be AGPL-compatible. Permissive
  licences (MIT, Apache-2.0, BSD) remain fine; other copyleft licences need
  checking case by case.
- Desktop ships the same MuPDF dependency under an MIT `LICENSE`. That tension
  predates this repository and is out of scope here, but the two products should
  be reconciled deliberately rather than left to diverge by accident.
- The `PdfRenderer` port is retained even though the renderer is now settled, so
  this decision stays reversible at the cost of one adapter rather than a viewer
  rewrite.

## Outstanding

`LICENSE` is not yet committed. It must be the canonical AGPL-3.0 text from
gnu.org, copied verbatim rather than reproduced from memory, together with the
source-offer notice in the application UI.
