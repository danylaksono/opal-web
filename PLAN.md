# Opal Web — the plan

**Opal Web is the Opal desktop editor, adapted to a browser.** Same product,
same shape, same LaTeX: an activity rail, a side panel, an editor, a PDF
preview and a status bar. What differs is only what the browser makes
different — projects live in OPFS instead of a folder, TeX is a WASM engine
instead of a Tectonic binary, and no document leaves the device because there
is nowhere for it to go.

Status: **Phases 0–3 complete, Phase 4 begun.** A person creates a project,
writes across several files, compiles in the browser, reads the page, and can
do it again with the network switched off.

Where the rest lives:

- Decisions, with the argument that produced each: [docs/adr/](docs/adr/).
- The original July investigation, whose numbered sections the code cites:
  [docs/investigation.md](docs/investigation.md).
- The measurements those decisions were made *from*:
  [docs/progress-archive.md](docs/progress-archive.md).
- How to run, build and test any of it, and the traps that have cost time:
  [docs/handover.md](docs/handover.md).

## What exists

| | |
|---|---|
| **Storage** | Projects on the device: bytes in OPFS, metadata in IndexedDB, conditional writes, transactional autosave, ZIP import and export. One contract suite runs against the in-memory repository and against real OPFS, so the two cannot drift. |
| **Compile** | `texlyre-busytex` on a worker, fed one file at a time from a TeX Live 2026 tree we serve ourselves. Sequencing — stale results, cancellation, restart after a crash — lives in `compile-session.ts` and is testable without a browser. |
| **Preview** | MuPDF on its own worker, rasterising at the chosen zoom rather than stretching a bitmap, and keeping the reader's page across a recompile. |
| **Authoring** | CodeMirror 6; a semantic index recomputed on every keystroke (~1 ms) carrying an outline, completion for labels and citation keys, and a project-health list that answers "does this resolve" without compiling; gutter marks from both the index and the engine. |
| **Structured editors** | Tables, citations, figures and mathematics. Each is a pure reader/writer in `src/core/latex/` plus a form, written back through one conditional span replacement. |
| **Offline** | A service worker with two caches: the application keyed by the build, the engine keyed by its own version. A document compiles with the network off. |

The numbers that constrain what comes next, each measured rather than
estimated (ADR-003, ADR-011, and the archive):

- **12 of 14** corpus projects compile with no network at all. The two that do
  not need `acmart` and `IEEEtran`, which are not in the tiers we ship.
- **21.8–23.4 MB** for a first compile, 22.7 MB of it fixed cost shared by
  every document — and **71 MB** once cached, because Cache Storage keeps
  decoded bodies rather than the compressed transfer.
- **1.2–4.8 s** for a warm compile. **440–445 MB** peak memory, flat across
  compiles and across document sizes.
- Every page count matches desktop Tectonic on the corpus.

## What the desktop taught us

The desktop source was read alongside a working browser product in September.
It settled the shell — rail, side panel, editor, preview, status bar, and the
pickers for tables, citations, figures and maths — which this product now
follows, using desktop's own theme and primitives under MIT. It also made the
remaining work statable as one question: **which desktop subsystem does the
browser make impossible, expensive, or merely different?**

| Desktop subsystem | In a browser |
|---|---|
| Review: JSON per reviewer inside the project, anchors in PDF coordinates, four re-anchoring states | **Ports as data.** Keep the same files and a project moves between the two products. ADR-004 chose MuPDF partly for the text geometry this needs. The browser work is a text layer over a canvas, re-anchoring after each compile, and drawing. |
| History: libgit2 commits in a folder inside the project | **Different by force.** There is no libgit2 here, so snapshots go in IndexedDB — which means history does *not* travel inside a ZIP. That is a compatibility claim either way, and wants an ADR before it is built. |
| SyncTeX: two native commands over Tectonic | **Available, unproven.** The engine runs `-synctex=1`, the port already carries the bytes, and a harness compile on 2026-09-18 reported SyncTeX emitted. Whether the offsets survive `xdvipdfmx` is unmeasured. Parsing is ours; `DecompressionStream` is already probed. |
| An updater | **No analogue.** A service worker instead — built, and the one Phase 4 item the desktop could teach us nothing about. |
| Folder access, where a path is a path | **Chromium only.** `showDirectoryPicker` is a progressive enhancement over a ZIP round trip that has to keep working, and its permission is re-granted per session. |
| LanguageTool, Zotero, DOI lookup | **Phase 5, behind ADR-001.** Each is a native command on the desktop precisely because a browser cannot call it without a proxy of ours or a CORS grant of theirs. |
| AI provider, skills gallery, Python via `uv` | **Out of scope**, and not to be re-derived: they are native processes (investigation 3.4). |
| `detect_texlive` | Meaningless here. |

## Next, in order

1. **Storage pressure, then the offline promise.** 71 MB of cache plus a
   project is an origin a browser may evict. Measure what eviction does, and
   whether the persistence grant the picker already offers prevents it. The
   "prepare for offline" control comes after that, because only then can it
   promise anything.
2. **Review annotations.** The largest port, and the one ADR-004 was decided
   for. Keep desktop's file shape, so interoperability is testable against a
   shared fixture rather than asserted. **Begun** (ADR-010): the data model,
   the per-author `review/*.json` shape, and the four-state re-anchoring
   check are ported and tested against a fixture matching desktop's exact
   bytes. Still open: a `searchPage` message on the PDF worker protocol,
   SyncTeX forward search bound to `forwardSearch`, and every UI piece —
   comments panel, gutter marks, drawing overlay, PDF-side selection.
3. **History snapshots**, after an ADR on whether they travel with a ZIP.
4. **SyncTeX**: one document, one known line, one click tells us whether the
   offsets are usable. It pays twice, because a review anchor carries a source
   location.
5. **Connected folder sync**, last, because it is the least portable.

Carried from Phase 3, none of it blocking the above:

- A screen-reader session. axe and the keyboard tests say the mechanics are
  right; nobody has driven this with a screen reader, and that is a different
  kind of evidence.
- Firefox and Safari. Nothing has run outside desktop Chromium, and Safari's
  WASM limits are the ones most likely to bite a 32 MB engine. **Needs a
  different machine.**
- `acmart` and `IEEEtran` from a second source, on a machine that can reach a
  TeX Live mirror. Until then a document using either fails with "File
  `acmart.cls' not found", followed by LaTeX's own "The font size command
  `\normalsize` is not defined" — one missing class, two error messages.
- Deploy, and confirm brotli and the first-load figure on a real host.
- The AGPL section 13 source offer, before anything is public.

## What not to re-litigate

- **No document leaves the device.** No account, no server, no telemetry
  carrying content. Optional integrations are opt-in, named, and behind
  ADR-001; each arrives with its own decision record or not at all.
- **The application is AGPL-3.0-or-later**, because MuPDF is (ADR-002,
  ADR-004). Every third-party artifact that ships is recorded with its exact
  version and terms in [docs/licence-inventory.md](docs/licence-inventory.md),
  including the code copied from the desktop editor under MIT.
- **The ports stay clean.** `src/core/` knows nothing of a browser; the engine
  and the renderer sit behind `LatexCompiler` and `PdfRenderer`, which is what
  let the engine be replaced without touching the product.
- **Two test disciplines, each of which has caught real defects.** The
  semantic index runs over all fourteen corpus projects and must report
  *nothing* — they compile, so a finding there is the index's own bug. And the
  e2e suite drives `vite preview`, so a green suite says nothing about `pnpm
  dev`: that gap hid a broken TeX endpoint for two phases.
- **Refusing is a feature.** Every structured editor declines what it cannot
  write back without losing something — a comment inside a table, a figure
  with two images — and says why. A convenience that silently drops part of a
  document is not a convenience.

## Phase 5, if it is ever wanted

DOI and metadata lookup, Zotero, LanguageTool, GitHub import and export, AI
with a user's own key, a LaTeX formatter. Each behind its own decision, its
own tests, and ADR-001's boundary; none of them a reason to introduce a
mandatory Opal server.
