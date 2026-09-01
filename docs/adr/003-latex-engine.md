# ADR-003: LaTeX WASM engine and package distribution

- **Status:** Open — candidate set revised, package coverage measured
- **Date:** 2026-09-01
- **Deciders:** danylaksono

## Context

Desktop compiles with Tectonic, which is XeTeX-derived. A browser engine that
only offers pdfTeX will differ in font handling, Unicode and package behaviour
even where simple documents compile identically, so "it compiled" is not the
acceptance test.

The corpus in `tests/fixtures/compiler-corpus` is the measurement instrument:
13 projects, 6 document classes, 32 distinct packages, 4 needing bibliography
passes across `natbib`, `cite` and `acmart` styles.

## The candidate set in PLAN.md is out of date

PLAN.md 7.1 treats SwiftLaTeX as the primary candidate, with
"TeXlyre/BusyTeX variants" as a research candidate. Surveying what is actually
distributable today changes that picture in two ways.

**SwiftLaTeX is not on npm at all.** It is distributed as loose engine files
from GitHub, and its pdfTeX/XeTeX builds predate the TeX Live 2025/2026 WASM
work below.

**The candidate set collapses onto one engine.** Every maintained browser TeX
distribution found on npm wraps **BusyTeX**, a TeX Live→WASM build:

| Package | Licence | TeX Live | Engine | Asset delivery |
| --- | --- | --- | --- | --- |
| `texlyre-busytex` 1.4.0 | AGPL-3.0-or-later | 2026 | BusyTeX | Single 522 MB archive, self-hosted from GitHub Releases |
| `wasmtex` 0.1.1 | MIT | 2026 (tlpdb r78233) | BusyTeX | Tiered: core 37.6 MB, academic 381 MB, both self-hosted, `SHA256SUMS` + `manifest.json` |
| `@siglum/engine` 0.1.4 | MIT | 2025 | BusyTeX | 30.8 MB engine + 199 MB bundles, plus on-demand CTAN fetching through a self-hostable proxy |
| `@typeward/texlive-wasm` 0.2.4-alpha | MIT | — | — | Alpha, no documentation published |

So the real decision is **not which TeX engine** — it is package delivery,
offline policy and API shape. All three provide `xetex` as well as `pdftex`,
which removes the pdfTeX-versus-XeTeX compatibility worry PLAN.md 7.1 raised
and makes open question 2 in PLAN.md 17 moot.

## Measured: corpus package coverage

Run `pnpm spike:coverage docs/evidence/wasmtex-0.1.1/manifest.json`. Against
wasmtex 0.1.1 (TeX Live 2026, tlpdb r78233), whose manifest declares what each
tier provides:

| Bundle | Size | Packages | Cumulative corpus coverage |
| --- | --- | --- | --- |
| core | 55.1 MB | 157 | 11 / 32 |
| academic | 505.9 MB | 2414 | 30 / 32 |

Per project, the `core` tier alone compiles only `blank` and `book-standard`.
Everything else needs the academic tier — and two projects are blocked outright:

> **`acmart` and `IEEEtran` are provided by no bundle.**

That blocks `paper-acm` and `paper-ieee`, the two templates most likely to
matter to the target user. A product for researchers that cannot build an ACM
or IEEE submission has a hole in exactly the wrong place.

This coverage result cost 0.4 MB of manifest download rather than the 435 MB of
assets, and it reframes the choice: **the deciding property is whether missing
packages can be added at all**, not raw compile fidelity.

- `wasmtex` and `texlyre-busytex` ship fixed bundles. A package outside them is
  unavailable unless we rebuild the bundle ourselves.
- `@siglum/engine` fetches unbundled packages from CTAN on demand and caches
  them, which is exactly the "baseline plus versioned on-demand packages"
  strategy PLAN.md 7.3 recommends, and would cover `acmart` and `IEEEtran`.

That advantage carries an ADR-001 obligation: on-demand fetching reveals which
packages a document uses to whoever serves them. ADR-001 permits fetching
*runtime assets* from our own static origin, so the proxy must be self-hosted
and its responses version-pinned or content-addressed. A live pass-through to a
third-party CTAN mirror would not be acceptable.

## Engine artifact licensing

`wasmtex` publishes a machine-checked audit alongside its assets
(`docs/evidence/wasmtex-0.1.1/licenses.json`): 2545 shipped TeX Live packages
checked against an explicit allowlist, 0 failures. Combined with `SHA256SUMS`
and a pinned `tlpdbRevision`, that satisfies most of the PLAN.md 15 spike item
on engine and package licensing for that candidate. No equivalent audit has
been located for the other two.

Note the app is now AGPL-3.0-or-later (ADR-002), so `texlyre-busytex`'s AGPL
licence is no longer a constraint the way it would have been under MIT.

## Still to measure

Coverage says what *can* load; none of it says what compiles correctly.

- [ ] Compile outcome for all 13 corpus projects, per candidate.
- [ ] Compare outcome, page count, extracted text, diagnostics and rendered
      page images against the committed reference PDFs — not bytes, which carry
      nondeterministic metadata.
- [ ] Cold and warm compile time, peak memory, cancellation behaviour.
- [ ] Whether usable SyncTeX is emitted (`texlyre-busytex` claims it).
- [ ] Multi-pass bibliography orchestration across `natbib`, `cite` and
      `acmart`.
- [ ] Whether `acmart` and `IEEEtran` can in fact be resolved on demand.
- [ ] First-load and offline story: 55 MB is already five times the MuPDF WASM.

## Consequences so far

`LatexCompiler` in `src/core/compiler/types.ts` remains the only compiler
surface any other code may depend on. `EngineIdentity` carries the package-set
version on every result, which the pinned `tlpdbRevision` now makes meaningful:
a compile can name exactly the TeX Live snapshot that produced it.
