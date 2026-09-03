# Opal Web: architecture investigation and initial plan

Status: Phase 0 in progress — renderer settled, engine at 11/13  
Prepared: 2026-07-23  
Last updated: 2026-09-03  
Target product: `opal-web`, a separate repository and independently deployable product

> **Read this first.** Sections 1–19 below are the original investigation,
> written on 2026-07-23 against desktop v1.4.8. They are kept as written: the
> architecture has held up, and rewriting them would erase the reasoning that
> produced it. Where measurement has since contradicted or answered them, the
> status section immediately below says so and section 17 is annotated inline.

## Progress as of 2026-09-03

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
  a browser API or an engine type. This has already paid for itself — nine of
  the ten engine defects found so far are absorbed entirely inside adapters.
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

| | fastest | slowest |
|---|---|---|
| Engine init | 479 ms | 699 ms |
| Cold compile | 1.4 s (`blank`) | 57.5 s (`paper-acm`) |
| Warm compile, after an edit | 0.8 s | 12.2 s (`presentation-beamer`) |
| Peak memory | 907 MB (`blank`) | 1231 MB (`cv-modern`) |

**Memory is the finding, and it is not where it looked.** After init the page
holds **40 MB**; a single compile takes it to **0.9–1.2 GB**. The cost is not
the document — `blank` peaks at 907 MB on one pass, within 30% of the largest
figure in the corpus — so it is what one compile costs, and no amount of
document-level care will move it. Every pass resets the virtual filesystem and
remounts ~3,745 files into WASM linear memory, which grows and never returns.
iOS Safari terminates tabs in this region. **This is now the largest open risk
to the product running at all on mobile**, and it did not surface earlier
because nothing was measuring it: without cross-origin isolation the only
available API counts the JS heap, which here is under 3 MB.

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

**Cancellation now works and had to be built.** The port has always declared
`signal`; the adapter checked it once and never again. Siglum exposes no cancel
and a WASM TeX run holds its worker's only thread, so the adapter races each
pass against the signal and terminates the worker. Abort latency is **0–14 ms**
on all 13 projects, and the next compile succeeds. One caveat:
`presentation-beamer` recovered cleanly in one run and failed in another, so
recovery is not yet reliably clean.

**The compile cache helps least when it is most needed.** Recompiling an
unchanged document costs 0 ms — but only when it succeeded. `letter-formal` and
`cv-modern`, the two that fail, pay 4.1 s and 3.3 s every time, which is exactly
the situation where a user recompiles most.

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
  budget predicted from the source instead of read from the log, and a PDF
  cache keyed on source alone. Nine are absorbed by the adapter; the OpenType
  one cannot be. See ADR-003.
- **A port hides what an engine does, not what it will not carry.** That is the
  line the eighth defect crosses, and it is the same conclusion the version-skew
  decision reaches from the other side: the package tree has to be ours.
- **Static hosting is fussier than section 11.1 suggests.** Pre-compressed
  engine bundles must be served with no `Content-Encoding`, or the browser
  decompresses payloads the engine intends to decompress itself — presenting as
  a fetch failure while every request returns 200.

### Next, in order

1. Bring peak memory down from ~1 GB per compile. Nothing else on this list
   matters if the product cannot run on a phone.
2. Resolve a document's package closure before compiling instead of one full
   pass at a time, which is what makes first open take 57 seconds.
3. Build the bundle set from the single pinned TeX Live tree, per the skew
   decision above, and measure what it costs to host. This is what unblocks
   `cv-modern` and `letter-formal`.
4. Commit desktop Tectonic's logs alongside the reference PDFs, so diagnostics
   can be compared as well as output.
4. Exercise bibliography reruns across `natbib`, `cite` and `acmart`. No corpus
   project has reached its bibliography yet.
5. Close the remaining ADR-004 criteria: Firefox and Safari, link resolution,
   scroll and zoom stability across recompiles, crash recovery.
6. Deploy the Netlify spike with production headers and measure first load. The
   xelatex baseline alone is 39 MB on top of MuPDF's 10.4 MB.
7. Build the AGPL section 13 source offer before any public deployment.

Phase 1 does not start until 1 and 2 are answered and ADR-003 is closed.


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

Deliverables:

- independent repository and CI;
- application shell, error boundary, capability page, and design tokens;
- validated IndexedDB schema and OPFS project repository;
- project create/open/delete and recent-project list;
- transactional autosave and recovery;
- ZIP import/export with hostile-archive tests;
- storage quota, persistence, and backup UX.

Exit criteria:

- projects survive reload, browser restart, app update, and simulated failed
  write;
- exported projects round-trip without data loss;
- two tabs cannot silently overwrite each other.

### Phase 2 — compile and preview vertical slice

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
