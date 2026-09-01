# Architecture decision records

One file per decision, numbered, never edited in place once accepted — a
superseding ADR is written instead and the old one is marked `Superseded by`.

PLAN.md section 16 lists the ten records that must exist before implementation
crosses each boundary. Phase 0 opens the first four, because those are the ones
whose answers change the architecture rather than the code.

| ADR | Title | Status |
|---|---|---|
| [001](001-client-only-boundary.md) | Client-only product boundary and permitted network features | Accepted |
| [002](002-licence.md) | Application licence and third-party licence policy | Accepted — AGPL-3.0-or-later |
| [003](003-latex-engine.md) | LaTeX WASM engine and package distribution | Open — Siglum compiles in-browser, 2/13 without CTAN |
| [004](004-pdf-renderer.md) | PDF renderer | Accepted — MuPDF.js |
| 005 | OPFS/IndexedDB project schema and migration | Not opened (Phase 1) |
| 006 | Local directory mirror and conflict semantics | Not opened (Phase 4) |
| 007 | Worker protocols, resource limits, cancellation | Not opened (Phase 2) |
| 008 | PWA cache and update strategy | Not opened (Phase 4) |
| 009 | API key and connected-service policy | Not opened (Phase 5) |
| 010 | Desktop/web project and review interoperability | Not opened (Phase 4) |
