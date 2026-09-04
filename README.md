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
   fidelity. `@siglum/engine` now compiles **11 of 13** corpus projects with a
   self-hosted, version-pinned CTAN proxy, 10 of those matching desktop
   Tectonic's page count and 30 of 60 pages reproducing its text word for word.
   Eleven engine defects were found doing it; ten are absorbed by the adapter
   (ADR-003).
3. **Package delivery — proposed.** Bundles are fetched whole, so a first
   compile transfers 41–135 MB. Tectonic's indexed-archive model, verified
   against its live bundle, would make that 17–21 MB: `presentation-beamer`
   reads 2.1 MB of TeX files and currently downloads 118.9 MB to get them.
   Fetching those as 142 range requests costs 575 ms on a 150 ms link — but only
   over HTTP/2 and only with the HTTP cache declined, because Chrome locks the
   cache entry per URL and every file is a range of one URL. The obvious way to
   write it is 38× slower (ADR-011).

## What is here

| Path | Purpose |
|---|---|
| [PLAN.md](PLAN.md) | The full architecture investigation. Written 2026-07-23 against desktop v1.4.8; see *Plan drift* below. |
| [docs/adr/](docs/adr/) | Architecture decision records. 001, 002 and 004 accepted; 003 open; 011 proposed. |
| [docs/licence-inventory.md](docs/licence-inventory.md) | Every third-party artifact with its exact version and terms. |
| [docs/evidence/](docs/evidence/) | Third-party manifests kept verbatim so the ADR analyses are reproducible without re-fetching hundreds of megabytes. |
| [src/core/](src/core/) | The ports: `LatexCompiler`, `PdfRenderer`, branded project ids and path validation. No browser API touches these. |
| [src/platform/browser/](src/platform/browser/) | Capability probes and the MuPDF renderer adapter behind those ports. |
| [src/workers/pdf/](src/workers/pdf/) | Versioned PDF worker protocol and the MuPDF worker. |
| [src/spikes/](src/spikes/) | Measurement surfaces. The renderer spike loads a PDF through the port; the compiler spike builds a project, opens the result through the renderer, and compares it against desktop's reference on words, ink and pixels; the performance spike times init, cold, warm and cancellation, and samples memory. |
| [tests/fixtures/compiler-corpus/](tests/fixtures/compiler-corpus/) | 13 projects pinned from the desktop examples, with a generated manifest and desktop Tectonic's reference output. The instrument both spikes are measured against. |

## Getting started

```sh
pnpm install
pnpm spike:corpus   # regenerate the corpus from a sibling tectonic-editor checkout
pnpm spike:coverage docs/evidence/wasmtex-0.1.1/manifest.json
./scripts/download-siglum-assets.sh   # 225 MB of engine assets, gitignored
pnpm spike:siglum xelatex             # corpus coverage against those bundles
pnpm spike:corpus-run xelatex --ctan  # compile all 13, needs a running preview
pnpm spike:perf                       # init, cold, warm, memory, cancellation
pnpm spike:firstload                  # bytes a cold first compile transfers
pnpm spike:tex-archive                # indexed TeX archive built from the bundles
pnpm serve:tex-archive --protocol h2  # range-request rig; h1 for the comparison
pnpm spike:range-fetch                # what per-file range requests cost
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
will disagree. `pnpm spike:perf` needs them for its memory column, because
`measureUserAgentSpecificMemory` is the only API that sees the engine's WASM
heap and it requires an isolated page; it also needs real Chrome, since
Playwright's bundled Chromium has that API present but disabled.

Local and deployed behaviour have now disagreed twice, both times on
`busytex.wasm` and both times invisibly — once serving it with a
`Content-Encoding` the engine did not expect, once with a content type that
prevented streaming and compression. `vite.config.ts` is the reference for what
`netlify.toml` should say.

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
