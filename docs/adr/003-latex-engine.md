# ADR-003: LaTeX WASM engine and package distribution

- **Status:** Open — Siglum compiles in-browser; CTAN path untested
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

## Measured: Siglum compiling the corpus in a browser

`@siglum/engine` 0.1.4 with the pinned v0.1.0 assets (TeX Live 2025, 225 MB
unpacked), xelatex, CTAN **off**, Chromium, production build. Reproduce with
`pnpm spike:corpus-run xelatex` against a running preview.

**The engine works.** `blank` compiles in 747 ms and `book-standard` in 1740 ms
to 8 pages, both verified by opening the result through the `PdfRenderer` port —
producing bytes is not the same as producing a readable PDF. **SyncTeX is
emitted**, which answers PLAN.md open question 6 for this candidate.

**2 of 13 projects compile without CTAN.** Every remaining failure is a
genuinely unbundled package: `booktabs` (4 projects), `enumitem` (3),
`titlesec`, `translator`, `acmart`, `IEEEtran`.

### Four defects in Siglum's package resolution

None of these are exotic — all four were hit by ordinary corpus documents, and
all four are worked around in
`src/platform/browser/compiler/siglum-compiler.ts`, behind the port, which is
the point of having one.

1. **The xelatex baseline cannot render T1 encoding.** `core` ships `tulmr.fd`
   (TU/Unicode) but not `t1lmr.fd`. A document using the pdfTeX-oriented
   `\usepackage[T1]{fontenc}` idiom — 9 of the 13 corpus projects — dies with
   "Corrupted NFSS tables", a circular font substitution rather than a missing
   file. On-demand resolution cannot help, because NFSS looks the file up
   internally and no `\usepackage` line names the bundle holding it. Fixed by
   loading `tex-latex-misc` and `fonts-lm-type1` up front.

2. **Document classes are absent from the package index.** Siglum extracts
   `\documentclass{X}` correctly, but its package-to-bundle map is built from
   `.sty` files, so `beamer` maps to nothing while `beamerarticle` and every
   `beamerbase*` file is listed — and the `beamer` bundle sits unused on disk.
   Fixed by resolving classes through `file-manifest.json`.

3. **Bundle `requires` lists are incomplete.** The `beamer` bundle declares
   `pgf-tikz` and `graphics` but not `utils`, which holds the `etoolbox.sty` it
   needs. Fixed with a bounded resolve-and-retry loop: on "File `x' not found",
   look `x` up in the file manifest, load its bundle, recompile. TeX reports one
   missing file per run, so beamer needed three passes — `utils`, `pgf-tikz`,
   `xcolor` — before reaching a genuinely absent package.

4. **`result.log` is always empty**, even with `verbose` on; engine output only
   reaches the `onLog` callback. Left uncaptured, there is no log to show a
   user, no diagnostics to parse, and nothing to resolve missing files against,
   so every failure reads as a bare "Compilation failed". Fixed by capturing the
   callback stream — which is also what turned the corpus results from
   `unknown` into `missing-package`.

### Deployment finding

Siglum's `.data.gz` bundles are pre-compressed *payloads* that the engine
gunzips itself, not files the transport should encode. Vite's static middleware
sees the extension and sets `Content-Encoding: gzip`, so the browser
transparently decompresses them and the engine then fails trying to gunzip plain
bytes — surfacing as a bare "Failed to fetch" while every request returns 200.
Siglum special-cases `Content-Encoding: br` but not gzip. These files must be
served as `application/octet-stream` with no `Content-Encoding`; vite.config.ts
and netlify.toml both carry the rule now.

### Dependency defect

`blake3-wasm` 2.1.5, which Siglum depends on, ships a browser build whose
`blake3_js.js` re-exports `./blake3_js_bg.js` — a file the package does not
include, so any bundler resolving it fails. Siglum falls back to DJB2, so it is
aliased to a stub. DJB2 keys the document and preamble caches and collides far
more readily than BLAKE3, so this needs resolving before any cache-correctness
claim.

## Still to measure

**The CTAN path, which is now the deciding question.** 10 of 13 projects need
it and it is untested: Siglum's proxy is a Cloudflare Worker run under Bun, and
ADR-001 requires it self-hosted with version-pinned responses. Until that runs,
Siglum's honest score is 2/13.

- [ ] Stand up a self-hosted CTAN proxy and re-run the corpus with `--ctan`.
- [ ] Compare outcome, page count, extracted text, diagnostics and rendered page
      images against the committed reference PDFs — not bytes, which carry
      nondeterministic metadata.
- [ ] Cold and warm compile time, peak memory, cancellation behaviour.
- [ ] Multi-pass bibliography orchestration across `natbib`, `cite` and
      `acmart`. No corpus project has reached its bibliography yet.
- [ ] First-load and offline story: the xelatex baseline is 39 MB before any
      document-specific bundle, on top of MuPDF's 10.4 MB.
- [ ] Whether the same four resolution defects appear in `wasmtex` and
      `texlyre-busytex`, which wrap the same BusyTeX build.

## Consequences so far

`LatexCompiler` in `src/core/compiler/types.ts` remains the only compiler
surface any other code may depend on, and it has now earned that: four engine
defects are absorbed by the adapter without anything above it knowing. Had the
spike called Siglum directly, those workarounds would be spread through the
product.

`EngineIdentity` carries the package-set version on every result, which the
pinned asset release makes meaningful: a compile can name exactly the TeX Live
snapshot that produced it.
