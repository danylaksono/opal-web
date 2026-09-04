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
more, numbered 5–8 below; measuring fidelity turned up two after that, 9–10;
and measuring memory turned up an eleventh.

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

### `letter-formal` — the bundle set is not one TeX Live vintage (fixed by a pinned tree)

`! Package lastpage Error: hyperref package version too old.`

The mechanism, end to end: the precompiled format's `\fmtversion` is at least
2024/06/01, so `lastpage2e.sty` selects `lastpagemodern`, which requires
hyperref **≥ 2024-10-30**. The bundled hyperref is **2023-02-07 v7.00v**.

**Since fixed, which confirms the diagnosis.** Resolving this document's files
from a single TeX Live vintage instead — Tectonic's TL2022 tree, delivered as an
indexed archive (ADR-011) — compiles it, with the CTAN proxy switched off
entirely. Nothing about the engine changed; only the package set stopped being
five vintages at once.

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

## Measured: what a compile costs, and whether one can be stopped

`pnpm spike:perf` against a preview built with `OPAL_COI=1`, in real Chrome.
Both conditions are load-bearing: peak memory needs
`measureUserAgentSpecificMemory`, the only API that sees the engine's WASM heap,
and it needs a cross-origin-isolated page — which Playwright's bundled Chromium
has present but disabled, so the runner launches `channel: "chrome"` and falls
back to Chromium with the memory column dropped rather than reporting a
JS-heap-only figure that would look like an answer.

Measured with the engine recycle **off**, so the memory column shows the
untreated leak that motivated it; the recycled figures are under "What
recycling costs".

| project | init | cold | warm | cached | warm saves | peak memory |
| --- | --- | --- | --- | --- | --- | --- |
| `paper-acm` | 501 ms | 57.5 s | 5.1 s | 0 ms | 91% | 1024 MB |
| `presentation-beamer` | 546 ms | 36.1 s | 12.2 s | 0 ms | 66% | 1222 MB |
| `paper-ieee` | 479 ms | 19.0 s | 1.6 s | 0 ms | 92% | 1033 MB |
| `report-scientific` | 583 ms | 11.5 s | 2.4 s | 0 ms | 79% | 1164 MB |
| `report-technical` | 699 ms | 7.8 s | 2.1 s | 0 ms | 73% | 1064 MB |
| `thesis-standard` | 602 ms | 7.1 s | 2.4 s | 1 ms | 67% | 998 MB |
| `newsletter` | 553 ms | 6.5 s | 2.3 s | 0 ms | 64% | 1203 MB |
| `letter-formal` | 565 ms | 5.3 s | 4.1 s | 4077 ms | 22% | 1146 MB |
| `cv-modern` | 549 ms | 4.9 s | 3.1 s | 3338 ms | 38% | 1231 MB |
| `poster-academic` | 570 ms | 4.6 s | 2.4 s | 0 ms | 48% | 1132 MB |
| `paper-standard` | 597 ms | 4.2 s | 1.2 s | 0 ms | 71% | 938 MB |
| `book-standard` | 527 ms | 4.1 s | 1.1 s | 0 ms | 73% | 929 MB |
| `blank` | 521 ms | 1.4 s | 0.8 s | 0 ms | 42% | 907 MB |

"Warm" is the document *edited* and recompiled with the engine already up,
which is what every cycle after the first actually costs. It has to be an edit:
Siglum keys its PDF cache on a hash of the source, so recompiling an unchanged
document never reaches the engine — that is the "cached" column, and it is
measuring the cache rather than the compiler.

### Defect 11: the engine leaks a WASM instance per compile

**After init the whole page holds 40 MB. Peak during a compile is 0.9–1.2 GB.**

The engine is cheap to load and enormous to run, and the cost is not the
document: `blank` peaks at 907 MB on a single pass, within 30% of the largest
figure in the corpus.

Sampling per stage on `blank` says what is happening, and it is worse than a
fixed cost:

| stage | total | worker realm |
| --- | --- | --- |
| after init | 40 MB | 2 MB |
| after one compile | 490 MB | 420 MB |
| after two compiles | 907 MB | 836 MB |

That is **~418 MB per compile, retained**. `measureUserAgentSpecificMemory`
forces a collection before it reports, so these are not uncollected temporaries
— the instances are held. The mechanism is in `getOrCreateModule`, which does
not cache despite its name: every TeX pass instantiates a fresh WASM module and
the previous one is never released.

Fixed in the adapter by throwing the engine away after each compile — the only
lever available, since nothing in Siglum's API releases it. The recycle is
started after the result has been returned and is not awaited, so it overlaps
with whatever the caller does next. On `blank` this takes peak memory from
**907 MB to 100 MB**, and it also fixes the flaky post-abort recovery noted
below, since recovery now runs against a fresh engine by construction.

It is not free: a recycled engine remounts its bundles, so a warm compile is no
longer warm. The corpus-wide cost is measured under "What recycling costs".

None of this showed up until now because nothing was measuring it, and nothing
could: without cross-origin isolation the only available API counts the JS heap,
which here is under 3 MB — three orders of magnitude off.

### What recycling costs

Corpus-wide, with the recycle on against off:

| | recycle off | recycle on |
| --- | --- | --- |
| Peak memory | 907–1231 MB | 34–49 MB |
| Total cold, 13 projects | 170 s | 173 s |
| Total warm, 13 projects | 41 s | 87 s |
| Worst warm | 12.2 s (`presentation-beamer`) | 30.0 s |

Memory becomes flat and roughly document-independent. Cold is unchanged, because
a cold compile was paying for its mounts anyway. **Warm roughly doubles**, and
worst-case warm nearly triples: a recycled engine has thrown away its mounted
bundles and fetched packages, so every compile is effectively cold. `paper-acm`
goes from 5.1 s to 23.2 s.

There is no policy that avoids this. Delaying the recycle does not help — the
next compile still meets a fresh engine — and recycling every *n*th compile
scales the peak by *n*, which at 418 MB a compile is over budget at n=2. With
this engine, bounded memory and a fast edit cycle are mutually exclusive.

**Shipped on by default anyway.** Slow is bad; unbounded is fatal. These
measurements cover three compiles; an ordinary editing session is dozens, and
the untreated growth reaches several gigabytes long before a user stops typing.

The proper fix is upstream and is not the instance-per-pass itself — Siglum
creates a fresh WASM instance deliberately, because TeX's C globals do not
survive reuse, and its own memory-snapshot path is disabled in a comment saying
so. The defect is only that the *previous* instance stays reachable. Released
properly, memory would be flat with no recycle and no warm-compile penalty. The
adapter's worker restart is a blunt substitute for a fix it cannot make.

### `paper-acm` at 57 s: one missing file per full recompile

TeX stops at the first file it cannot find, so each pass discovers exactly one
missing package, and both retry loops — Siglum's own and the adapter's —
recompile from scratch to find the next. `paper-acm` runs **22 full XeTeX
passes** in one `compile()` call, chaining `xkeyval`, `xstring`, `amsart`,
`amsmath`, `microtype`, `etoolbox`, `ltxcmds`, `totpages`, `trimspaces`,
`pdfescape`, `hyperxmp`, `ifmtarg`, `manyfoot`, `caption`, `float`, `comment`
and `balance`. Time tracks pass count across the whole corpus: `blank` 1 pass,
`thesis-standard` 3, `paper-ieee` 7, `presentation-beamer` 16, `paper-acm` 22.

Every one of those packages is named in a `\RequirePackage` line inside a file
already on disk by the time it is needed. Resolving that closure before
compiling, rather than discovering it one full pass at a time, is what would
collapse this — and it is the same shape of problem as defects 2 and 3: an
index that could answer the question is not being asked.

The warm column shows how much of this is first-open cost: `paper-acm` drops
from 57 s to 5.1 s, `paper-ieee` from 19 s to 1.6 s. What a user feels while
writing is the warm figure, and the worst of those is
`presentation-beamer` at **12.2 s**, which is still too slow for an edit cycle.

### Rejected: resolving the package closure before compiling

The obvious fix for the above is to stop discovering one package per compile.
Every package in that chain is named in a `\RequirePackage` line inside a file
already on disk when it is wanted, so reading those lines should turn a chain of
compiles into a chain of fetches. Implemented and measured, it made `paper-acm`
**worse**: 129 packages fetched instead of 19, 128 s instead of 57, and the
compile no longer succeeded at all.

The reason is not over-fetching being slow. It is that **making a package
available changes what a document does**. `acmart.cls` line 852:

```tex
\IfFileExists{libertine.sty}{}{\ClassWarning{\@classname}{You do not
    have the libertine package installed. ...}}
```

It probes, warns, and carries on with a fallback. Once the closure scan had
fetched `libertine.sty`, the file existed, so `acmart` took the branch that
actually loads `libertine` and `newtxmath` — which under xelatex pulls
`fontspec` and then the OpenType fonts defect 8 discards. A class that degrades
gracefully when a package is missing is *harmed* by being given it
speculatively.

So a static closure over-approximates, and over-approximation is not a
performance trade here — it is a behaviour change. Any version of this has to
distinguish requirements a document will certainly load from ones it merely
probes for, which means knowing which conditional branch TeX will take, which
means running TeX. The reverted work is not in the tree; this note is what it
produced.

What remains available is narrower: batch only what TeX has *already* named. It
does not help, because TeX names one file at a time — which is the defect.

### Cancellation works, and had to be built

The port has always declared `signal` and a `cancelled` category; the adapter
checked the signal once, before starting, and never again. Siglum exposes no
cancel and a WASM TeX run holds its worker's only thread, so there is nothing to
ask politely. The adapter now races each pass against the signal, terminates the
worker, and returns `cancelled`.

**Abort latency is 0–16 ms** from signalling to control returning, on all 13
projects. Recovery — a compile after the abort, paying a full engine re-init —
succeeded on 11 of 13; the two that failed, `cv-modern` and `letter-formal`,
fail anyway. `presentation-beamer` recovered in one run and failed in another
before the recycle landed; with the recycle on it recovers, which is expected —
recovery now runs against a fresh engine by construction rather than one that
has just had a TeX run terminated under it.

### A cache that helps least when it is needed most

The "cached" column is 0 ms everywhere except `letter-formal` and `cv-modern`,
at 4.1 s and 3.3 s — the two documents that fail. Siglum caches successful
compiles only, so a user iterating on a document with an error gets no cache at
all, which is precisely when they recompile most often.

## Measured: what a first load costs

`pnpm spike:firstload`, a cold browser context per project — empty HTTP cache,
empty IndexedDB — compiling once and counting every byte that crossed the wire.

| project | bundles | engine | renderer | total | production-equivalent |
| --- | --- | --- | --- | --- | --- |
| `blank` | 25.6 MB | 29.4 MB | 10.0 MB | 65.1 MB | ~41 MB |
| `book-standard` | 26.9 MB | 29.4 MB | 10.0 MB | 66.4 MB | ~42 MB |
| `paper-standard` | 26.9 MB | 29.4 MB | 10.0 MB | 66.4 MB | ~42 MB |
| `thesis-standard` | 40.0 MB | 29.4 MB | 10.0 MB | 79.7 MB | ~56 MB |
| `report-technical` | 55.2 MB | 29.4 MB | 10.0 MB | 94.9 MB | ~71 MB |
| `poster-academic` | 65.9 MB | 29.4 MB | 10.0 MB | 105.5 MB | ~82 MB |
| `report-scientific` | 70.6 MB | 29.4 MB | 10.0 MB | 110.1 MB | ~86 MB |
| `newsletter` | 82.6 MB | 29.4 MB | 10.0 MB | 122.1 MB | ~98 MB |
| `paper-ieee` | 92.7 MB | 29.4 MB | 10.0 MB | 132.7 MB | ~109 MB |
| `paper-acm` | 95.7 MB | 29.4 MB | 10.0 MB | 135.6 MB | ~112 MB |
| `presentation-beamer` | 118.9 MB | 29.4 MB | 10.0 MB | 158.6 MB | ~135 MB |

The production-equivalent column applies the measured gzip ratios for the two
WASM binaries, which the preview server sends uncompressed: `busytex.wasm`
29.4 → 11 MB, MuPDF 10.0 → 4.4 MB. The `.data.gz` bundles are already
compressed and do not shrink further. `cv-modern` and `letter-formal` are left
out of the table because they fail to compile and so never open a PDF, which
makes their renderer column zero rather than comparable.

**41 MB is the floor and 135 MB the ceiling.** On a good 4G connection that is
38 seconds to two minutes; on slow 3G the floor alone is nearly four minutes. It
is a one-time, indefinitely cacheable cost, and the product is offline-capable
afterwards.

### The engine is a constant; the bundles are the problem

The engine is 29.4 MB whatever the document. Everything above that floor is TeX
packages, and it ranges over 4.6×. Two bundles account for most of it:

- **`cm-super`, 57.2 MB**, loaded by nine of thirteen projects. It is Type 1
  outlines for the EC fonts, wanted because those documents write
  `\usepackage[T1]{fontenc}` — the pdfTeX idiom that defect 1 already forced a
  workaround for. On a XeTeX engine with TU encoding, Latin Modern's OpenType
  faces cover the same ground in a bundle of 72 files. **This is the largest
  single recoverable item in the whole first load**, and recovering it is a
  question of what the bundle set targets, not of compression.
- **`pgf-tikz`, 31 MB**, which beamer pulls unconditionally.

`blank` also fetches `fmt-pdflatex`, a precompiled pdfTeX format, on a run that
uses xelatex.

Bundles are also all-or-nothing: `cm-super` arrives as 57.2 MB because the
engine wanted some of its 409 files. Nothing in this delivery model can fetch
a font and leave the rest.

None of this is inherent to running TeX in a browser. It is what one
distribution chose to bundle, and it is the same conclusion the version-skew
decision reached: **the package tree has to be ours.**

### A deployment defect the measurement found

`netlify.toml` carried `for = "/engines/*"` with
`Content-Type: application/octet-stream`, a rule written for the `.data.gz`
payloads that also caught `busytex.wasm` — the single largest response in any
first load. Octet-stream is the one content type that both rules out
`WebAssembly.instantiateStreaming` and stops a CDN compressing the response, so
production would have shipped 29.4 MB where 11 MB would do.

It was invisible locally: Vite's middleware keys on `.data.gz` specifically and
serves the engine as `application/wasm`. That is the **second** time production
and local have diverged on this one file, in opposite directions. The rule is
now scoped to `.data.gz`, and the config points at `vite.config.ts` as the
reference for what it should match.

## Research: making first load smaller

41 MB floor, 135 MB ceiling. A couple of minutes of first load is acceptable if
the user understands it; 135 MB on mobile data is not. This is what the options
look like, cheapest first. None involves server-side compilation.

### Free, and already half-done

**Brotli instead of gzip.** Measured on our own binaries:

| | raw | gzip -9 | brotli -11 |
| --- | --- | --- | --- |
| `busytex.wasm` | 29.4 MB | 11 MB | **7 MB** |
| MuPDF WASM | 10.4 MB | 4.7 MB | **3.6 MB** |

That is 4.4 MB off the floor for a build-time setting. It needs the content-type
fix above to be in place first, since nothing compresses `octet-stream`.

**Streaming compilation.** `WebAssembly.instantiateStreaming` compiles while the
binary downloads rather than after. It requires `application/wasm`, which the
same header fix restores.

### The engine ships four engines and we use one

`busytex.wasm` contains pdfTeX, XeTeX, LuaTeX/LuaHBTeX, BibTeX, makeindex and
dvipdfmx in a single binary — a BusyBox-style multi-call build, which is what
the name says. Counting symbol references: `luatex` 116, `dvipdfmx` 155,
`pdftex` 38, `xetex` 12. LuaTeX is by far the largest TeX engine, embedding a
Lua interpreter and HarfBuzz, and we compile with xelatex only.

A XeTeX-only build would remove most of the 7 MB. It means building BusyTeX
ourselves, which is real work, but it is the same work as owning the package
tree and would be done alongside it.

### Bundles are all-or-nothing, and that is a bug not a design

Siglum has a lazy filesystem: a deferred bundle mounts *file markers* rather
than data, and there is a full HTTP range-request path with request coalescing
to fetch individual files out of a bundle. It is never used for the case that
matters. `worker.js`:

```js
if (deferredBundles.has(bundleName) && !bundleDataMap.has(bundleName)) {
    // load the whole thing
}
// Range requests only for already-loaded bundles, or if the full fetch failed
```

There is no size threshold. **Any deferred bundle is fetched whole the first
time any single file in it is wanted**, and the range path only runs for bundles
already in memory — where it is pointless, because the data is already there.
One font from `cm-super` costs 57.2 MB.

So the machinery for the obvious fix exists and is wired backwards. We cannot
reach it: `deferredBundles` and `bundleDataMap` are worker-internal, and the
adapter's only bundle lever is `eagerBundles`, which points the other way.

What we *can* control is granularity. The engine always fetches a whole bundle,
so **bundle size is the unit of waste**, and a tree we build ourselves can make
them small. That turns "own the package tree" from a correctness decision into a
first-load decision as well.

### The model to copy already exists, in the tool desktop uses

**Tectonic** — the engine desktop compiles with — solves exactly this problem.
Its `.ttb` bundle is an *indexed* archive served from a plain URL, and it pulls
down only the files a document actually references, caching them locally. No
compute on the server: an index and byte ranges over static files. Desktop has
been relying on this the whole time.

**SwiftLaTeX** does the same from the browser side: on a missing file the engine
asks a resolver, which tries the local cache, then a bundled subset, then a
TeX Live mirror, storing every resolved file in Cache Storage so nothing is
fetched twice. Its `Texlive-Ondemand` component is a Flask app that resolves
names with kpathsea — that part *is* server processing, but it is resolution,
not compilation, and resolution can be precomputed into a static index at build
time. We already have the shape of one in `file-manifest.json`.

**TeXbrain** (MIT) is an existence proof of the whole stack with no server at
all: SwiftLaTeX's pdfTeX WASM, on-demand packages, deployed as static files to
GitHub Pages.

Two caveats before treating SwiftLaTeX as a candidate. It is AGPL-3.0, which
ADR-002 already made a non-issue. And its engine predates TeX Live 2025/2026,
which is why section 7.1's survey set it aside — but that objection was about
*package vintage*, and a bundle we build ourselves answers it.

### Superseded by ADR-011

The delivery half of this section is now its own decision. **ADR-011** takes
Tectonic's indexed-archive model — verified against the live bundle, where a
1.28 MB index and one HTTP range request per file replace whole-bundle
downloads — and measures what our own documents would cost under it:
`presentation-beamer` reads 2.1 MB of TeX files and currently downloads
118.9 MB to get them.

It is explicitly *not* a decision to use Tectonic's engine, which has no
WebAssembly build. The engine question stays here.

### What this adds up to

The floor is not fixed at 41 MB. Applying only what is measured here — brotli,
plus per-file rather than per-bundle fetching — the download for a simple
document is the engine plus the few hundred kilobytes of TeX files it opens,
which is single-digit megabytes. The 135 MB ceiling is almost entirely bundles
fetched whole for a handful of files inside them.

None of these options requires a server to compile anything. The one that does
require a server — SwiftLaTeX's kpathsea resolver — has a static equivalent we
can generate.

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
- [x] Investigate `paper-acm`: 22 full XeTeX passes, one missing package
      discovered per pass. Time tracks pass count across the whole corpus.
- [x] Resolve a document's package closure before compiling instead of one full
      pass at a time. Tried and rejected: a static closure over-approximates,
      and a class that probes with `\IfFileExists` is harmed by being given a
      package speculatively. See above.
- [ ] Find a way to shorten the chain that does not change which branch a class
      takes. Nothing obvious remains at the adapter level.
- [ ] Its 3-versus-2 page discrepancy, which is separate and still open.
- [ ] Chase the two-column drift in `paper-ieee` and `paper-acm`, which starts
      as one hyphenation decision on page 1 and compounds.
- [x] Decide how to handle version skew between bundled TeX Live packages and
      pinned-archive fetches, which is what breaks `letter-formal`: rebuild the
      bundle set from the single tree we pin.
- [ ] Carry that decision out, and measure what it costs to host.
- [x] Cold and warm compile time, peak memory, cancellation behaviour.
- [x] **Bring peak memory down from ~1 GB.** It was a retention leak, ~418 MB
      per compile. Recycling the engine after each compile caps it at 34–49 MB,
      at the cost of doubling warm compiles.
- [ ] Get the warm cost back by having the engine release instances instead of
      the adapter terminating workers. Needs an upstream change to Siglum.
- [x] Why recovery after an abort is not reliably clean. The recycle answers it:
      recovery now runs against a fresh engine rather than one whose TeX run was
      terminated under it.
- [ ] Multi-pass bibliography orchestration across `natbib`, `cite` and
      `acmart`. No corpus project has reached its bibliography yet.
- [x] First-load and offline story. 41 MB floor, 135 MB ceiling, engine init
      ~500 ms — the cost is transfer, not startup.
- [ ] Serve with brotli and confirm the measured 4.4 MB saving on a real host.
- [ ] Establish whether Tectonic can be built for the browser. It is the engine
      desktop already uses, and its `.ttb` bundle is the per-file, statically
      hosted delivery model this whole section is arguing for. If it can, it
      answers first load, package vintage and fidelity at once.
- [ ] Failing that, build a XeTeX-only engine and a fine-grained bundle set,
      since the engine always fetches a whole bundle.
- [ ] Whether the same defects appear in `wasmtex` and `texlyre-busytex`, which
      wrap the same BusyTeX build. Defects 7 and 8 are properties of the BusyTeX
      format build and fetcher, so they probably travel.

## Consequences so far

`LatexCompiler` in `src/core/compiler/types.ts` remains the only compiler
surface any other code may depend on, and it has now earned that: ten of the
eleven engine defects are absorbed by the adapter without anything above it
knowing. Had the spike called Siglum directly, those workarounds would be spread
through the product.

The eighth — the CTAN fetcher discarding OpenType fonts — is the one defect the
port cannot hide, and it is instructive: the adapter can compensate for what an
engine *does*, but not for what it will not carry. That is the same conclusion
the version-skew decision reaches from the other side, and together they point
at owning the package tree rather than consuming someone else's.

The eleventh is absorbed but not *fixed*, and the distinction matters. The
adapter can stop the memory leak only by terminating the worker, which also
discards work the engine had legitimately cached — so the workaround costs
double the warm compile time. A port lets an adapter hide a defect; it does not
make the defect free.

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
