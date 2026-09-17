# Picking this up on another machine

Everything decided is in `PLAN.md` and `docs/adr/`; everything measured is in the
ADR that asked the question. This file covers the part that is neither: what the
repository does not contain, how to rebuild it, and the environment traps that
have cost time before.

## Working on this locally, from a fresh clone

Node 22 or newer, and pnpm — the repo pins `pnpm@11.13.1` in `packageManager`,
so `corepack enable` is enough to get the right one.

```sh
pnpm install
pnpm exec playwright install chromium
pnpm dev            # Vite's default http://localhost:5173, or the next free port
```

**That is already the whole product except compiling.** Creating and opening
projects, the editor, the file list, rename, the outline, project health,
completion, gutter marks from the index, asset views, the table and citation
editors and the ZIP round trip all work without the engine, because none of
them needs it. `pnpm test` runs 309 unit tests; `pnpm test:e2e` runs 45 and
**skips 15**, each naming what is
missing rather than failing.

`OPAL_CHROMIUM_PATH` is for containers that cannot reach Playwright's browser
CDN. Leave it unset locally — unset means "let Playwright decide", which is what
you want once `playwright install` has run.

### To compile, three more steps

About 740 MB and ten minutes, in this order:

```sh
./scripts/download-texlyre-assets.sh     # 522 MB archive, ~700 MB unpacked, pinned to v1.4.0
pnpm spike:texlive-min xelatex --write   # builds the 41 MB boot set of 183 files from it
pnpm spike:brotli --write                # optional: pre-compresses engine, boot set, renderer
```

The second step is the one that matters: the first only unpacks the TeX Live
tree, and nothing compiles until the boot set exists. After it, `pnpm test:e2e`
runs all 60.

### Everyday

| Command | What it does |
| --- | --- |
| `pnpm dev` | The app. The Phase 0 spike panels are on their own route at `?harness=1`, which is how the spike scripts reach them |
| `pnpm test` | Unit tests, ~3 s |
| `pnpm test:e2e` | Builds, serves on 4173, drives Chromium |
| `pnpm lint` / `pnpm lint:fix` | Biome, which also formats |
| `pnpm typecheck` | `tsc -b --noEmit` across all three projects |
| `pnpm build` | What CI builds and what Netlify would serve |

**Two things that will bite otherwise**, both in "Traps that have cost time"
below: `pnpm test:e2e` reuses a preview server that is already running and does
*not* rebuild it, so after changing source either stop it or expect to be
testing the previous build; and CI runs the e2e suite without engine assets, so
**a green CI does not prove the compile path** — those thirteen tests skipped
there too.

## Where things stand

**Phase 0 — feasibility gates.** Renderer settled (ADR-004). Engine open
(ADR-003): `@siglum/engine` compiles 11 of 13 corpus projects with a self-hosted
CTAN proxy, and 2 of 13 without one; `texlyre-busytex`, the same engine on a
single TeX Live 2026 tree, compiles 12 of 14 with no network at all. Delivery
measured end to end (ADR-011): a self-hosted endpoint over the tree's own index
reaches the same 12 of 14 from a 41.24 MB boot set instead of 636 MB of tiers,
with every page count matching desktop Tectonic.
Pre-compressed, a first compile is 21.8–23.4 MB against
the 41–135 MB Phase 0 measured — and 22.7 MB of that is fixed cost shared by
every document (engine, boot set, renderer), so delivery is no longer where the
bytes are.

**Phase 1 — product skeleton and storage core: complete.** Projects live on the
device — bytes in OPFS, metadata in IndexedDB — with conditional writes,
transactional autosave, ZIP import and export, an error boundary and design
tokens. Every exit criterion has a test that runs against real storage rather
than a stand-in; `PLAN.md` 14 names which test shows which criterion.

**Phase 3 — authoring: begun.** The app is laid out as the desktop editor is:
`src/app/workspace/` holds the activity rail, the side panel (files, outline,
project health), the editor pane, the PDF preview pane and the status bar, in
`react-resizable-panels` splits, with `src/app/projects/ProjectPicker.tsx` as
the screen when nothing is open. It is built on desktop's theme
(`src/app/styles/globals.css`) and its shadcn/Radix primitives (`src/ui/`),
both copied from `opal-editor` under MIT and recorded in the licence inventory;
`src/app/styles/harness.css` is what the old page-styled spike panels still
use, scoped to `.harness-page`. CodeMirror 6 is the editing surface (line
numbers, undo, `stex` highlighting, one instance per document so undo stops at
the file).

On top of that, `src/core/latex/` holds a semantic index: a character scanner
per file, then the cross-file questions. It feeds an outline, a project-health
list and completion, and it is recomputed from memory on every keystroke
(~1 ms), which is why `ProjectsPanel` keeps every text file's content in state
rather than re-reading OPFS. `tests/unit/latex-corpus-index.test.ts` runs it
over all fourteen corpus projects and asserts it finds nothing: they compile, so
a finding there is the index's bug. Both the index's problems and the engine's
diagnostics are marked in the editor's gutter; `renameFile` is on the port so a
rename is one revision rather than a write and a delete. Images and PDFs open as
assets rather than as mangled text — which is also what stops autosave writing a
UTF-8-decoded PNG back over the original. `tests/e2e/accessibility.spec.ts` runs
axe over the product and drives the keyboard paths it cannot see. The structured
editors are a pure reader/writer in `src/core/latex/` (`tabular.ts`,
`citation.ts`) and a form in `src/app/editor/`, written back through one
conditional span replacement in `ProjectsPanel`. Outstanding: the math and
figure editors, and a
screen-reader session, which no automated check
substitutes for.

`src/core/project/templates.ts` holds the five starting points a new project can
take. They are data rather than files so they work offline and so the tests can
reach them: the unit suite runs the semantic index over each, and an e2e
compiles all five. Adding one means adding it there — both gates pick it up
automatically.

**Phase 2 — compile and preview: the loop is built.** `Workspace.tsx` opens a
project, compiles what is on screen through `LatexCompiler`, and draws the
result through `PdfRenderer`; `compile-session.ts` owns the sequencing, so the
exit criteria that are about ordering — stale output, cancellation, recovery
after a worker failure — are unit-testable without rendering a component.
Seven e2e tests drive it through the product, and most exist because
something they cover was broken at some point during the work: the default font
path, cancellation, a preview that jumped back to page 1 on every recompile.

The two numbers Phase 1 could ignore were the reason this phase waited, and both
moved first: a warm compile is 1.2–4.8 s rather than 23 s, and a first compile
is 21.8–23.4 MB rather than 41–135 MB. A third, measured since: peak memory is
440–445 MB and does not grow with the document or with the number of compiles,
so the engine recycle that cost Siglum its warm compile is not needed here. What is still missing from the phase is
the corpus in CI (it needs 700 MB of gitignored assets, so CI runs the unit and
e2e suites and not `spike:corpus-run`) and `paper-acm`/`paper-ieee`, which need
a second source for `acmart` and `IEEEtran`.

## What is not in the repository

About 1.5 GB of it, all gitignored, all regenerable. Nothing here is a source of
truth; the corpus reference PDFs *are*, and those are committed because they
cannot be regenerated without the desktop repo and a native toolchain.

| Path | Size | Rebuild with |
| --- | ---: | --- |
| `node_modules/` | — | `pnpm install` |
| Playwright's browsers | — | `npx playwright install chromium` |
| `public/engines/siglum/` | 225 MB | `./scripts/download-siglum-assets.sh` |
| `public/engines/texlyre/` | 700 MB | `./scripts/download-texlyre-assets.sh` |
| `texlive-min-*` (boot set) | 41 MB | `pnpm spike:texlive-min xelatex --write` |
| `*.br` (pre-compressed) | 22 MB | `pnpm spike:brotli --write` (after `vite build`) |
| `spike-results/` | small | `pnpm spike:corpus-run xelatex --ctan` (needs a preview running) |
| `public/tex/` | 259 MB | `pnpm spike:tex-archive` (needs `public/engines`) |
| `.cache/tectonic/index.txt` | 4.9 MB | see below |
| `public/tex-pinned/` | 4.8 MB or 249 MB | `pnpm spike:pinned-archive` (needs the index above) |
| `.cache/ctan/` | 37 MB | fills itself as the dev/preview CTAN proxy is used |

Order matters: engines before `spike:tex-archive`, and a corpus run before
`spike:range-fetch` or the `corpus` scope of `spike:pinned-archive`, because both
read what TeX recorded opening in `spike-results/logs/`.

### The pinned TeX Live tree

Its index is not committed and the builder will not fetch it for you:

```sh
mkdir -p .cache/tectonic
curl -o .cache/tectonic/tlextras-2022.0r0.tar.index.gz \
  https://data1.fullyjustified.net/tlextras-2022.0r0.tar.index.gz
gzip -dc .cache/tectonic/tlextras-2022.0r0.tar.index.gz > .cache/tectonic/index.txt
```

Then size a tier without downloading anything, and build the one you want:

```sh
pnpm spike:pinned-archive --scope macros            # sizes it, fetches nothing
pnpm spike:pinned-archive --scope corpus --fetch    # 235 files, 4.8 MB
pnpm spike:pinned-archive --scope macros --fetch    # 19,222 files, 249 MB
```

The `corpus` tier is the one worth having: it compiles 9 of 13 with the CTAN
proxy switched off entirely, and the complete `macros` tier measured no better
(ADR-011 explains why — a complete archive is not a complete filesystem while
files arrive only when TeX names them).

**The host rate-limits.** Sixteen concurrent range requests earned HTTP 429 on
every request and then a block lasting minutes. Anything above a thousand files
streams the archive once instead, which the builder chooses on its own; do not
raise the concurrency to make a large tier faster.

## The corpus has a bias, and one entry exists to cover it

Twelve of the thirteen projects taken from the desktop examples load
`fontenc`, which routes XeTeX through TFM metrics and Type 1 fonts. The
thirteenth, `paper-acm`, has never compiled because `acmart` is in no tier. So
**XeTeX's default Unicode font path was never executed by any corpus run** —
and the first document typed into the product found the hole immediately: the
font resolved through the endpoint, was saved under a name carrying no
extension, and `xdvipdfmx` could not identify it.

`article-no-fontenc` is written here rather than taken from the examples, and
it uses roman, italic, bold and monospaced text so more than one face has to
resolve. It has **no reference PDF** — those come from desktop Tectonic and
cannot be produced here — so it answers "does it compile and render", not
"does it match desktop". That is weaker than the rest of the corpus and it is
the point: the failure it covers was total, not subtle.

It carries `"local": true` in the manifest, and `pnpm spike:corpus` keeps such
entries rather than regenerating them away. Without that, the next person to
regenerate the corpus from the desktop repo would silently delete the only
cover for this path.

## Traps that have cost time

- **Git Bash rewrites a leading-slash argument into a Windows path.**
  `--archive-url /tex-pinned` arrives as `C:/Program Files/Git/tex-pinned`, and
  the failure looks like a broken app rather than a mangled flag. Pass
  `--archive-url tex-pinned`. The flag now reduces anything that still looks
  like a filesystem path, but the trap applies to any new flag taking a path.
- **`pnpm test:e2e` reuses a running preview server.** After changing source,
  rebuild before rerunning, or the tests drive the previous build and the result
  means nothing. `reuseExistingServer` is deliberate — it keeps the suite fast —
  but it does not rebuild.
- **The contract page is behind a flag.** `tests/browser/contract.html` runs the
  storage contract against real OPFS and is only built when `OPAL_TEST_PAGES=1`,
  which `playwright.config.ts` sets. An ordinary `vite build` emits no contract
  chunk, which is the point: test code must not ship.
- **Other dev servers take the usual ports.** 5173, 5174, 5180 and 5199 were
  all held by unrelated projects on the original machine, and Vite reports
  "port already in use" without saying what is holding it. 4173 is this repo's
  own preview, which `pnpm test:e2e` expects.
- **Local and deployed behaviour have diverged twice**, both times on
  `busytex.wasm` and both times invisibly. `vite.config.ts` is the reference for
  what `netlify.toml` should say; change them together.
- **This container cannot install a second browser.** `playwright install
  firefox` fails at the download: the browser CDN is unreachable from here, so
  Chromium at `OPAL_CHROMIUM_PATH` is the only engine available and the
  Firefox/Safari item in PLAN.md needs a different machine rather than more
  effort. It is not a repository problem and no amount of configuration fixes
  it from inside.
- **Playwright resolves browsers by build number.** On a machine whose
  preinstalled Chromium is a different build than the pinned
  `@playwright/test` — or one that cannot reach the browser CDN — every test
  and every browser-driven spike fails with "Executable doesn't exist" before
  anything runs. Set `OPAL_CHROMIUM_PATH` to a Chromium already on disk;
  unset means "let Playwright decide", which is the ordinary case.
- **`spike:perf` needs cross-origin isolation — not real Chrome.** This entry
  used to say both, and the Chrome half was a wrong diagnosis that stood for
  weeks and cost a measurement. `measureUserAgentSpecificMemory` is the only API
  that sees the engine's WASM heap, and it is gated on the *page* being
  cross-origin isolated; probed directly, Playwright's Chromium exposes it with
  default flags and returns a breakdown. Build and preview with `OPAL_COI=1`,
  and the column appears whichever browser drives it. The timings in a memory
  run are 10–20% higher than in a plain one, because the API forces a collection
  before it reports — compare memory runs with memory runs.

## Where the reasoning lives

Commit messages carry the detail — each one says what was measured and what it
changed — and the ADRs carry the conclusions:

- **ADR-003** — the engine, its eleven defects, version skew, and the fonts it
  cannot resolve.
- **ADR-011** — delivery. Round-trip cost over HTTP/2, the two conditions that
  each cost an order of magnitude, what feeding the engine one file at a time
  does and does not achieve, and the scoped tiers of the pinned tree. Revised: Tectonic's
  bundle repository was archived in October 2024, so the tree to index is a
  maintained one rather than its frozen 2022 vintage.
- **PLAN.md** "Progress" and "Next, in order" — the state of the whole
  investigation, kept current.

Two findings worth knowing before touching that code, because both were
counter-intuitive and are easy to undo by accident:

1. **Range requests must decline the HTTP cache.** Every file is a range of one
   URL, and Chrome locks the cache entry per URL, so the default mode serialises
   concurrent requests — 22.1 s against 0.58 s for the same 142 files.
   `fetchTexFile` enforces `cache: "no-store"` and explains why.
2. **TeX has four ways of saying a file is missing.** The kernel's backtick
   form, a package's apostrophe form via `\IfFileExists`, `\input`'s "I can't
   find file", and a package quoting the name itself. Each spelling that was
   missing cost a corpus document.
