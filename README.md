# Opal Web

A client-side LaTeX workspace: a browser product that compiles locally, stores
projects on the user's device, and sends no document content to an Opal server.
Sibling product to the [Opal desktop editor](https://github.com/danylaksono/opal-editor),
not a port of it.

**Status: Phase 0 — feasibility gates.** This repository currently contains
measurement instrumentation, the architectural ports, and the decision records.
There is no editor, no storage layer and no compiler yet, deliberately: PLAN.md
gates product work on two questions whose answers change the architecture.

1. Can a browser LaTeX engine compile Opal's real template corpus with
   acceptable fidelity and performance? (ADR-003)
2. Can a permissively licensed PDF renderer meet the preview and review-anchoring
   requirements? (ADR-004, which gates the application licence in ADR-002)

## What is here

| Path | Purpose |
|---|---|
| [PLAN.md](PLAN.md) | The full architecture investigation. Written 2026-07-23 against desktop v1.4.8; see *Plan drift* below. |
| [docs/adr/](docs/adr/) | Architecture decision records. 001 accepted, 002–004 open. |
| [docs/licence-inventory.md](docs/licence-inventory.md) | Every third-party artifact with its exact version and terms. |
| [src/core/](src/core/) | The ports: `LatexCompiler`, `PdfRenderer`, branded project ids and path validation. No browser API touches these. |
| [src/platform/browser/](src/platform/browser/) | Capability probes behind those ports. |
| [tests/fixtures/compiler-corpus/](tests/fixtures/compiler-corpus/) | 13 projects pinned from the desktop examples, with a generated manifest. The instrument both spikes are measured against. |

## Getting started

```sh
pnpm install
pnpm spike:corpus   # regenerate the corpus from a sibling tectonic-editor checkout
pnpm dev            # capability matrix and corpus overview
pnpm test
pnpm typecheck
```

Set `OPAL_COI=1` to serve with cross-origin isolation headers. Whether threaded
WASM needs them is a Phase 0 measurement, so they are switchable rather than
baked in — flip `netlify.toml` at the same time or local and deployed behaviour
will disagree.

## Plan drift

PLAN.md audits desktop `main` at v1.4.8. Desktop has since moved to
`features-1.5`. The architecture in the plan holds, but two figures and one
sequencing assumption have changed:

- The audit's file counts are stale: 227 → 293 TypeScript/TSX files, and 44 →
  65 files importing Tauri APIs directly.
- The review subsystem grew substantially — drawing, gutter, re-anchoring,
  reporting, tags, search. PLAN.md 9 places review in Phase 4, but its
  dependence on structured-text geometry makes the renderer's text fidelity a
  Phase 0 deciding measurement rather than a later concern. ADR-004 records
  this.
- The desktop skills/Python architecture landed after the plan was written. It
  stays out of scope, as PLAN.md 3.4 already specified.

## Licence

Undecided. ADR-002 is open and deliberately blocked on the renderer spike, so
no `LICENSE` file is present yet and no code has been copied from a copyleft
project.
