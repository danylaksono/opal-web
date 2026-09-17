# Opal Web: architecture investigation and initial plan

Status: Phase 3 begun — editor and file list on top of a working compile loop  
Prepared: 2026-07-23  
Last updated: 2026-09-12  
Target product: `opal-web`, a separate repository and independently deployable product

> **Read this first.** Sections 1–19 below are the original investigation,
> written on 2026-07-23 against desktop v1.4.8. They are kept as written: the
> architecture has held up, and rewriting them would erase the reasoning that
> produced it. Where measurement has since contradicted or answered them, the
> status section immediately below says so and section 17 is annotated inline.

> The same applies to the progress sections: the newest one is first, and the
> ones under it are kept unedited. They are not decoration — the engine decision
> recorded below was made *from* the measurements in the 2026-09-03 section, and
> a reader who deletes them is left with a conclusion and no evidence.

## Progress as of 2026-09-12

Repository: <https://github.com/danylaksono/opal-web>, AGPL-3.0-or-later.

**Phase 1 is complete, Phase 2's loop is built, and Phase 3 has started.** A
user creates a project, writes LaTeX in a real editor across as many files as
they like, presses Compile, and reads a rasterised page — all of it on the
device, with the engine on a worker and the renderer on another. The two numbers that
made Phase 2 wait have both moved by an order of magnitude, and neither was
moved by optimising: both were structural.

### What changed since 2026-09-03

**The engine is now `texlyre-busytex` 1.4.0, fed by an endpoint we serve.** It
is the same BusyTeX TeX Live build Siglum wraps — ADR-003's finding that the
candidate set collapses onto one engine still holds — but built from a *single*
vintage, TeX Live 2026, and read one file at a time out of an index over that
tree rather than by downloading bundles whole.

That one change closed both failures ADR-003 had recorded as structural. Neither
was an engine defect: `cv-modern` wanted an OpenType font Siglum's CTAN fetcher
discarded, and `letter-formal` wanted a package set that agreed with itself. A
tree carrying its own closure has nothing to discard and nothing to disagree
with.

| | 2026-09-03 (Siglum + CTAN proxy) | now (texlyre + endpoint) |
|---|---:|---:|
| Corpus compiling | 11/13, needing the proxy | **12/14, no network** |
| Page counts matching desktop | 10 of 11 | **11 of 11** |
| First compile | 41–135 MB | **21.8–23.4 MB** |
| Spread across documents | 94 MB | **1.6 MB** |
| Warm compile | 0.8–12.2 s, or 41–87 s with the memory recycle | **1.2–4.8 s** |
| Peak memory | 907–1231 MB, or 34–49 MB with the recycle | **440–445 MB, no recycle** |
| Cancellation | 0–16 ms | **1 ms** |

The corpus itself grew: `article-no-fontenc` is the fourteenth project, added
because twelve of the thirteen original documents load `fontenc` and therefore
never take the default font path — which is the path the first document a *user*
creates does take, and which was broken.

Warm compiles are measured on `blank`, `book-standard` and `thesis-standard`
(1152 ms, 2921 ms, 4282 ms), not the whole corpus; engine init is ~0.9 s. An
earlier run of the same three was 893/2131/3235 ms, which is the run-to-run
spread on one machine and worth remembering before reading 10% into anything.

**Memory is the finding, and this time it is the absence of one.** Siglum
retained ~418 MB per compile — two compiles reached 907 MB, and the fix was to
recycle the engine after each one, which doubled warm compiles corpus-wide.
`texlyre-busytex` peaks at **439.9 MB for `blank` and 444.9 MB for
`thesis-standard`**, sampled after three compiles of each and holding 109 MB
after init: a 16-page document and a 1-page document cost the same, and three
compiles cost what one does. At Siglum's retention rate those three would have
been about 1.3 GB. So the recycle is not needed here, which is *why* the warm
compile is seconds rather than a minute — the two figures are the same decision,
not two wins.

**A session does grow, slightly, and it is the engine's.** Three compiles cannot
tell a flat engine from one that creeps, so `spike:perf --soak` keeps compiling
on the same engine and samples after each. Over twelve, `blank` goes 440.0 →
440.6 MB and `thesis-standard` 445.8 → 450.7 MB — monotonic, reproducible across
three runs, and **~0.45 MB per compile of a 16-page document** against 0.05 MB
for a 1-page one. It scales with the document, so it is output being retained
rather than a fixed leak.

The realm breakdown says whose it is: across a soak the *Window* stays at
4.1–4.4 MB while the worker goes 440.8 → 444.2 MB. Nothing above the port is
holding onto PDFs; the growth is entirely inside the engine's own realm. At that
rate an afternoon of 200 compiles on a thesis adds ~100 MB to a 445 MB baseline,
which is survivable — and if it ever stops being survivable the mitigation is
already known, because it is Siglum's recycle at a frequency of every few
hundred compiles rather than every one, at 0.9 s each.

### How the engine is fed

- A **41.24 MB boot package of 183 files** — the format file, ICU's data, the
  kernel, Latin Modern, an `ls-R` — mounted before TeX starts.
- Everything else on demand from `/texlive/<format>/<name>`, resolved through an
  index of the tree. One document's traffic is 3 requests, not 20, because the
  `ls-R` means kpathsea stops guessing.
- **22.66 MB of every first compile is fixed** and shared by every document:
  8.2 MB engine, 9.9 MB boot set, 3.6 MB renderer and app, all brotli. Only
  0.2–1.8 MB varies with what the document uses. The delivery problem is
  therefore solved and the remaining cost is an engine *build* question —
  ADR-011 hands it back to ADR-003.

### What the product does today

- **Storage core (Phase 1):** projects on the device, bytes in OPFS and metadata
  in IndexedDB, conditional writes, transactional autosave, ZIP import/export,
  an error boundary, design tokens.
- **The loop (Phase 2):** `compile-session.ts` owns sequencing — a revision
  guard so a stale compile never replaces newer output, cancellation that
  returns control, and an engine rebuilt when a compile throws.
  `Workspace.tsx` owns the pixels: engine stages and a download percentage while
  it works, the log when it fails, page navigation, zoom that re-renders rather
  than stretches, and a reading position that survives a recompile.
- **The editing surface (Phase 3, begun):** CodeMirror 6 with line numbers,
  undo and LaTeX highlighting, one instance per document so undo cannot follow
  a user between files; and a flat file list with add, switch and delete, which
  is what finally makes the compile path's multi-file support reachable — a
  project can `\input` a chapter and it compiles. Flat rather than a tree
  because no project in this repository has a directory in it.
- **Diagnostics where the writing is:** the engine's, and the index's, in the
  same gutter. Building it found that every diagnostic in a project's main file
  had been attributed to a file that does not exist — TeX prints `(./main.tex`
  and then continues on the same line with no space, so the parser read
  `main.texLaTeX2e`. It had been wrong since the parser was written, because
  printing a wrong filename looks fine and the gutter was the first thing that
  had to use one.
- **Rename on the port** (`renameFile`), one revision rather than a write and a
  delete, refusing to overwrite and carrying the project's root file with it.
  Four contract cases run it against both the in-memory repository and real
  OPFS.
- **A semantic index**, recomputed on every keystroke in about a millisecond:
  labels, references, citations, `\bibitem` keys, inputs, graphics, packages
  and sections, scanned character by character rather than by regular
  expression. It carries an outline that follows `\input` in reading order, a
  project-health list that answers "does this `\ref` resolve anywhere" without
  compiling, and completion for labels and citation keys. It reports **zero
  problems across all fourteen corpus projects**, which is a test: they compile,
  so anything it reports is its own defect.
- **Asset views and an accessibility gate.** Images and PDFs open as
  themselves — the PDF through `PdfRenderer`, not a browser plugin — which
  closed a data-loss path nobody had seen: opening a figure decoded it as UTF-8
  and the next keystroke would autosave the damage. axe runs over the product's
  surfaces in the e2e suite at serious-and-critical, alongside keyboard paths it
  cannot see: status regions that speak, focus that lands somewhere after the
  button you pressed disappears, and Ctrl/Cmd+Enter to compile without leaving
  the document.
- **Five templates**, each gated twice: the semantic index runs over every one
  in the unit suite, and an e2e creates and compiles all five, because a
  template is the first LaTeX a user sees and the first they copy. The `paper`
  template is also the first document in this repository to reach a
  bibliography — no corpus project ever did — so it is where the bibtex path
  finally got tested.
- **A table editor**, the first structured editor. With the cursor in a
  `tabular`, `tabularx`, `tabular*` or `array`, the source opens as a grid:
  edit cells, add and remove rows and columns, and Apply writes it back as one
  undoable change with the `&`s aligned. Rules (`\hline`, booktabs) and
  `\multicolumn` spans are kept. It refuses what it cannot write back without
  losing something, such as a comment inside the table, and says why. Apply is
  conditional: if the table's source changed while the grid was open, the write
  is refused, not made at the old offsets. Every table in the corpus is read and
  written back cell for cell in the unit suite.
- **A citation editor.** With the cursor in any of the fourteen citation
  commands the index counts, the keys open as a list with a search over the
  bibliography: author, a title word, a year or part of a key, accents folded,
  so "godel" finds `G{\"o}del`. It reads `.bib` fields and hand-written
  `\bibitem` text alike, offers only the commands the loaded packages define,
  and keeps prenotes and postnotes, writing `[see][]` when natbib needs the
  empty one. A key the project's bibliography lacks is kept and labelled, not
  dropped. Apply is conditional in the same way as the table's. In the unit
  suite it has to agree with the index on every corpus project's keys, and
  every corpus citation has to come back from it unchanged.
- **Two editor defects the pickers found.** A cap on the editor's height sat on
  the box around CodeMirror, making a second scroll region that axe reports as
  unreachable by keyboard; nothing had tested a document taller than the box.
  And a structured edit focused the editor after changing it, which let the
  browser reset the cursor to the start of the file.
- **The page opens on the product.** It had opened as the Phase 0 harness
  for two phases after it stopped being one: capability table, corpus table
  and three measurement panels first, the workspace below them, under a lede
  that still read "no editor, no storage and no compiler". The instruments are
  not deleted — the ADR-003 and ADR-011 measurements are reproduced by driving
  them — but they are in a closed section under the workspace, which
  `?harness=1` opens for the spike scripts.
- **The product is the desktop editor, adapted.** Until now the app was the
  Phase 0 harness with a project panel added to it: a page of measurement
  tables that a person scrolled past to reach their work. Opal Web is an
  adaptation of the Opal desktop editor, so the shell is now desktop's —
  activity rail, side panel (files, outline, health), editor pane, PDF preview
  pane, status bar, draggable splits — built on desktop's own theme and
  shadcn/Radix primitives, copied across under MIT (see the licence
  inventory). What differs is what the browser makes different: storage is
  OPFS rather than a directory, and there is no window chrome. The
  instruments did not go: they are at `?harness=1`, which is how
  `spike:corpus-run`, `spike:perf` and `spike:firstload` still drive them.
- **A defect the shell found.** The workspace re-opened its project on every
  render of its parent, because a callback prop was rebuilt each time and an
  effect depended on it. That reset the open file and replaced the autosave
  before its debounce could fire — so an edit was never saved. It is a
  stale-identity bug rather than a stale-closure one, and the e2e suite caught
  it as "No unsaved changes" where a save was expected.
- 309 unit tests and 60 Playwright e2e tests. The e2e suite is the part that
  matters here: four defects found during Phase 2 — the default font path, a
  boot package with no `ls-R`, a stale pre-compressed asset, and cancellation
  returning after 180 s — would each have passed every test that existed before
  it, because those stopped at the ports or drove the corpus, and the corpus is
  not a product.

### What is open

- **`paper-acm` and `paper-ieee`.** `acmart` and `IEEEtran` are in `texmfrepo`,
  which indexes the full archive rather than the tiers, so they need a second
  source. Not structural, and not reachable from this container's egress policy.
- **Where the engine's 0.45 MB a compile goes.** Measured and attributed to the
  worker realm (above), not diagnosed. It is small enough to leave, and it is
  the kind of thing that is small until a document is large.
- **Nothing has run outside desktop Chromium.** Firefox, Safari, and a
  constrained-memory device are all untested, and Safari's WASM limits are the
  ones most likely to bite.
- **The engine and ICU are the floor.** 22.66 MB fixed, and ICU's 22 MB is
  irreducible with this build — without it the corpus scores 0/13.
- **Deployment.** The Netlify spike, the header fix and brotli have been
  measured on loopback, not on a host; and AGPL section 13's source offer has to
  exist before anything is public.

### Next, in order

1. Run the corpus and the e2e suite on Firefox and Safari. Nothing has run
   outside desktop Chromium, and Safari's WASM limits are the ones most likely
   to bite a 32 MB engine. **Needs a different machine**: the container this was
   built in cannot reach the Playwright browser CDN, so Chromium is the only
   engine installable on it.
2. What Phase 3 still owes: the math and figure structured editors (tables
   and citations are in), and an accessibility check a
   machine cannot do — axe and the keyboard tests say the mechanics are right,
   but nobody has driven this with a screen reader, and that is a different kind
   of evidence.
3. `paper-acm` and `paper-ieee` from `texmfrepo`, on a machine that can reach a
   TeX Live mirror.
4. Deploy, and confirm brotli and the first-load figure on a real host.
5. Commit desktop Tectonic's logs beside the reference PDFs, so diagnostics can
   be compared as well as output.
6. The AGPL section 13 source offer, before any public deployment.

## Progress as of 2026-09-03 (superseded, kept as the evidence)

> Written against `@siglum/engine`, before the engine change above. Every
> measurement in it stands; what changed is which engine the product uses, and
> this section is why it changed.


Repository: <https://github.com/danylaksono/opal-web>, AGPL-3.0-or-later.

### Decisions closed

| ADR | Decision | Basis |
|---|---|---|
| 001 | Client-only boundary; two classes of network call, integrations opt-in | Accepted as written |
| 002 | **AGPL-3.0-or-later** | Follows from keeping MuPDF; `LICENSE` committed |
| 004 | **MuPDF.js** as the PDF renderer | Measured; PDF.js not benchmarked, since the comparison only mattered if licence were a constraint |

### Built and verified

- Standalone repository, strict TypeScript, Biome, Vitest, Playwright, CI.
- **The ports first**: `LatexCompiler`, `PdfRenderer`, branded `ProjectId` /
  `ProjectPath` with archive-hostile path validation. Nothing above them touches
  a browser API or an engine type. This has already paid for itself — ten of
  the eleven engine defects found so far are absorbed entirely inside adapters.
- **MuPDF running in a plain browser worker**, not a Tauri webview:
  `paper-standard` opens in 94.5 ms and rasterises 612×792 in 31.7 ms, with
  per-line baselines distinct from bounding-box bottoms, so review anchoring
  keeps desktop's precision. WASM is 10.4 MB (4.8 MB gzipped).
- **Siglum compiling LaTeX in the browser**: `blank` in 747 ms,
  `book-standard` in 1740 ms to 8 pages, each verified by opening the PDF
  through the renderer port. SyncTeX is emitted.
- Compiler acceptance corpus: all 13 desktop examples pinned with desktop
  Tectonic's reference output, plus a generated manifest — 6 document classes,
  32 packages, 4 needing bibliography passes.
- 82 unit tests, 4 browser e2e tests, and four spike scripts
  (`spike:coverage`, `spike:siglum`, `spike:corpus-run`, `spike:perf`). The
  corpus runner takes `--only a,b` and writes each project's full engine log to
  `spike-results/logs/`, which is how the four failures above were read; every
  project that compiles is then compared against desktop's reference PDF on
  words, ink and pixels.

### Where the corpus stands

**11 of 13 corpus projects compile, and 10 of those 11 match desktop Tectonic's
page count**, using a self-hosted CTAN proxy pinned to TeX Live 2025's frozen
`tlnet-final` archive. Without that proxy the score is 2 of 13.

`paper-acm` compiles — the ACM template the bundle analysis had flagged as
blocked — though in 57 s against 1–8 s for most of the rest, and at 3 pages
against desktop's 2.

The four failures that remained after the proxy landed have now been diagnosed
from their full engine logs, and the earlier reading of them was wrong: two were
font-asset gaps, one is version skew, and one had nothing to do with packages.

- **`paper-ieee`** wanted a Times TFM. The bundles ship 1,425 font metrics and
  every one is Computer Modern, Latin Modern, EC or AMS — the URW base-35 set is
  absent entirely, so Times, Helvetica and Courier resolve their `.fd` files and
  then find no metrics. **Fixed**: the adapter now reads font errors and fetches
  the owning TeX Live package by NFSS family. 3 pages, matching desktop.
- **`presentation-beamer`** was not a package problem at all. Siglum's
  precompiled formats are built without babel's `hyphen.cfg`, so `\languagename`
  does not exist, and `translator` expands it at `\begin{document}`. **Fixed**
  with a one-line `\providecommand` shim prepended without a newline, so line
  numbers, SyncTeX and diagnostics stay exact. 5 pages, matching desktop.
- **`cv-modern`** needs an OpenType font that Siglum's CTAN fetcher discards:
  it keeps only `.pfb`, `.pfm`, `.afm`, `.tfm`, `.vf`, `.map` and `.enc` from a
  fetched package. The pinned archive ships the font; nothing can deliver it.
  **Blocked upstream** — the first defect the port cannot hide.
- **`letter-formal`** is the version skew, and it is worse than "our pin versus
  TeX Live": the bundle set is not one vintage. `geometry` is 2020, `graphicx`
  2021, `xcolor` 2022, `hyperref` 2023 — against a LaTeX kernel of 2024 or later
  and a `beamer`, `microtype` and `etoolbox` from 2025. No pinned archive can
  agree with all of it. **Blocked.**

**Decision on version skew: build the bundle set ourselves, from the single
TeX Live tree we already pin.** It is the only option that makes
`packageSetVersion` mean anything — today a compile can name
`texlive-2025/siglum-bundles-v0.1.0` while running a 2020 `geometry` against a
2024 kernel — and it subsumes both font defects, because a tree we assemble
carries the metrics and faces we choose. See ADR-003 for the rejected
alternatives; this is now the largest item between this engine and a product.

### How close the output is to desktop's

**30 of 60 pages reproduce desktop Tectonic's text word for word**, with both
sides opened through the same renderer. Text is compared as a word sequence per
page — line breaking is the engine's own business — alongside ink coverage and
a differing-pixel ratio. Bytes are never compared.

The comparison paid for itself on its first run by finding two defects that
produce *plausible* output, which is the kind page count cannot catch:

- **Siglum predicts its rerun budget from the source** rather than reading TeX's
  request from the log. `poster-academic` and `newsletter` open with a TikZ
  `remember picture` full-bleed banner, use no `\ref` or `\cite`, and were
  therefore given one pass — so the banner never drew, and both carried a
  quarter of the reference's ink while matching it on words. Fixed by rerunning
  while TeX asks, bounded at four passes.
- **Siglum's PDF cache is keyed on the source alone**, so the first rerun handed
  back the pass it was meant to replace. Any engine that reruns has two correct
  outputs for one source; the key cannot be right. Fixed by bypassing the cache
  on reruns.

Together those took the poster's ink delta from 0.1380 to 0.0000 and its pixel
difference from 0.1584 to 0.0192.

The comparison also widened defect 7. The format built without babel's
`hyphen.cfg` leaves `\lefthyphenmin` and `\righthyphenmin` at zero, so the
engine breaks words after one letter — `p-resentations`, `S-tandards` — across
four documents. Setting the two primitives is measurably identical to loading
babel and is now in the shim. Honestly: it barely moves the score, because the
metric measures agreement with desktop rather than correctness, and a break in
an invalid place scores the same as a break in a different valid one. It stays
because the output it removes is wrong regardless of what desktop did.

What is left of the gap is mostly not the engine: four documents' worst page
differs only in a month name, because the reference PDFs were built in February
and the runs comparing them in September. The real remainder is hyphenation
points, and a two-column drift in `paper-ieee` and `paper-acm` that starts as
one hyphenation decision on page 1 and compounds.

Diagnostics cannot be compared yet: the corpus commits desktop's reference PDFs
but not its logs.

### What a compile costs

Measured with `pnpm spike:perf` in real Chrome against a cross-origin-isolated
preview. Both are required: peak memory needs `measureUserAgentSpecificMemory`,
the only API that sees the WASM heap, and Playwright's bundled Chromium has it
present but disabled.

Figures below are with the engine recycle **off**, which is what the leak looked
like before it was fixed; the shipped numbers follow.

| | fastest | slowest |
|---|---|---|
| Engine init | 479 ms | 699 ms |
| Cold compile | 1.4 s (`blank`) | 57.5 s (`paper-acm`) |
| Warm compile, after an edit | 0.8 s | 12.2 s (`presentation-beamer`) |
| Peak memory | 907 MB (`blank`) | 1231 MB (`cv-modern`) |

With the recycle on, as shipped: cold is unchanged (170 s to 173 s across the
corpus), warm doubles (41 s to 87 s), and peak memory drops to 34–49 MB.

**Memory was the finding, and it was a leak.** After init the page holds
**40 MB**; one compile took it to 490 MB and two to 907 MB — about **418 MB per
compile, retained**. `measureUserAgentSpecificMemory` forces a collection before
reporting, so those were not uncollected temporaries. Siglum's
`getOrCreateModule` does not cache despite its name: every TeX pass instantiates
a fresh WASM module and the previous one stays reachable. It never surfaced
before because nothing was measuring it, and nothing could — without
cross-origin isolation the only available API counts the JS heap, which here is
under 3 MB.

**Fixed by recycling the engine after each compile**, started after the result
is returned and never awaited. Peak across the corpus drops from **907–1231 MB
to 34–49 MB**, and it also settles the flaky post-abort recovery, which now runs
against a fresh engine by construction.

It is a poor trade, taken deliberately. A recycled engine has discarded its
mounted bundles, so warm compiles roughly double corpus-wide — 41 s to 87 s —
and the worst case goes from 12.2 s to 30 s. No policy avoids this: delaying the
recycle does not help, since the next compile still meets a fresh engine, and
recycling every *n*th compile scales the peak by *n*. With this engine, bounded
memory and a fast edit cycle are mutually exclusive. Slow is bad; unbounded is
fatal, and three compiles was already a gigabyte.

The proper fix is upstream, and it is not the instance-per-pass — Siglum creates
a fresh instance on purpose, because TeX's C globals do not survive reuse. The
defect is only that the previous instance stays reachable. Released properly,
memory would be flat with no recycle and no warm penalty.

**`paper-acm`'s 57 seconds is one missing file per full recompile.** TeX stops
at the first file it cannot find, so each pass discovers exactly one package and
both retry loops recompile from scratch to find the next — 22 full XeTeX passes
for that document, chaining `xkeyval` through `balance`. Compile time tracks
pass count across the whole corpus. Every one of those packages is named in a
`\RequirePackage` line inside a file already on disk when it is needed;
resolving that closure before compiling is what would collapse it.

**Warm compiles save 42–92%**, so most of the above is first-open cost, not the
edit cycle. What a user feels while writing is the warm figure, and its worst
case — 12.2 s — is still too slow.

**Resolving the package closure ahead of time was tried and rejected.** Every
package in `paper-acm`'s 22-pass chain is named in a `\RequirePackage` line
inside a file already on disk when it is wanted, so reading those lines should
turn a chain of compiles into a chain of fetches. Measured, it made things
worse: 129 packages fetched instead of 19, 128 s instead of 57, and the compile
stopped succeeding. `acmart.cls` probes with
`\IfFileExists{libertine.sty}` and falls back gracefully when it is absent —
so fetching it speculatively made the file exist and sent the class down a font
branch that pulls `fontspec` and then the OpenType fonts defect 8 discards.
Making a package available changes what a document does, so a static closure is
not a performance trade but a behaviour change. Deciding correctly would mean
knowing which conditional branch TeX takes, which means running TeX.

**Cancellation now works and had to be built.** The port has always declared
`signal`; the adapter checked it once and never again. Siglum exposes no cancel
and a WASM TeX run holds its worker's only thread, so the adapter races each
pass against the signal and terminates the worker. Abort latency is **0–16 ms**
on all 13 projects, and the next compile succeeds.

**The compile cache helps least when it is most needed.** Recompiling an
unchanged document costs 0 ms — but only when it succeeded. `letter-formal` and
`cv-modern`, the two that fail, pay 4.1 s and 3.3 s every time, which is exactly
the situation where a user recompiles most.

### First load, and what could shrink it

A cold first compile transfers **41 MB for the simplest document and 135 MB for
beamer**, in production terms. The engine is a constant 29.4 MB (7 MB brotli);
everything above that is TeX packages. `cm-super` alone is 57.2 MB, pulled by
nine of thirteen projects.

Researched routes, none needing server-side compilation:

- **Brotli**: `busytex.wasm` 11 MB gzip → 7 MB brotli, MuPDF 4.7 → 3.6 MB.
  4.4 MB for a build setting, once the content-type fix lands.
- **The engine ships four engines.** `busytex.wasm` is a BusyBox-style
  multi-call binary holding pdfTeX, XeTeX, LuaTeX, BibTeX and dvipdfmx; we use
  xelatex. LuaTeX is the largest of them.
- **Bundles are fetched whole.** Siglum mounts deferred bundles as file markers
  and has a working HTTP range-request path — but takes it only for bundles
  already in memory, so any deferred bundle is downloaded entire the first time
  one file in it is wanted. No threshold; the machinery is wired backwards, and
  it is worker-internal so the adapter cannot reach it. Bundle *granularity* is
  therefore the unit of waste, which makes owning the package tree a first-load
  decision as well as a correctness one.
- **The model already exists in Tectonic**, the engine desktop compiles with,
  and it is now **ADR-011**. Verified against the live bundle: a 1.28 MB index
  over a 2.88 GB static archive, HTTP range requests working, every file our
  corpus needs present. Cross-referencing what TeX actually opens,
  `presentation-beamer` reads **2.1 MB** of macro files and downloads 118.9 MB
  to get them; `blank` reads 0.07 MB and downloads 25.6 MB. A first load under
  that model is roughly 17–21 MB against today's 41–135 MB, and the variance
  collapses.

  Note what this is *not*: no WebAssembly build of Tectonic exists, and its C
  dependencies are described upstream as surmountable rather than solved. ADR-011
  takes the delivery model — a file format and an index — and leaves the engine
  to ADR-003. The two were entangled only because one project ships both.

  Since measured end to end. The delivery works and the round trips are cheap;
  what does not work is bolting it beside the engine's own loading. Siglum
  fetches 77.1 MB of font bundles during init, before TeX runs and regardless of
  the document, which is both why no font is ever reported missing and why the
  17–21 MB figure is unreachable until the engine reads from the archive
  directly rather than being handed files after it has already asked.
- **SwiftLaTeX** does the same from the browser side and has an existence proof
  in TeXbrain (MIT, static hosting, no server). Its resolver is a Flask app,
  but it resolves names rather than compiling, and that resolution can be
  precomputed into a static index — we already have the shape of one in
  `file-manifest.json`.

Applying only what is measured, a simple document's first load is the engine
plus the few hundred kilobytes of TeX files it opens: single-digit megabytes.

### What changed in the plan's assumptions

- **Section 7.1's candidate set is superseded.** SwiftLaTeX is not published on
  npm, and every maintained browser TeX distribution — `texlyre-busytex`,
  `wasmtex`, `@siglum/engine` — wraps the same BusyTeX TeX Live build. The
  choice is package delivery and API shape, not engine fidelity.
- **Section 9 under-weights review.** Desktop's review subsystem grew
  substantially on `features-1.5` (drawing, gutter, re-anchoring, reporting,
  tags, search). Its dependence on structured-text geometry made renderer text
  fidelity a Phase 0 deciding measurement rather than a Phase 4 concern.
- **Section 3.1's audit counts are stale**: 227 → 293 TypeScript/TSX files, and
  44 → 65 files importing Tauri APIs directly.
- **Engine defects are the real integration cost, not compile fidelity.**
  Eight were hit by ordinary corpus documents: a xelatex baseline that cannot
  render T1 encoding, document classes missing from the package index,
  incomplete bundle dependency lists, an always-empty result log, font failures
  invisible to both resolution paths, a file index holding no font names, a
  format built without babel, a CTAN fetcher that discards OpenType, a rerun
  budget predicted from the source instead of read from the log, a PDF cache
  keyed on source alone, and a WASM instance retained per compile. Ten are
  absorbed by the adapter; the OpenType one cannot be. See ADR-003.
- **A port hides what an engine does, not what it will not carry.** That is the
  line the eighth defect crosses, and it is the same conclusion the version-skew
  decision reaches from the other side: the package tree has to be ours.
- **Static hosting is fussier than section 11.1 suggests.** Pre-compressed
  engine bundles must be served with no `Content-Encoding`, or the browser
  decompresses payloads the engine intends to decompress itself — presenting as
  a fetch failure while every request returns 200.

### Next, in order (as of 2026-09-03 — superseded)

> Items 1–3 are answered: the delivery model is built, the engine is loaded
> from a single tree through our own endpoint, and the warm-compile cost came
> back by changing engines rather than by the upstream fix item 2 wanted. The
> current list is in the 2026-09-12 section above.

1. ~~Prove ADR-011's delivery model end to end.~~ **Done, with a limit.** Round
   trips are affordable: beamer's 142 files take 575 ms on a 150 ms link over
   HTTP/2, provided the client declines the HTTP cache — Chrome locks the cache
   entry per URL and every file is a range of one URL, which costs 38× — and the
   host speaks HTTP/2, worth another 7×. The engine does take files one at a
   time through `ctanFiles`, and on beamer that replaced five bundles, 33.7 MB,
   with 2.8 MB of range requests. But the adapter's hook is a fallback behind
   Siglum's own resolution, which fetches **77.1 MB of font bundles at init**
   whatever the document uses, so with CTAN on the archive saves nothing. The
   win needs the engine's bundle path replaced, which is item 3.
2. Get the warm-compile cost back by having the engine release WASM instances
   instead of the adapter terminating workers. Needs an upstream change, and it
   is the main lever left on compile time: resolving the package closure ahead
   of time was tried and rejected (above), so `paper-acm`'s 23 s warm compile
   stands until the recycle is unnecessary.
3. Build that archive from the single pinned TeX Live tree, per the skew
   decision above, and load the engine *from* it rather than from bundles. This
   is now the item everything else waits on: it unblocks `cv-modern` and
   `letter-formal`, removes the discovery chain (a tree carrying the whole
   closure has nothing to discover), and is the only route to the first-load
   figure, since the 77.1 MB of eager font bundles are unreachable from the
   adapter. It also removes the one place file-at-a-time resolution is awkward —
   TeX names one missing file per run, so an engine that asked the archive per
   file as it opened it would need no retry loop at all.
4. Exercise bibliography reruns across `natbib`, `cite` and `acmart`. No corpus
   project has reached its bibliography yet.
5. Close the remaining ADR-004 criteria: Firefox and Safari, link resolution,
   scroll and zoom stability across recompiles, crash recovery. Nothing has been
   run outside desktop Chromium, and Safari's WASM limits are untested.
6. Commit desktop Tectonic's logs alongside the reference PDFs, so diagnostics
   can be compared as well as output.
7. Deploy the Netlify spike and confirm the header fix, brotli, and the measured
   first load on a real host rather than a loopback.
8. Build the AGPL section 13 source offer before any public deployment.

Phase 1 does not start until 1 and 2 are answered, and ADR-003 and ADR-011
are closed. 1 is answered; 3 is what closes ADR-011.

The gate is about cost, not about interfaces. `LatexCompiler` and `PdfRenderer`
already insulate a UI from both open decisions, so nothing above the ports would
have to change if the engine or the delivery model did. What would not survive
is the product: a 23 s warm compile and a 41–135 MB first load make an editor
feel broken, and neither is a problem a UI can be built around.


## 1. Executive recommendation

Build Opal Web as a separate, static, local-first Progressive Web App rather
than trying to make the Tauri application run conditionally in a browser.

The existing React user experience is a strong reference implementation, and
large areas of TypeScript can be ported, but the browser product should have
its own platform boundary from its first commit. In particular:

- project files should be canonical in browser-managed storage;
- compilation and PDF processing should run in dedicated Web Workers;
- local folder access should be an optional import/synchronisation adapter;
- every project must remain portable through ZIP import/export;
- no document content should be sent to an Opal server;
- network features such as AI, Zotero, metadata lookup, and grammar checking
  must be optional and visibly separate from local document processing;
- Opal Web should be independently versioned, tested, licensed, and deployed.

A static host such as Netlify is sufficient. It serves the application shell,
WebAssembly modules, TeX resources, templates, and service worker; compilation
and document processing remain on the user's device.

Two investigations are release-blocking and must precede product work:

1. Select and license a browser LaTeX engine that compiles Opal's real template
   corpus with acceptable fidelity and performance.
2. Select and license the PDF renderer. The desktop currently uses MuPDF.js,
   which is offered under AGPL or a commercial licence. PDF.js is an
   Apache-2.0 alternative, but its behaviour must be tested against Opal's
   selection, link, annotation-overlay, and large-document requirements.

## 2. Product definition

### 2.1 Product promise

Opal Web is a private, installable LaTeX workspace that opens in a browser,
works without an application server, compiles locally, and keeps projects on
the user's device unless the user explicitly invokes an external integration.

The privacy claim must be precise:

> Editing, storage, compilation, preview, history, and import/export happen on
> this device. Optional connected services receive only the data the user
> chooses to send to them.

“Client-side” does not mean “no network traffic.” First use may fetch the app,
WASM engine, TeX packages, templates, or updates from the static host. Optional
AI and reference services also require network access. The application should
make these boundaries inspectable and testable.

### 2.2 Initial target users

- People who want an Overleaf-like workspace without uploading manuscripts to
  an Opal compilation server.
- Desktop Opal users who need a lightweight browser or Chromebook companion.
- Researchers working on managed machines where installing a native toolchain
  is difficult.
- Users who value portable ZIP projects and an offline-capable PWA.

### 2.3 MVP scope

The first useful public version should support:

- create a project from a blank project or bundled template;
- import a project from ZIP or a selected directory;
- edit multi-file `.tex`, `.bib`, style, text, image, and PDF assets;
- autosave into browser-managed storage;
- compile with a browser WASM LaTeX engine in a worker;
- display the generated PDF with text selection, links, zoom, and navigation;
- show actionable compiler logs and source locations where available;
- export source files and generated PDF as a ZIP;
- recover recent projects after closing or updating the app;
- function offline after required runtime resources have been cached;
- clearly report storage, offline, compiler, and browser capability status.

### 2.4 Explicit non-goals for MVP

- Server-side compilation or document storage.
- Accounts, cloud sync, or real-time collaboration.
- Native TeX Live selection.
- Running arbitrary Python, shell commands, external editors, or Git binaries.
- Full feature parity with desktop on the first release.
- Invisible write-through synchronisation with an arbitrary local directory.
- A promise that every TeX Live package or shell-escape workflow works.

## 3. Current desktop architecture audit

### 3.1 Repository shape

The current repository is a pnpm workspace with a single product under
`apps/desktop`:

- React 19 + TypeScript + Vite frontend;
- Tauri 2 host and IPC boundary;
- Rust backend with native Tectonic, Git, filesystem, network, and process
  integrations;
- Zustand client state;
- CodeMirror 6 editing;
- MuPDF.js/WASM preview rendering;
- Vitest unit tests and a small Playwright E2E suite.

Relevant source references:

- [`apps/desktop/package.json`](../apps/desktop/package.json)
- [`apps/desktop/vite.config.ts`](../apps/desktop/vite.config.ts)
- [`apps/desktop/src/App.tsx`](../apps/desktop/src/App.tsx)
- [`apps/desktop/src-tauri/src/lib.rs`](../apps/desktop/src-tauri/src/lib.rs)
- [`apps/desktop/src-tauri/Cargo.toml`](../apps/desktop/src-tauri/Cargo.toml)

At the investigation snapshot:

- 227 TypeScript/TSX source and test files were present;
- 173 were production TypeScript/TSX files;
- 44 production files directly imported Tauri APIs or invoked Tauri commands;
- 17 Rust source files implemented the host-side capabilities;
- 53 frontend unit-test files and one Playwright E2E file existed;
- 13 bundled example/template families could seed a compatibility corpus.

The raw count understates coupling: several of the largest files combine UI,
state orchestration, and native calls. Examples include `latex-editor.tsx`,
`pdf-preview.tsx`, `sidebar.tsx`, and `document-store.ts`.

### 3.2 Runtime topology today

```text
React UI / Zustand stores
        |
        | Tauri plugin calls, invoke(), events
        v
Tauri Rust host
        |
        +-- native filesystem and dialogs
        +-- Tectonic or installed TeX Live process
        +-- SyncTeX/native build workspace
        +-- libgit2 history repository
        +-- HTTP clients for AI, metadata, Zotero, CiteDrive, LanguageTool
        +-- OS integration, updater, Python/uv and external processes

Generated PDF bytes
        |
        v
React preview -> MuPDF Web Worker -> canvas/text/link layers
```

The browser product must replace the entire middle layer, not merely its
compiler command.

### 3.3 Portable frontend assets

These areas are substantially browser-native and good porting candidates:

- CodeMirror editor configuration, keymaps, autocomplete, lint surfaces, and
  Vim mode;
- semantic scanning and the existing semantic Web Worker;
- LaTeX parsing helpers for citations, cross-references, tables, outlines,
  bibliography health, and structured inline editors;
- most UI primitives, layouts, themes, and accessibility behaviour;
- Zustand state concepts and pure state transitions;
- template definitions and bundled example projects;
- compile-target resolution, fast-profile decision logic, and error
  normalisation;
- PDF viewport, scrolling, zoom, review overlay, and selection concepts;
- AI tool schemas and most frontend tool-loop logic;
- pure BibTeX utilities and `bibtex-tidy` integration;
- tutorial content and project-health logic;
- a large portion of the existing unit-test corpus.

Porting should still be selective. Copying the current large components before
introducing platform interfaces would preserve the coupling that Opal Web needs
to remove.

### 3.4 Native capability inventory

The registered Tauri commands fall into the following domains:

| Domain | Current implementation | Web implication |
|---|---|---|
| Project files | Tauri filesystem plugin and broad approved paths | Replace with browser project repository plus import/export adapters |
| Compilation | Native Tectonic crate or installed TeX Live | Replace with a WASM compiler worker |
| SyncTeX | Native build artifacts and lookup functions | Depends on selected browser engine; gate separately |
| History | A hidden libgit2 repository per project | Replace with browser snapshot storage; do not pull Git into MVP without a demonstrated need |
| Project import/export | Rust ZIP and GitHub download code | Use browser streams/ZIP library and normal `fetch` where CORS permits |
| AI | Rust HTTP streaming, environment-backed keys, Tauri events | Browser BYOK adapter with explicit security warning, or defer |
| Metadata | Rust HTTP client and cache | Browser fetch/cache only where API CORS and terms permit |
| Zotero | Localhost API plus OAuth/web access | Prioritise Zotero Web API; local connector is a progressive enhancement |
| Grammar | Rust proxy to LanguageTool | Direct browser call only if endpoint CORS permits; otherwise optional/disabled |
| Formatting | Native `tex-fmt` Rust crate | Compile formatter to WASM, use a compatible JS formatter, or defer |
| Review files | JSON files in `review/` | Preserve the file format inside the browser project for desktop interoperability |
| Python/uv | Native installer, venv and process execution | Not available in the serverless web product; remove from scope |
| OS integration | Windows, file manager, external editor, clipboard paths | Replace with browser navigation, clipboard, picker, and download affordances |
| Updates | Tauri updater | Replace with service-worker/app-version lifecycle |

### 3.5 Compilation path today

The frontend's `compileLatex()` sends a project directory and main file to the
Rust `compile_latex` command:

- [`apps/desktop/src/lib/latex-compiler.ts`](../apps/desktop/src/lib/latex-compiler.ts)
- [`apps/desktop/src-tauri/src/latex.rs`](../apps/desktop/src-tauri/src/latex.rs)

The Rust backend mirrors the project into a hidden build directory, manages
fast-build wrappers, invokes Tectonic in an isolated subprocess or TeX Live,
handles reruns and bibliography tools, collects logs/SyncTeX, and returns PDF
bytes. The browser compiler adapter must reproduce the observable contract,
not the native implementation.

Compatibility risk is material because desktop Tectonic is XeTeX-derived.
Choosing only a pdfTeX browser engine can change font, Unicode, and package
behaviour even when basic documents compile.

### 3.6 Project and state model today

`document-store.ts` currently combines:

- project scanning;
- text and binary file loading;
- file creation, deletion, rename, and save;
- project modification detection;
- open tabs, selection, and editor state;
- compilation state and per-root PDF caches;
- recent compile duration persistence;
- coordination with history, review, and preview caches.

For Opal Web this should be split into domain state and an asynchronous
`ProjectRepository`. Components and stores should never import OPFS, IndexedDB,
File System Access, ZIP, or worker details directly.

The existing semantic index is already designed around a Web Worker and is one
of the cleanest reusable subsystems.

### 3.7 PDF path today

The existing preview is already worker-based:

- PDF bytes are kept outside Zustand to avoid reactive copies;
- a MuPDF worker opens and renders documents;
- React builds canvas, text, link, selection, SyncTeX, and review-overlay
  layers;
- rendering budgets and a low-memory mode reduce browser/webview pressure.

This architecture is suitable for the web, but the renderer dependency is a
product-licensing decision. MuPDF.js is officially available under AGPL or a
commercial licence. PDF.js is Apache-2.0 and browser-focused. Preserve the
renderer-neutral React viewport contract so either can be used.

## 4. Evidence that a client-only product is viable

The proposed architecture is not speculative in the broad sense:

- SwiftLaTeX exposes pdfTeX and XeTeX WebAssembly engines with an in-memory
  filesystem and browser compilation API.
- TeXlyre demonstrates a modern React/TypeScript local-first LaTeX editor using
  IndexedDB, directory access, SwiftLaTeX engines, PWA support, and optional
  peer-to-peer collaboration.
- BentoPDF demonstrates that a large static web application can perform
  document processing locally with JavaScript, WASM, workers, and explicit
  cross-origin isolation headers.
- OPFS is supported by modern browsers and is designed for efficient
  origin-private file workloads, including synchronous access from workers.
- MuPDF.js and PDF.js both provide browser-capable document rendering stacks.

These examples validate the platform pattern, not automatic suitability of
their source code. Maintenance, package compatibility, binary size, security,
and licences must be evaluated independently.

## 5. Proposed Opal Web architecture

### 5.1 Architectural principles

1. **Local-first, not local-only.** Core authoring works locally; users may
   explicitly call external services.
2. **Browser storage is canonical.** Directory handles are optional mirrors,
   because permissions and support vary by browser.
3. **Workers own heavy computation.** LaTeX and PDF parsing/rendering never
   block the React main thread.
4. **Ports separate product logic from browser mechanisms.** Features depend
   on typed interfaces, not global browser APIs.
5. **Progressive enhancement.** A missing directory picker, persistent-storage
   grant, or shared-memory feature must degrade to a usable path.
6. **Portable by construction.** ZIP export is always available, and review
   JSON remains inside the project.
7. **No embedded shared secrets.** A static JavaScript bundle cannot keep a
   service credential secret.
8. **Explicit network boundaries.** Optional integrations declare what leaves
   the device and when.
9. **Crash and quota resilience.** Autosaves are transactional, recoverable,
   and observable.
10. **Licence gates are architecture gates.** WASM binaries and renderer code
    are not selected before distribution obligations are understood.

### 5.2 Target runtime topology

```text
                         optional explicit network calls
                         +-----------------------------+
                         | AI / Zotero / metadata / LT |
                         +--------------^--------------+
                                        |
React application                       | typed integration adapters
  |                                     |
  +-- domain stores and feature services+
  |
  +-- ProjectRepository -------------------- IndexedDB metadata
  |          |                               OPFS project files
  |          +------------------------------- ZIP import/export
  |          +------------------------------- optional directory mirror
  |
  +-- CompilerClient ---- messages ----> LaTeX Web Worker
  |                                         virtual FS + WASM engine
  |                                         package cache/read-through
  |
  +-- PdfRendererClient -- messages ----> PDF Web Worker
  |                                         PDF.js or licensed MuPDF.js
  |
  +-- SemanticClient ---- messages ----> semantic worker
  |
  +-- PWA lifecycle ---------------------- service worker + Cache Storage
```

### 5.3 Proposed standalone repository layout

```text
opal-web/
  .github/
    workflows/
      ci.yml
      deploy-preview.yml
  public/
    icons/
    templates/
    engines/              # only if licence permits redistribution
    tex-packages/          # manifest or bundled baseline
  src/
    app/                   # bootstrap, providers, routes, error boundaries
    core/
      project/             # entities, paths, project repository port
      compiler/            # compiler port, diagnostics, profiles
      history/             # snapshot model and port
      review/              # portable review schema
      integrations/        # provider-neutral network ports
    platform/
      browser/
        storage/           # OPFS and IndexedDB implementations
        file-access/       # directory picker and permission handling
        archive/           # ZIP import/export
        download/          # save/download adapter
        capabilities/      # feature detection and user-facing status
    features/              # editor, project picker, preview, references, etc.
    components/
      ui/                  # reusable accessible primitives
    workers/
      compiler.worker.ts
      pdf.worker.ts
      semantic.worker.ts
    lib/                   # pure parsers and utilities
    stores/                # UI/domain orchestration only
    styles/
  tests/
    unit/
    integration/
    e2e/
    fixtures/
      compiler-corpus/
  netlify.toml
  vite.config.ts
  vitest.config.ts
  playwright.config.ts
  package.json
  LICENSE
  README.md
```

Use React, strict TypeScript, Vite, CodeMirror, Zustand, and the existing design
language initially. Add runtime validation, for example with Zod, at persisted
data, worker-message, imported-project, and external-API boundaries.

A router is optional for MVP. If routes are used, keep project identity out of
the URL unless sharing semantics are intentionally designed; browser project
IDs can leak through history, screenshots, and analytics.

### 5.4 Core ports

The first code should establish small contracts like these:

```ts
export interface ProjectRepository {
  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: CreateProjectInput): Promise<ProjectId>;
  openProject(id: ProjectId): Promise<ProjectSnapshot>;
  readFile(id: ProjectId, path: ProjectPath): Promise<Uint8Array>;
  writeFile(
    id: ProjectId,
    path: ProjectPath,
    content: Uint8Array,
    expectedRevision?: number,
  ): Promise<FileRevision>;
  moveEntry(id: ProjectId, from: ProjectPath, to: ProjectPath): Promise<void>;
  deleteEntry(id: ProjectId, path: ProjectPath): Promise<void>;
  exportProject(id: ProjectId): Promise<Blob>;
}

export interface LatexCompiler {
  initialise(signal?: AbortSignal): Promise<CompilerCapabilities>;
  compile(
    project: CompileProjectSnapshot,
    request: CompileRequest,
    signal?: AbortSignal,
  ): Promise<CompileResult>;
  dispose(): Promise<void>;
}

export interface PdfRenderer {
  open(bytes: Uint8Array): Promise<PdfDocumentHandle>;
  renderPage(request: RenderPageRequest): Promise<ImageBitmap>;
  getText(page: number): Promise<StructuredTextPage>;
  getLinks(page: number): Promise<PdfLink[]>;
  close(): Promise<void>;
}
```

Use branded or validated project paths. Imported ZIP entries must be rejected
if they are absolute, contain traversal segments, collide after path
normalisation, or exceed configured resource limits.

Worker messages should use discriminated unions with protocol versions and job
IDs. Compilation cancellation should terminate and recreate the compiler
worker when the engine cannot be interrupted safely.

## 6. Storage and filesystem design

### 6.1 Recommended storage split

| Data | Primary storage | Reason |
|---|---|---|
| Project file bytes | OPFS | File-shaped, worker-friendly, broadly supported |
| Project metadata and file index | IndexedDB | Transactional structured records and migrations |
| History snapshots/deltas | IndexedDB, with large blobs optionally in OPFS | Queryable timeline without embedding Git |
| Small UI preferences | localStorage through Zustand persistence | Existing simple pattern is adequate |
| WASM/app/TeX URL resources | Cache Storage | Native fit for request/response assets and offline use |
| Optional local folder handle | IndexedDB | Handles are serialisable, but permission must be rechecked |
| API keys, if BYOK is enabled | IndexedDB at most; never claimed as secret storage | Browser/XSS can read them; user must be warned |

OPFS is origin-private. Clearing site data removes it. The app must therefore:

- request persistent storage where supported;
- display quota usage and persistence status;
- warn before large imports when quota is insufficient;
- maintain recoverable atomic writes;
- make ZIP backup prominent rather than burying it in settings;
- never imply that browser storage is equivalent to an external backup.

### 6.2 Project identity and schema

Each project should have a stable random ID independent of its title or folder
name. Suggested metadata:

```ts
interface StoredProject {
  schemaVersion: number;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  rootTexPath?: string;
  revision: number;
  directoryMirror?: {
    handleKey: string;
    lastSyncRevision: number;
    lastSyncAt?: string;
  };
}
```

Schema migrations must be forward-only, tested against fixtures from every
released schema, and applied transactionally before a project opens.

### 6.3 Directory access strategy

`showDirectoryPicker()` is not available consistently across major browsers.
Treat it as progressive enhancement:

- **All supported browsers:** ZIP import/export and multi-file/directory upload
  fallback.
- **Supporting browsers:** connect a user-selected directory and explicitly
  import from or sync to it.
- **MVP conflict rule:** never silently overwrite when both the browser project
  and directory changed since the last sync. Present a file-level comparison.
- **Permission rule:** check `queryPermission()` on open and request permission
  only from a user gesture.
- **Canonical rule:** loss of directory permission must not make the project
  disappear; the OPFS copy remains usable.

Automatic bidirectional background sync is deliberately deferred. Browser
permissions, external modification detection, and cross-browser behaviour make
it a distinct feature rather than an incidental save mechanism.

## 7. Compiler strategy

### 7.1 Candidate set

| Candidate | Strength | Concern | Initial disposition |
|---|---|---|---|
| SwiftLaTeX pdfTeX | Proven browser API, compact integration pattern | pdfTeX differs from desktop Tectonic/XeTeX; maintenance and licence audit required | Benchmark, not default by assumption |
| SwiftLaTeX XeTeX | Closer semantic match to current desktop engine | Larger/heavier; package delivery, maintenance, and licence audit required | Primary compatibility candidate |
| TeXlyre/BusyTeX variants | Active evidence of browser TeX Live and additional engines | Young project, distribution and compatibility need independent review | Research candidate |
| Custom Tectonic-to-WASM port | Potential desktop parity | High native-dependency and maintenance risk; no drop-in upstream browser target | Not an MVP dependency |
| Remote compile API | Broad package compatibility | Violates the client-only core promise and creates document-handling infrastructure | Out of scope |

Do not adopt an entire AGPL editor codebase merely to obtain its engine. Audit
the precise engine artifacts, source files, generated glue, TeX packages, and
redistribution terms. Record the decision in an architecture decision record
before integration.

### 7.2 Compiler worker model

- One active compile per project initially.
- A dedicated worker owns the engine instance and virtual filesystem.
- The main thread sends an immutable project snapshot or a revisioned delta.
- Binary assets transfer with transferable `ArrayBuffer`s to avoid copies.
- Each result contains PDF bytes, raw log, structured diagnostics, engine
  identity/version, package-set version, duration, and optional SyncTeX bytes.
- A stale result is discarded when its project revision is older than the
  latest requested revision.
- Auto-compile uses the desktop cooldown idea and additionally monitors worker
  memory and document visibility.
- Cancellation either invokes an engine capability or terminates the worker.
- A worker crash produces a diagnostic and clean engine restart, never a hung
  “Compiling” state.

### 7.3 TeX resources and offline policy

Three package strategies should be measured:

1. Bundle a curated baseline sufficient for all Opal templates.
2. Fetch missing packages from a versioned static package repository and cache
   them locally.
3. Offer an optional larger offline package pack.

The recommended starting point is baseline plus versioned on-demand packages.
It keeps first load reasonable while allowing an explicit “make available
offline” operation.

Every compiler result must record the engine and package-set version. Static
package URLs should be content-addressed or version-pinned; mutable package
responses make builds unreproducible and can poison offline caches.

Cross-origin isolation may be required by threaded WASM. If enabled, every
worker, WASM module, font, package, image, and integration response must satisfy
COEP/CORS/CORP rules. This can conflict with OAuth popups and third-party
resources, so it is a spike criterion rather than a late deployment tweak.

### 7.4 Compiler acceptance corpus

Start with all bundled Opal examples, including book, CV, IEEE/ACM papers,
Beamer, poster, report, thesis, bibliography, image, and custom-style cases.
Add focused fixtures for:

- Unicode and non-Latin text;
- `fontspec` and font loading;
- BibTeX/bibliography reruns;
- cross-references requiring multiple passes;
- TikZ and common scientific packages;
- local `.sty`, `.cls`, `.bst`, fonts, images, and included PDFs;
- nested `\input`/`\include` paths;
- missing packages and malformed documents;
- large images and long documents;
- shell-escape requests, which must fail clearly and safely;
- cancellation, repeated compile, and engine restart;
- offline compilation after cache warm-up.

Do not compare only PDF bytes, which may contain nondeterministic metadata.
Compare compile outcome, page count, extracted text, diagnostics, and rendered
page images within tolerances. Maintain a documented list of unsupported
packages and workflows.

## 8. PDF renderer decision

### 8.1 Options

| Option | Licence | Porting impact | Decision condition |
|---|---|---|---|
| Continue MuPDF.js | AGPL-3.0-or-later or commercial | Lowest technical porting cost; current worker and viewer concepts already use it | Use only if Opal Web's distribution model satisfies AGPL or obtains a commercial licence |
| Port renderer adapter to PDF.js | Apache-2.0 | Replace MuPDF worker internals and normalise text/link output | Preferred permissive candidate if feature/performance tests pass |

The canvas/page viewport, overlays, selection UI, and review comments should
remain independent of renderer-specific objects. No renderer document/page
object may enter Zustand state or component props.

### 8.2 Acceptance criteria

- Correct rendering of the compiler corpus in Chrome, Firefox, and Safari.
- Text selection order good enough for review anchoring.
- Internal and external links work safely.
- Incremental/lazy page rendering and cancellation.
- Stable scroll and zoom across recompiles.
- Bounded memory for long documents and high-DPI displays.
- Worker crash recovery.
- No untrusted PDF JavaScript execution.
- Review overlays and optional SyncTeX coordinates align at all zoom levels.

## 9. Feature portability and sequencing

| Desktop feature | Web status | Phase | Notes |
|---|---|---:|---|
| Source editor and tabs | Port | MVP | Remove direct window/filesystem imports first |
| Syntax highlighting/autocomplete | Port | MVP | Mostly pure CodeMirror logic |
| Semantic index and project health | Port | MVP/next | Existing worker is reusable |
| Table/math/citation/figure structured editors | Port | MVP/next | Prioritise based on coupling discovered during extraction |
| Template gallery | Port | MVP | Instantiate into OPFS rather than a native directory |
| Browser project picker | Rebuild | MVP | Recent projects from IndexedDB; capability and quota status |
| Folder open/save | Adapt | MVP/next | Explicit directory mirror; ZIP fallback everywhere |
| ZIP and GitHub import | Adapt | MVP | ZIP local; GitHub only for public/CORS-compatible downloads initially |
| Tectonic compile | Replace | MVP | WASM engine behind `LatexCompiler` |
| Installed TeX Live | Drop | — | Native-only feature |
| PDF preview | Port behind adapter | MVP | Renderer licence gate |
| SyncTeX forward/reverse sync | Investigate | Next | Engine/output dependent |
| Review comments/highlights | Port | Next | Preserve `review/*.json` format where possible |
| History timeline | Rebuild | Next | IndexedDB snapshots/deltas; no libgit2 requirement for MVP |
| AI chat/tools | Adapt | Later | BYOK only, explicit data boundary, browser-CORS spike |
| OpenAI-compatible endpoints | Adapt | Later | Browser SDK warns that credentials are exposed; user-owned keys only |
| Zotero web library | Adapt | Later | Web API supports API keys/OAuth; local API is progressive enhancement |
| Zotero local desktop API | Investigate | Later | Localhost, CORS, private-network policy, and user settings may block it |
| DOI/reference search | Adapt | Next | Validate CORS, rate limits, attribution, and caching for each source |
| CiteDrive/external bibliography | Adapt | Later | Network and credential model required |
| LanguageTool | Adapt or defer | Next | Public API limits apply; no hidden server proxy in a static product |
| LaTeX formatting | Replace | Next | WASM/JS formatter spike |
| Python/uv environment | Drop | — | Arbitrary native process execution is incompatible with scope |
| Open in external editor/file manager | Drop | — | Offer export or connected-folder sync instead |
| Multiple native windows | Adapt | Later | Browser tabs/PWA windows need explicit project locking |
| Native updater | Replace | MVP | Service-worker update UX and schema compatibility |
| Debug/system info | Rebuild | MVP | Browser capabilities, storage, engine versions, memory hints |

## 10. AI and connected services

AI is possible in a static product, but it changes the threat model:

- A shared Opal API key cannot be shipped in JavaScript.
- Browser SDKs intentionally warn that user credentials are accessible to
  client code. OpenAI's official JavaScript SDK disables browser use by default
  unless `dangerouslyAllowBrowser` is enabled.
- Any XSS vulnerability or compromised dependency could read browser-stored
  keys and manuscript content.
- Provider requests reveal selected project content to that provider.

Therefore AI should not block the local MVP. If added:

1. support user-owned keys only;
2. never place keys in URLs, logs, crash reports, exports, or service-worker
   caches;
3. show the exact files/selection included before the first request;
4. support session-only keys before persistent key storage;
5. enforce a restrictive CSP and Trusted Types where practical;
6. use `AbortController` for stream cancellation;
7. retain the provider-neutral tool schema and execute tools only through the
   project repository abstraction;
8. validate every streamed event and tool call at runtime;
9. provide a build variant with AI code and network permissions absent if a
   strong offline/privacy edition becomes a goal.

Zotero's Web API is a better browser foundation than assuming the desktop
localhost API. It currently supports API keys and OAuth 1.0a; its OAuth flow
requires a registered client secret, which is not secret in a static app.
Architecture and registration terms must be resolved before promising seamless
OAuth. Manual user-created API keys may be a simpler initial path.

## 11. PWA and Netlify deployment

### 11.1 Static deployment shape

Netlify should receive only a Vite `dist/` directory. No Netlify Function or
Edge Function is required for core functionality.

Expected configuration:

- build the standalone app with a pinned Node/pnpm toolchain;
- serve an SPA fallback only if client-side routes are used;
- serve `.wasm` with the correct content type;
- immutable long-lived caching for content-hashed JS/WASM/package assets;
- no-cache or revalidation for `index.html`, service worker, package manifest,
  and version metadata;
- COOP/COEP headers if and only if the chosen engine requires cross-origin
  isolation;
- strict CSP, `X-Content-Type-Options`, referrer policy, and appropriate
  permissions policy;
- deploy previews that run the same header and offline smoke tests as
  production.

Netlify supports `_headers` and `netlify.toml` rules for static assets. Header
behaviour must be exercised on deployed previews, not only the Vite dev server.

### 11.2 Service-worker strategy

- Cache the application shell and small critical assets during installation.
- Runtime-cache large compiler/package resources after successful verified
  fetches instead of blindly precaching every binary.
- Version engine caches independently from application caches.
- Never cache AI/API responses containing manuscript content or credentials.
- Present an “Update available” action; do not force-reload while a project is
  dirty or a schema migration is incomplete.
- Keep the old worker viable until open tabs have saved and accepted the new
  version.
- Test offline startup, compiler initialisation, and project recovery after an
  interrupted update.

Large WASM assets can exceed default PWA precache limits, so cache policy must
be deliberate rather than relying on plugin defaults.

## 12. Security and privacy design

### 12.1 Threats to address

- Malicious or malformed ZIP paths and decompression bombs.
- TeX projects designed to consume unbounded CPU/memory.
- Unexpected compiler network access or package substitution.
- Malicious PDFs targeting the rendering engine.
- XSS through filenames, logs, bibliography metadata, AI Markdown, or imported
  content.
- Formula or link schemes that navigate to unsafe URLs.
- Service-worker cache poisoning and stale vulnerable WASM binaries.
- API key theft from persistent browser storage.
- Cross-project data leakage through global stores, caches, or workers.
- Data loss through storage eviction, failed migrations, or directory sync
  conflicts.
- Multi-tab concurrent edits to the same project.

### 12.2 Required controls

- Run compiler and PDF engines in separate workers with explicit message
  schemas and restart boundaries.
- Enforce per-import file count, uncompressed size, compression ratio, path
  depth, and individual file-size limits.
- Apply compile time and memory budgets and offer a user-controlled retry.
- Self-host and version-pin security-sensitive WASM/resources where licences
  allow.
- Render logs and imported metadata as text, never raw HTML.
- Allow only safe link schemes and use `noopener`/`noreferrer` for new tabs.
- Use a strict CSP and avoid runtime code generation unless a dependency proves
  it is unavoidable.
- Isolate project-scoped caches by project ID and revision.
- Use `BroadcastChannel` or Web Locks to detect multiple writers; begin with a
  single-writer/read-only-secondary policy.
- Maintain an export/backup path that does not depend on persistent permission
  to a local directory.
- Publish a plain-language network activity and data-storage document.

WASM provides a useful memory sandbox but is not a complete security boundary.
Host imports, resource fetches, browser bugs, denial-of-service, and application
logic still require defensive design.

## 13. Testing and quality gates

### 13.1 Test layers

1. **Pure unit tests:** paths, parsers, state transitions, compile target,
   diagnostics, import validation, migrations.
2. **Adapter contract tests:** run the same suite against in-memory test and
   browser OPFS/IndexedDB implementations.
3. **Worker integration tests:** compiler/PDF worker protocols, cancellation,
   crashes, stale jobs, transferables.
4. **Compiler corpus:** all bundled templates plus targeted compatibility
   cases.
5. **Browser E2E:** Chromium, Firefox, and WebKit with Playwright.
6. **Deployed smoke tests:** Netlify preview headers, WASM MIME, offline cache,
   deep links, update lifecycle.
7. **Security tests:** hostile archives, unsafe filenames/links, CSP, dependency
   audit, resource caps.
8. **Accessibility tests:** keyboard-only authoring, focus restoration, screen
   reader status for save/compile/error, zoom and contrast.

### 13.2 MVP release matrix

Required before calling the product generally usable:

- Latest stable Chrome/Edge desktop: full core plus connected folder.
- Latest stable Firefox desktop: full core using browser storage and ZIP.
- Latest stable Safari desktop: full core using browser storage and ZIP.
- Offline mode after explicit runtime/package preparation.
- At least one constrained-memory/mobile smoke test, without promising a full
  mobile authoring experience.
- Netlify production and deploy-preview parity.

### 13.3 Performance budgets to establish during spikes

Do not invent final numbers before measuring, but record and gate:

- initial application shell transfer and interactive time;
- compiler engine download, initialisation, warm compile, and cold compile;
- package cache size and offline preparation size;
- editor responsiveness on large source files;
- PDF time-to-first-page and scroll frame stability;
- peak worker memory on representative long documents;
- autosave latency and project-open time;
- ZIP import/export time for large image-heavy projects.

## 14. Delivery roadmap

Phases are ordered by uncertainty and dependency, not calendar estimates.

### Phase 0 — decisions and feasibility gates

> In progress. See "Progress as of 2026-09-01" at the top of this document for
> what is built and measured; the CTAN path is the open gate.

Deliverables:

- standalone empty Vite/React/TypeScript test harness;
- LaTeX engine comparison using the full compiler corpus;
- PDF.js versus MuPDF feature/performance comparison;
- licence inventory covering application, engines, glue code, TeX assets,
  fonts, templates, and renderer;
- deployed Netlify spike with realistic WASM, caching, and optional COOP/COEP;
- browser capability matrix and minimum browser policy;
- architecture decision records for compiler, renderer, storage, and licence.

Exit criteria:

- a selected compiler produces acceptable output for the agreed corpus;
- a selected renderer meets the preview criteria;
- distribution obligations are understood and accepted;
- static deployment and offline cache work on target browsers;
- known incompatibilities are documented rather than hidden.

### Phase 1 — product skeleton and storage core

> Complete. The storage core, autosave, ZIP round trip, shell and design tokens
> are built and tested; the exit criteria below are each covered by a test that
> runs against real OPFS rather than a stand-in. What is deliberately *not*
> here: a directory mirror (PLAN.md 6.3 defers it) and history snapshots, which
> the roadmap places later.

Deliverables:

- independent repository and CI;
- application shell, error boundary, capability page, and design tokens;
- validated IndexedDB schema and OPFS project repository;
- project create/open/delete and recent-project list;
- transactional autosave and recovery;
- ZIP import/export with hostile-archive tests;
- storage quota, persistence, and backup UX.

Exit criteria, and what shows each one:

- projects survive reload, browser restart, app update, and simulated failed
  write — `tests/e2e/project-storage.spec.ts` reloads and re-reads; the
  contract page interrupts a write part-way and finds the previous content
  intact, and meets a record written by a newer build without discarding it;
- exported projects round-trip without data loss — a ZIP is exported through
  the real download path and imported back, and the file compared;
- two tabs cannot silently overwrite each other — a second page edits the same
  project, and the first reports the conflict rather than winning.

### Phase 2 — compile and preview vertical slice

> The loop is built. `Workspace.tsx` and `compile-session.ts` carry it, seven
> e2e tests drive it through the product, and three of the four exit criteria below
> have a test named for them. What is outstanding: the corpus in CI, which needs
> 700 MB of gitignored assets and so runs locally rather than on a runner; and
> `paper-acm`/`paper-ieee`, which are the "explicit approved exception" the
> first criterion allows for, pending a second package source.

Deliverables:

- compiler worker, package cache, diagnostics, cancellation, and restart;
- PDF worker/renderer adapter and minimal viewer;
- edit-save-compile-preview loop for multi-file projects;
- engine/package version reporting;
- compiler corpus in CI and offline compile test.

Exit criteria:

- every supported template compiles or has an explicit approved exception;
- stale compiles never replace newer output;
- the UI stays responsive during compilation and rendering;
- worker failures recover without losing edits.

### Phase 3 — Opal authoring experience

> Begun. CodeMirror is in with line numbers, undo and highlighting; the file
> list does add, switch, rename and delete; and the semantic index carries an
> outline, project health, completion for labels and citation keys, and gutter
> marks from both the index and the engine's log; images and PDFs open as
> themselves; five templates start a project as something other than blank; and
> the accessibility pass has a gate in the e2e suite; and tables and
> citations have structured editors. Not done: the math and figure editors,
> and a real screen-reader session, which no automated check
> substitutes for. The editor is
> CodeMirror configured fresh rather than ported — desktop Opal's configuration
> is in a repository this one cannot see.

Deliverables:

- port CodeMirror configuration and core editor actions;
- file tree, tabs, create/rename/delete, image/PDF asset views;
- citations, cross-references, outline, completion, diagnostics;
- semantic index and project health;
- selected structured editors and templates;
- keyboard/accessibility parity for core workflows.

Exit criteria:

- a user can complete a representative paper workflow without desktop Opal;
- ported unit tests pass without browser-platform mocks in domain code.

### Phase 4 — resilience, PWA, and folder interoperability

Deliverables:

- installable PWA and update workflow;
- offline preparation/status controls;
- explicit connected-directory import/sync for supporting browsers;
- conflict detection and resolution;
- history snapshots and recovery timeline;
- review JSON compatibility and annotation overlays;
- production observability that does not capture document content.

Exit criteria:

- the app handles offline startup, storage pressure warning, update, and sync
  conflict without silent data loss;
- ZIP and review data interoperate with agreed desktop fixtures.

### Phase 5 — optional integrations

Deliverables, each behind its own decision and tests:

- DOI/metadata lookup;
- Zotero Web API;
- LanguageTool;
- GitHub import/export or repository backup;
- AI BYOK and tool execution;
- SyncTeX if the compiler emits adequate data;
- LaTeX formatter;
- optional collaboration only after a separate product/privacy design.

No optional integration may introduce a mandatory Opal server into the core
authoring path without revisiting the product promise.

## 15. Initial implementation backlog

### Research spikes

- [ ] Confirm the exact licence of each SwiftLaTeX engine artifact and required
      runtime/package server component.
- [ ] Build the 13-template compiler corpus manifest.
- [ ] Benchmark pdfTeX and XeTeX candidates on cold/warm compile, output,
      package misses, memory, and cancellation.
- [ ] Determine whether generated SyncTeX is available and sufficiently
      compatible.
- [ ] Port one preview page to PDF.js and compare text/link geometry with the
      current MuPDF worker.
- [ ] Decide Opal Web's intended software licence before copying dependencies or
      code from copyleft projects.
- [ ] Deploy a WASM worker spike to Netlify with production headers and caching.
- [ ] Test COOP/COEP impact on external fonts, package downloads, OAuth popups,
      and third-party APIs.

### Architecture foundation

- [ ] Create ADR template and record compiler, renderer, storage, and network
      boundary decisions.
- [ ] Define branded `ProjectId`/`ProjectPath` types and path validation.
- [ ] Define versioned worker protocols and runtime schemas.
- [ ] Define `ProjectRepository`, `LatexCompiler`, `PdfRenderer`,
      `HistoryRepository`, and integration ports.
- [ ] Add an in-memory project repository for fast domain tests.
- [ ] Add OPFS/IndexedDB contract tests in Playwright.
- [ ] Specify project archive format and compatibility expectations with
      desktop Opal.

### Product foundations

- [ ] Create the standalone Vite/React/TypeScript repository.
- [ ] Establish strict TypeScript, Biome/linting, Vitest, and Playwright CI.
- [ ] Add accessible app shell and browser-capability diagnostics.
- [ ] Implement transactional autosave and recovery journal.
- [ ] Implement ZIP import/export with resource and traversal limits.
- [ ] Implement multi-tab project locking.
- [ ] Implement privacy-safe error reporting and a local diagnostics export.

### Porting order

- [ ] Port pure LaTeX/BibTeX utilities and their tests.
- [ ] Port semantic providers and worker.
- [ ] Port editor configuration behind project/editor service contracts.
- [ ] Port templates after compiler corpus results determine supported ones.
- [ ] Port preview UI after renderer selection.
- [ ] Port structured authoring tools incrementally; do not start by copying
      the monolithic editor/preview components wholesale.

## 16. Decision log to open in the future repository

Create these ADRs before implementation crosses each boundary:

- ADR-001: client-only product boundary and permitted network features.
- ADR-002: application licence and third-party licence policy.
- ADR-003: LaTeX WASM engine and package distribution.
- ADR-004: PDF renderer.
- ADR-005: OPFS/IndexedDB project schema and migration strategy.
- ADR-006: local directory mirror and conflict semantics.
- ADR-007: worker protocols, resource limits, and cancellation.
- ADR-008: PWA cache/update strategy.
- ADR-009: API-key and connected-service policy.
- ADR-010: desktop/web project and review interoperability.

## 17. Open questions

These should remain explicit until evidence resolves them. Annotated
2026-09-01; unmarked questions are still open as written.

1. ~~Will Opal Web be MIT/permissive, AGPL, source-available, or commercial?~~
   **Answered: AGPL-3.0-or-later** (ADR-002), as the consequence of keeping
   MuPDF.js. `LICENSE` is committed. The AGPL section 13 source offer is not
   built yet and blocks public deployment.
2. ~~Is XeTeX-level compatibility required for MVP, or can an explicitly
   pdfTeX-only MVP launch with a narrower template set?~~ **Moot.** Every
   candidate wraps the same BusyTeX build and ships `xetex` alongside `pdftex`,
   so the choice never arises. A related question replaces it: the corpus is
   written in the pdfTeX-oriented `fontenc[T1]` idiom, and Siglum's xelatex
   baseline cannot render T1 without an extra bundle, so *which engine the
   templates target* is now a template decision rather than an engine one.
3. Which TeX packages and fonts must work offline on first install?
   **Sharpened, not answered.** Measured against Siglum: the 39 MB xelatex
   baseline alone covers only `blank`; adding bundles fetched on demand from the
   same origin reaches 2 of 13; the other 10 need packages no bundle ships at
   all. So "works offline on first install" and "works at all" are currently the
   same question.
4. Is browser-managed storage acceptable as the default mental model, or must
   connected folders be a launch requirement?
5. Must projects round-trip with desktop Opal including hidden history, or only
   sources, assets, review JSON, and generated PDF?
6. ~~Is SyncTeX required for MVP or a post-MVP enhancement?~~ **Available.**
   Siglum emits SyncTeX data, so this is now a product decision about whether to
   surface it, not a feasibility question.
7. Should AI be absent from the initial product, session-key only, or persistent
   BYOK?
8. Which browsers and mobile form factors are support commitments rather than
   best-effort targets?
9. What is the maximum supported project size and compile duration?
10. Will TeX packages be hosted under the Opal domain, and do their licences
    allow the intended redistribution/caching model? **Now urgent**, not
    theoretical: ADR-001 requires the CTAN proxy self-hosted with version-pinned
    responses, and 10 of 13 corpus projects depend on it.
11. ~~Does cross-origin isolation materially improve the selected engine, and is
    that benefit worth the integration constraints?~~ **Not required.** Siglum
    uses `SharedArrayBuffer` opportunistically and falls back to `ArrayBuffer`,
    so isolation is an optimisation rather than a precondition. The headers stay
    switchable in `vite.config.ts` and `netlify.toml` so the benefit can be
    measured once compile timings are meaningful.
12. How will changes be shared between the independent desktop and web products
    without creating lockstep release coupling?

## 18. Relationship to the desktop repository

Opal Web should be a sibling product, not an `apps/web` package permanently
inside this repository. During incubation this folder contains planning only.

Recommended reuse process:

1. Create the standalone repository with its own licence and CI.
2. Establish platform ports and test doubles before porting feature code.
3. Copy pure utilities and tests in small, reviewable groups while preserving
   copyright and attribution.
4. Refactor large components during porting so browser mechanisms do not leak
   into UI code.
5. Keep desktop/web interoperability defined by versioned file formats and
   fixtures, not a mandatory shared runtime package.
6. If duplicated pure modules become costly later, publish a deliberately
   versioned shared package; do not begin with cross-repository source links or
   submodules.

This keeps each product deployable and maintainable even if their compiler,
renderer, release cadence, or licensing diverges.

## 19. Research sources

Primary and project sources consulted for this initial plan:

- [File System API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)
- [Origin Private File System — web.dev](https://web.dev/articles/origin-private-file-system)
- [`showDirectoryPicker()` availability — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)
- [Offline PWA data — web.dev](https://web.dev/learn/pwa/offline-data)
- [Service workers — web.dev](https://web.dev/learn/pwa/service-workers)
- [Cross-Origin-Opener-Policy — MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)
- [Netlify custom headers](https://docs.netlify.com/manage/routing/headers/)
- [Netlify static routing](https://docs.netlify.com/manage/routing/overview/)
- [SwiftLaTeX browser engine site](https://www.swiftlatex.com/)
- [SwiftLaTeX source organisation](https://github.com/SwiftLaTeX)
- [TeXlyre local-first web editor](https://github.com/TeXlyre/texlyre)
- [Tectonic project](https://github.com/tectonic-typesetting/tectonic)
- [MuPDF JavaScript/WASM documentation](https://mupdf.readthedocs.io/en/latest/guide/using-with-javascript.html)
- [MuPDF npm licence information](https://www.npmjs.com/package/mupdf)
- [PDF.js getting started and licence](https://mozilla.github.io/pdf.js/getting_started/)
- [BentoPDF client-side architecture](https://www.bentopdf.com/docs/getting-started)
- [OpenAI JavaScript browser credential warning](https://github.com/openai/openai-node/blob/master/README.md)
- [Zotero Web API v3](https://www.zotero.org/support/dev/web_api/v3/)
- [LanguageTool HTTP API](https://languagetool.org/http-api/swagger-ui/)
- [Vite PWA large-asset cache guidance](https://vite-pwa-org.netlify.app/guide/faq)

Source availability and licences can change. Repeat the dependency and licence
audit against exact pinned versions before implementation or distribution.
