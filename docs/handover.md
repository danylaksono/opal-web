# Picking this up on another machine

Everything decided is in `PLAN.md` and `docs/adr/`; everything measured is in the
ADR that asked the question. This file covers the part that is neither: what the
repository does not contain, how to rebuild it, and the environment traps that
have cost time before.

## Where things stand

**Phase 0 — feasibility gates.** Renderer settled (ADR-004). Engine open
(ADR-003): `@siglum/engine` compiles 11 of 13 corpus projects with a self-hosted
CTAN proxy. Delivery proposed and measured (ADR-011).

**Phase 1 — product skeleton and storage core: complete.** Projects live on the
device — bytes in OPFS, metadata in IndexedDB — with conditional writes,
transactional autosave, ZIP import and export, an error boundary and design
tokens. Every exit criterion has a test that runs against real storage rather
than a stand-in; `PLAN.md` 14 names which test shows which criterion.

**Phase 2 — compile and preview** is next, and is where the two numbers that
Phase 1 could ignore start to matter to a person: a 23 s warm compile on
`paper-acm`, and a 41–135 MB first load. `PLAN.md` "Next, in order" holds the
sequence and why.

## What is not in the repository

About 780 MB of it, all gitignored, all regenerable. Nothing here is a source of
truth; the corpus reference PDFs *are*, and those are committed because they
cannot be regenerated without the desktop repo and a native toolchain.

| Path | Size | Rebuild with |
| --- | ---: | --- |
| `node_modules/` | — | `pnpm install` |
| Playwright's browsers | — | `npx playwright install chromium` |
| `public/engines/` | 225 MB | `./scripts/download-siglum-assets.sh` |
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
- **`spike:perf` needs real Chrome and cross-origin isolation.**
  `measureUserAgentSpecificMemory` is the only API that sees the engine's WASM
  heap; Playwright's bundled Chromium has it present but disabled.

## Where the reasoning lives

Commit messages carry the detail — each one says what was measured and what it
changed — and the ADRs carry the conclusions:

- **ADR-003** — the engine, its eleven defects, version skew, and the fonts it
  cannot resolve.
- **ADR-011** — delivery. Round-trip cost over HTTP/2, the two conditions that
  each cost an order of magnitude, what feeding the engine one file at a time
  does and does not achieve, and the scoped tiers of the pinned tree.
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
