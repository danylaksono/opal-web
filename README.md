# Opal Web

A client-side LaTeX workspace: a browser product that compiles locally, stores
projects on the user's device, and sends no document content to an Opal server.
Sibling product to the [Opal desktop editor](https://github.com/danylaksono/opal-editor),
not a port of it.

**Status: Phase 0 — feasibility gates.** This repository contains measurement
instrumentation, the architectural ports, and the decision records. There is no
editor, no storage layer and no compiler yet, deliberately: PLAN.md gates product
work on two questions whose answers change the architecture.

1. **Renderer — settled.** MuPDF.js, verified booting in a plain browser module
   worker on a static host, with per-line text geometry good enough for review
   anchoring (ADR-004). This makes the app AGPL-3.0-or-later (ADR-002).
2. **LaTeX engine — open.** Every maintained browser TeX distribution wraps the
   same BusyTeX TeX Live build, so the question is package delivery, not engine
   fidelity. `@siglum/engine` compiles and emits SyncTeX in the browser, but
   only 2 of 13 corpus projects build without on-demand CTAN fetching, and that
   path is still untested (ADR-003).

## What is here

| Path | Purpose |
|---|---|
| [PLAN.md](PLAN.md) | The full architecture investigation. Written 2026-07-23 against desktop v1.4.8; see *Plan drift* below. |
| [docs/adr/](docs/adr/) | Architecture decision records. 001 accepted, 002–004 open. |
| [docs/licence-inventory.md](docs/licence-inventory.md) | Every third-party artifact with its exact version and terms. |
| [docs/evidence/](docs/evidence/) | Third-party manifests kept verbatim so the ADR analyses are reproducible without re-fetching hundreds of megabytes. |
| [src/core/](src/core/) | The ports: `LatexCompiler`, `PdfRenderer`, branded project ids and path validation. No browser API touches these. |
| [src/platform/browser/](src/platform/browser/) | Capability probes and the MuPDF renderer adapter behind those ports. |
| [src/workers/pdf/](src/workers/pdf/) | Versioned PDF worker protocol and the MuPDF worker. |
| [src/spikes/](src/spikes/) | Measurement surfaces. The renderer spike loads a PDF through the port; the compiler spike builds a project and opens the result through the renderer. |
| [tests/fixtures/compiler-corpus/](tests/fixtures/compiler-corpus/) | 13 projects pinned from the desktop examples, with a generated manifest and desktop Tectonic's reference output. The instrument both spikes are measured against. |

## Getting started

```sh
pnpm install
pnpm spike:corpus   # regenerate the corpus from a sibling tectonic-editor checkout
pnpm spike:coverage docs/evidence/wasmtex-0.1.1/manifest.json
./scripts/download-siglum-assets.sh   # 225 MB of engine assets, gitignored
pnpm spike:siglum xelatex             # corpus coverage against those bundles
pnpm spike:corpus-run xelatex         # compile all 13, needs a running preview
pnpm dev            # capability matrix and corpus overview
pnpm test
pnpm typecheck
pnpm test:e2e       # builds, serves, and drives the renderer spike in Chromium
```

The corpus ships with desktop Tectonic's own output for each project as
`main.reference.pdf`. Those are committed rather than ignored: they cannot be
regenerated without the desktop repo and a working native toolchain, which makes
them the comparison baseline rather than a build artifact.

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

## Author

Dany Laksono ([@danylaksono](https://github.com/danylaksono))

## Licence

**AGPL-3.0-or-later**, as the consequence of shipping MuPDF.js (ADR-002,
ADR-004). Because this is a static site, the JavaScript is conveyed directly to
every visitor, so every visitor is a recipient with a source offer — the app has
to publish corresponding source and make the offer discoverable in the UI.

`LICENSE` holds the canonical AGPL-3.0 text. The source offer that AGPL section
13 requires is not built yet: a deployed build must link to the corresponding
source for *that version*, which means the UI has to know its own commit or tag.
That is a prerequisite for any public deployment, not for development.
