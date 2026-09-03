# ADR-003: LaTeX WASM engine and package distribution

- **Status:** Open — Siglum reaches 11/13 with a self-hosted CTAN proxy
- **Date:** 2026-09-01, last measured 2026-09-03
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
the point of having one. Diagnosing the CTAN-era failures later turned up four
more, numbered 5–8 below, and measuring fidelity turned up two after that,
numbered 9–10.

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

## Measured: with a self-hosted CTAN proxy

`scripts/ctan-proxy.ts` mounts at `/ctan` as Vite dev/preview middleware. It
satisfies ADR-001 by construction:

- **Pinned.** Packages come from TeX Live 2025's `tlnet-final` archive, which is
  frozen, not `tlnet`, which tracks the current release. PLAN.md 7.3 requires
  this — a mutable package URL makes builds unreproducible and can poison an
  offline cache.
- **Cached.** After the first fetch the upstream is never contacted again for
  that package, so a warm deployment serves entirely from its own origin.
- **No name leakage.** Package-name resolution uses Siglum's own
  `file-to-package.json`, already on disk, rather than CTAN's JSON API, so no
  package name leaves the machine at compile time.
- Same-origin, so no CORS surface and no cross-origin isolation interaction.
- Package names from the URL are validated against a conservative pattern
  before touching the filesystem, not sanitised.

### One missing URL was hiding the whole result

The first CTAN run still scored 2/13, with every package fetching successfully.
Siglum loads its XZ decompressor through a script tag from `xzwasmUrl`, which
defaults to `./src/xzwasm.js` — a path that exists only in its own repository
layout. Unset, every package downloaded and then failed to decompress: the
packages arrived, and TeX never saw them. `xzwasm` is an npm dependency rather
than a release asset, so it now ships alongside the other engine assets.

### Result

| | CTAN off | CTAN on |
|---|---|---|
| Compiled | 2 / 13 | 9 / 13 |
| Matching desktop's page count | 2 / 2 | 8 / 9 |

After the two fixes in the next section:

| | CTAN on |
|---|---|
| Compiled | **11 / 13** |
| Matching desktop's page count | **10 / 11** |

`paper-acm` compiles — the ACM template the bundle analysis had flagged as
blocked — but in 51 s, by far the slowest in the corpus and worth its own look.
Of the rest, `presentation-beamer` takes 19 s and `paper-ieee` 17 s, both
dominated by repeated full recompiles; everything else runs in 0.8–5 s.

Page counts are compared through the same renderer for both sides, so a
difference is a real difference rather than two parsers disagreeing.
`paper-acm` produces 3 pages against desktop's 2, which is a fidelity
discrepancy rather than a pass.

## Measured: the four remaining failures, diagnosed

Each was read from its full engine log, captured by
`pnpm spike:corpus-run xelatex --ctan --only <project>` into
`spike-results/logs/`. The earlier reading — "three of the four are font
problems" — was wrong: **two are font-asset problems, one is version skew, and
one is not a package problem at all.**

### `paper-ieee` — the bundle set has no fonts but Computer Modern (fixed)

`! Font T1/ptm/m/n/10=ptmr8t at 10.0pt not loadable: Metric (TFM) file or
installed font not found.`

The bundles ship 1,425 `.tfm` files and every one of them is Latin Modern, EC,
CM, AMS or `ae`. Nothing from the URW base-35 set is present, so Times,
Helvetica and Courier have `.fd` files (in `tex-latex-misc`) that resolve and
then metrics that do not exist. TeX Live's `times` package, in the archive we
already pin, ships `ptmr8t.tfm`.

**Defect 5: font failures are invisible to both resolution paths.** TeX reports
this as a font error, not a "File not found", so the missing-file matcher
never fires. **Defect 6: `file-to-package.json` indexes no font files** — of its
14,695 entries every one is `.sty`, `.fd`, `.def`, `.cls`, `.tex`, `.cfg`,
`.clo` or `.ltx` — so a font name maps to nothing even when it is asked.

Fixed in `font-resolution.ts` by matching the font error and mapping the NFSS
family prefix (`ptm`, `phv`, `pcr`, …) to the TeX Live package that ships its
metrics, then fetching that package by name through the proxy. `paper-ieee` now
compiles to 3 pages, matching desktop.

### `presentation-beamer` — the format is built without babel (fixed)

```text
! Undefined control sequence.
\trans@languagepath ->\languagename
                                   ,English
l.15 \begin{document}
```

Not a package problem. `\languagename` is defined by babel's `hyphen.cfg`, which
a stock TeX Live loads when it builds its formats. Siglum's precompiled formats
are not built that way, so the macro does not exist, and `translator` — which
beamer loads unconditionally — expands it at `\begin{document}`. This is
**defect 7**. A document that loads babel never meets it; `presentation-beamer`
does not, so it could not compile at all.

Confirmed by probe: adding `\usepackage[english]{babel}` compiles it to 5 pages,
and so does `\providecommand{\languagename}{english}` alone — to a PDF of the
same size, so the shim is doing exactly the one thing babel was doing here.

Fixed by prepending that `\providecommand` to every source. Prepended without a
newline, so every line of the user's document keeps its number and SyncTeX and
diagnostic line mapping stay exact; `\providecommand` yields to babel where a
document does load it.

### `cv-modern` — the CTAN fetcher discards OpenType fonts (blocked upstream)

`! Font TU/fontawesomefree/solid/n/10.95=[FontAwesome5Free-Solid-900.otf] ... not
loadable`

Same shape as `paper-ieee` — `fontawesome5.sty` and `tufontawesomefree.fd` are
bundled, the font binary is not — but it cannot be fixed the same way.
**Defect 8: Siglum's CTAN fetcher keeps only `.pfb`, `.pfm`, `.afm`, `.tfm`,
`.vf`, `.map` and `.enc` from a fetched package and discards everything else**,
so the `FontAwesome5Free-Solid-900.otf` that the pinned `fontawesome5` package
does ship can never reach the engine. Nothing the adapter can do delivers an
`.otf`.

The adapter now names the font in the failure summary instead, which is the one
thing a user can act on.

### `letter-formal` — the bundle set is not one TeX Live vintage (blocked)

`! Package lastpage Error: hyperref package version too old.`

The mechanism, end to end: the precompiled format's `\fmtversion` is at least
2024/06/01, so `lastpage2e.sty` selects `lastpagemodern`, which requires
hyperref **≥ 2024-10-30**. The bundled hyperref is **2023-02-07 v7.00v**.

The skew is not between our pin and TeX Live. It is **inside the bundle set**,
which is not one vintage at all:

| bundled package | version |
|---|---|
| `geometry` | 2020/01/02 v5.9 |
| `graphicx` | 2021/09/16 v1.2d |
| `xcolor` | 2022/06/12 v2.14 |
| `hyperref` | 2023-02-07 v7.00v |
| LaTeX kernel (in the format) | ≥ 2024/06/01 |
| `microtype` | 2025/07/09 v3.2b |
| `beamer` | 2025/08/13 v3.76 |
| `etoolbox` | 2025/10/02 v2.5m |

The bundles are labelled TeX Live 2025 and their build script is named
`update-bundles-tl2025.ts`, but their contents span five years. **No pinned
archive can agree with all of it**, so this failure class is structural.

Two things also close off the obvious workaround:

- Force-fetching a newer `hyperref` does not help. Bundles mount first, and
  `mountCtanFiles` skips any path already mounted unless `forceOverride` is
  set — which only Siglum's own fallback sets, and only from inside the worker.
  The adapter cannot make a fetched file shadow a bundled one.
- Siglum's fallback would not fire anyway: it triggers on undefined control
  sequences, and it walks *backwards* (2025 → 2024 → 2023). Our problem needs a
  newer package, not an older one. And our proxy strips the `-20YY` suffix by
  design, so every year it is asked for returns the same frozen bytes — **the
  pin required by PLAN.md 7.3 disables the engine's only built-in skew remedy.**
  That is a deliberate trade, and it is recorded here as one.

### Decision on version skew

**Build the bundle set ourselves, from the single TeX Live tree we already
pin.** It is the only option that makes `packageSetVersion` mean anything: today
a compile can name "texlive-2025/siglum-bundles-v0.1.0" while running a 2020
`geometry` against a 2024 kernel. It also subsumes the two font defects — a tree
we assemble includes the URW base-35 metrics and whatever OpenType faces we
choose to ship, so nothing has to survive the fetcher's extension filter.

Rejected: pinning the proxy to the bundles' vintage (they have no single one);
and shipping the skew as a diagnostic only (necessary as a fallback, but it
leaves documents uncompilable).

This is scoped for Phase 0's close, not now, and it is the largest single item
still standing between this engine and a product.

## Measured: fidelity beyond page count

Page count says only that a document did not fall apart. `pnpm spike:corpus-run`
now compares every compiled project against desktop Tectonic's reference PDF on
three measures, both sides opened through the same renderer so a difference is a
real difference:

- **Words.** Text as a word sequence per page, scored by longest common
  subsequence. Never line by line: line breaking is the engine's own business.
  Unicode is NFKC-folded, so one engine's `ﬁ` ligature and another's `fi` are
  the same word.
- **Ink.** The fraction of non-white pixels. Survives sub-pixel shifts and still
  catches content that vanished or arrived twice.
- **Pixels.** A differing-pixel ratio at 1 px/pt with an antialiasing tolerance.
  The strictest and the easiest to misread — a tenth-of-a-point baseline shift
  lights up every glyph — so a low figure means "laid out the same" and a high
  one means *look*, not *fail*.

Bytes are never compared: PDFs carry timestamps and object ordering that differ
between identical runs.

### How close the corpus gets

**30 of 60 pages reproduce desktop's text word for word.**

| project | exact pages | mean words | worst page | ink | pixels |
| --- | --- | --- | --- | --- | --- |
| `blank` | 1/1 | 1.0000 | 1.0000 | 0.0000 | 0.0000 |
| `poster-academic` | 0/1 | 0.9908 | 0.9908 | 0.0000 | 0.0192 |
| `thesis-standard` | 8/16 | 0.9896 | 0.9515 | 0.0005 | 0.0659 |
| `report-technical` | 7/12 | 0.9888 | 0.9404 | 0.0005 | 0.0975 |
| `report-scientific` | 7/8 | 0.9844 | 0.8750 | 0.0002 | 0.0056 |
| `newsletter` | 0/3 | 0.9757 | 0.9633 | 0.0002 | 0.1016 |
| `book-standard` | 7/8 | 0.9643 | 0.7143 | 0.0005 | 0.0060 |
| `paper-standard` | 0/1 | 0.9091 | 0.9091 | 0.0006 | 0.0113 |
| `presentation-beamer` | 0/5 | 0.8530 | 0.7895 | 0.0031 | 0.0290 |
| `paper-acm` | 0/2 | 0.8000 | 0.7271 | 0.0078 | 0.2124 |
| `paper-ieee` | 0/3 | 0.7878 | 0.6536 | 0.0171 | 0.2735 |

The measurement found two more defects on its first run.

### Defect 9: the rerun budget is predicted, not read

`poster-academic` and `newsletter` matched desktop on words to within a
hyphenation point and yet carried **a quarter of the reference's ink** — 0.0454
against 0.1833 on the poster. Both open page 1 with a TikZ `remember picture,
overlay` full-bleed banner, and neither banner was drawn.

`remember picture` needs two passes: the page node coordinates are written to
the `.aux` on the pass that has just finished. TeX said so —
`LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.`
— and Siglum ran one pass anyway. Its `predictRequiredPasses` decides the budget
**before compiling**, by matching `\ref`, `\cite`, `\label`,
`\tableofcontents` and friends against the source; neither document uses any of
them, so both were put in "single-pass mode: no cross-references detected" and
the rerun loop was never entered. Every mechanism that needs a second pass
without one of those macros is affected: `remember picture`, `lastpage`,
`totpages`, `longtable` column widths, anything writing to the `.aux`.

Fixed by taking the request from the log instead of from a prediction: after a
successful compile, rerun while TeX asks, bounded at four passes. Siglum caches
`.aux` files between compiles keyed on the preamble, so a second call reads back
what the first wrote.

### Defect 10: the PDF cache is keyed on the source alone

The first version of that fix changed nothing. The rerun fired and returned pass
one's PDF: Siglum caches a compiled document against `hashDocument(source)`, and
a rerun has the same source by definition and a different `.aux`. Any engine
that reruns at all has two different correct outputs for one source, so this key
cannot be right. Fixed by disabling the cache on rerun passes.

With both fixed, the poster's ink delta went **0.1380 → 0.0000** and its pixel
difference **0.1584 → 0.0192**; the newsletter's **0.1386 → 0.0002** and
**0.2464 → 0.1016**.

### The missing babel setup costs typography everywhere

Defect 7 was diagnosed as a beamer crash. It is wider than that. `hyphen.cfg`
also sets `\lefthyphenmin` and `\righthyphenmin`, and without it they keep TeX's
primitive default of **zero** — so the engine breaks words after a single
letter. The divergence column showed it plainly across four documents:
`presentations` broken as `p-`, `Standards` as `S-`.

Setting the two primitives produces output identical to loading babel, at none
of its download cost — measured, not assumed: `\usepackage[english]{babel}` and
`\lefthyphenmin=2 \righthyphenmin=3` give the same page-by-page scores on
`newsletter`. Both are now in the format shim.

**It barely moves the numbers**, and that is worth stating rather than dressing
up: 30/60 pages before and after, with three documents' means improving in the
third decimal and one falling. The reason is a limit of the instrument — the
metric measures *agreement with desktop*, not correctness, and a break in an
invalid place scores exactly the same as a break in a different valid one. The
evidence for the shim is the divergence text, where one-letter breaks disappear,
not the score. It stays because the output it removes is wrong by any
typographic standard, whatever desktop did.

### What the remaining gap is made of

- **`\today`, not the engine.** Four documents' worst page differs only in a
  month name: the reference PDFs were built in February and March, and the runs
  comparing against them in September. A corpus artefact, and the reason
  `paper-standard` scores 0.9091 on an otherwise identical title page.
- **Hyphenation points.** `report-technical` and `thesis-standard` break words
  where desktop did not — legally, now, but differently.
- **Two-column drift.** `paper-ieee` and `paper-acm` are the worst by a
  distance. On `paper-ieee` the divergence begins at word 64 of page 1 (desktop
  hyphenates `han-dling`, we do not) and compounds: by page 3 desktop is inside
  the bibliography where we are still printing its heading. Same page count,
  offset content. `paper-acm` is the one document whose page count still differs,
  3 against 2.

### Not measured: diagnostics

PLAN.md 7.4 also asks for diagnostics to be compared. They cannot be, yet: the
corpus commits desktop's reference *PDFs* but not its *logs*, so there is
nothing to compare a parsed diagnostic against. Committing Tectonic's logs
alongside the PDFs is what that needs.

## Still to measure

The CTAN path is answered: **11/13, with 10 of 11 matching desktop's page
count**, up from 9/13 and 8/9 once the two fixable failures above were resolved.
What remains is fidelity beyond page count, performance, and the two structural
failures.

- [x] Stand up a self-hosted CTAN proxy and re-run the corpus with `--ctan`.
- [x] Compare page counts against the committed reference PDFs.
- [x] Compare extracted text and rendered page images too — not bytes, which
      carry nondeterministic metadata. 30/60 pages match word for word.
- [ ] Compare diagnostics, which needs desktop Tectonic's logs committed
      alongside the reference PDFs. There is nothing to compare against today.
- [x] Diagnose the four remaining failures. Two were font-asset gaps, one is
      version skew, one was a format built without babel. Two are fixed.
- [ ] Investigate `paper-acm` at 51 s, and its 3-versus-2 page discrepancy.
      `presentation-beamer` and `paper-ieee` are the next slowest, both spending
      most of it on repeated full recompiles. Every timing in this ADR predates
      the rerun fix, which adds passes by design; performance needs its own
      clean run rather than numbers taken alongside a fidelity comparison.
- [ ] Chase the two-column drift in `paper-ieee` and `paper-acm`, which starts
      as one hyphenation decision on page 1 and compounds.
- [x] Decide how to handle version skew between bundled TeX Live packages and
      pinned-archive fetches, which is what breaks `letter-formal`: rebuild the
      bundle set from the single tree we pin.
- [ ] Carry that decision out, and measure what it costs to host.
- [ ] Cold and warm compile time, peak memory, cancellation behaviour.
- [ ] Multi-pass bibliography orchestration across `natbib`, `cite` and
      `acmart`. No corpus project has reached its bibliography yet.
- [ ] First-load and offline story: the xelatex baseline is 39 MB before any
      document-specific bundle, on top of MuPDF's 10.4 MB.
- [ ] Whether the same defects appear in `wasmtex` and `texlyre-busytex`, which
      wrap the same BusyTeX build. Defects 7 and 8 are properties of the BusyTeX
      format build and fetcher, so they probably travel.

## Consequences so far

`LatexCompiler` in `src/core/compiler/types.ts` remains the only compiler
surface any other code may depend on, and it has now earned that: seven of the
eight engine defects are absorbed by the adapter without anything above it
knowing. Had the spike called Siglum directly, those workarounds would be spread
through the product.

The eighth — the CTAN fetcher discarding OpenType fonts — is the first defect
the port cannot hide, and it is instructive: the adapter can compensate for what
an engine *does*, but not for what it will not carry. That is the same
conclusion the version-skew decision reaches from the other side, and together
they point at owning the package tree rather than consuming someone else's.

Defects 9 and 10 make a different point, about measurement rather than
architecture. Both produced *plausible* output — a poster that compiled, opened
and read correctly, and simply had no banner on it. Page count would never have
found either; nor would a human skim of a PDF they had not seen before. They
were found because the harness compared ink against a reference, which is an
argument for keeping the corpus and its reference PDFs as a permanent fixture
rather than a Phase 0 instrument.

`EngineIdentity` carries the package-set version on every result, which the
pinned asset release makes meaningful: a compile can name exactly the TeX Live
snapshot that produced it.
