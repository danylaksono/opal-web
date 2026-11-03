# Progress archive

Two dated progress reports, kept because the decisions in `PLAN.md` were made
*from* the measurements in them. The engine changed on the evidence in the
2026-09-03 section; the delivery model was settled by the numbers in the
2026-09-12 one. A reader who deletes these is left with conclusions and no
evidence.

Neither is maintained. Where they disagree with `PLAN.md`, `PLAN.md` is what
the product does now.

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
- **A figure editor**, and with it a way to get an image into a project at
  all. With the cursor in a `figure`, its five decisions open as a form —
  which image, how wide, what it says, what to call it, where it may float —
  and Apply writes the environment back **in place**: a body holding a
  `\vspace` or a `\footnotesize` keeps them, because a figure legitimately
  contains what no form models. It writes the caption before the label, since
  a `\label` above its `\caption` numbers the section instead and the
  reference then points somewhere else. It refuses a figure with two images
  rather than editing the first of them. The image list is the project's own
  files, and "Import image" writes one into `figures/` — until now nothing in
  the product could create a binary file, so every new project's figure form
  would have opened with an empty list and no way to fill it.
- **Two defects the figure work found.** The path the form writes is the path
  the file list gives, because the index resolves `\includegraphics` against
  the project's own paths and a basename would have it report a missing
  graphic on a document that compiles. And an imported image was added to the
  file list but not to the sources the index is built from, so project health
  called it missing the moment it arrived; both are now asserted in tests.
- **A maths editor, and Phase 3's structured editors are done.** Source on the
  left, KaTeX's picture of it on the right, the kind of display as a choice
  (inline, `\[…\]`, `equation`, `align`, `gather`, `multline`, numbered or
  starred), and a `\label` field that appears only where a number will be
  printed — a label on an unnumbered environment names something the reader
  never sees. The preview **informs and never gates**: KaTeX refuses plenty of
  correct LaTeX — a macro from the preamble, anything from a package — and a
  preview that could block Apply would be a preview deciding what compiles. It
  also names an unbalanced delimiter, which is the mistake TeX reports
  somewhere else entirely. KaTeX is loaded when the form first opens, so a
  first compile does not carry it (ADR-011's budget is unchanged); its fonts
  are emitted as assets of this origin, because a CDN would break both ADR-001
  and the offline claim.
- **Inline `$…$` is written but never read.** Pairing dollars in a real
  document means deciding whether the `$` closing one expression opens the
  next — across lines, through `\$`, inside verbatim — and getting it wrong
  replaces a span that was never maths. The form offers inline maths for
  insertion and declines to claim an existing `$x$`, which is the same refusal
  discipline the other three readers use.
- **Phase 4 has started: the offline shell is built and measured.** A service
  worker keeps two caches apart on purpose — the application's, keyed by the
  build, and the engine's, keyed by the `texlyre-busytex` version — so a deploy
  replaces the app and leaves 22.7 MB of engine alone. It pre-caches nothing:
  someone who opens Opal Web to read a document should not pay for an engine
  they never run, so what is used is kept and the rest is never fetched. The
  policy is a pure function with its own tests (`offline/strategy.ts`), because
  a service worker decides what *everyone* is served and stays wrong until a
  cache is cleared.
- **Measured, rather than assumed.** A service worker does intercept the
  engine's requests, including the synchronous XHR its worker makes to
  `/texlive/…` — that was checked with a throwaway worker before any of this
  was designed, because the fallback (caching in the page, through the
  adapter) would have been a different design. After one compile the engine
  cache holds **71.05 MB across 10 entries**, and the origin is using 94.4 MB
  of a 3,166 MB quota. The 71 MB is not a contradiction of ADR-011's 22.7 MB:
  that figure is the compressed transfer, and Cache Storage keeps decoded
  bodies. Whether an origin this size survives storage pressure is the next
  thing to measure, and the persistence control the picker already offers is
  what it hangs on.
- **The claim, taken literally.** `tests/e2e/offline.spec.ts` compiles a
  document, switches the network off, reloads, and compiles again: TeX runs in
  the browser with nothing available to fetch. A 404 from the TeX endpoint is
  never cached — the engine reads one as "no such file" and stops asking, so
  caching it would make a transient answer permanent.
- 351 unit tests and 71 Playwright e2e tests. The e2e suite is the part that
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
2. What Phase 3 still owes: an accessibility check a
   machine cannot do — axe and the keyboard tests say the mechanics are right,
   but nobody has driven this with a screen reader, and that is a different kind
   of evidence.
3. `paper-acm` and `paper-ieee` from `texmfrepo`, on a machine that can reach a
   TeX Live mirror.
4. Deploy, and confirm brotli and the first-load figure on a real host.
5. Commit desktop Tectonic's logs beside the reference PDFs, so diagnostics can
   be compared as well as output.
6. The AGPL section 13 source offer, before any public deployment.
7. Then Phase 4, in the order and for the reasons in "Phase 4, read against the
   desktop editor" below: offline shell and engine caching first, review
   annotations second, history third, SyncTeX fourth, folder sync last.

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
