# ADR-012: SyncTeX forward search

- **Status:** Accepted — the offsets are usable; parsing and coordinate conversion are implemented and tested against a real compile
- **Date:** 2026-09-19
- **Deciders:** danylaksono

## Context

PLAN.md's "next, in order" item 4 asked one question: does one document, one
known line, and one click tell us whether SyncTeX's offsets survive
`xdvipdfmx`? The desktop editor never answers this in portable code — it
shells out to the native `synctex` command line tool — so there is nothing to
port, only the text format to parse and the coordinate math to get right.
ADR-010's review re-anchoring needs the answer either way:
`ReanchorContext.forwardSearch` is the only route for an annotation with no
text under it, and until this ADR it had no implementation at all.

## Method

`tests/fixtures/synctex-probe/main.tex` is a small document written for this
check: one word, `SYNCTEXPROBEMARKER`, appears exactly once, on line 5, and
nowhere else. It was compiled for real through `TexlyreLatexCompiler`
(`basic` tier, xelatex), and two independent readings were taken from that one
compile:

1. The `.synctex.gz` bytes the engine returned, decompressed
   (`DecompressionStream`) and saved verbatim as
   `tests/fixtures/synctex-probe/main.synctex.txt` — the real SyncTeX text,
   not a synthetic sample.
2. The ground-truth PDF rect for the marker word, from `searchPage` on the
   compiled PDF (ADR-010's increment 2) — MuPDF's own text search, which owes
   nothing to SyncTeX.

If a parser's forward search for `(main.tex, line 5)` produces a box that
contains the word `searchPage` actually found, the offsets are usable. This
is exactly the manual check PLAN.md asked for; `tests/unit/synctex-parse.test.ts`
replays it as a committed, repeatable test rather than a one-time finding
taken on trust.

## Decision

**The offsets are usable**, within the tolerance review re-anchoring needs
(`POSITION_TOLERANCE` in `reanchor.ts` is 12pt; the measured position agreed
to within about 1pt). Implemented in `src/core/synctex/parse.ts`:

- `parseSyncTex(text)` — a from-scratch parser of the SyncTeX text format
  (version 1): the preamble's `Input:` map and offsets, and every page's
  boxes (`(`/`[`, sized) and leaves (`h`/`v` sized, `k` kern, `g` glue).
- `forwardSearchSyncTex(doc, file, line)` — every box recorded for a source
  location, matching the input path by suffix (the engine records an
  absolute, engine-rooted path like `/home/web_user/project_dir/./main.tex`;
  a project only knows `main.tex`).
- `synctexBoxToRect(preamble, box)` — sp to PDF points, calibrated (not
  assumed) against the ground truth above.

`src/platform/browser/compiler/synctex.ts` adds `synctexForwardSearch`, which
decompresses, parses and searches a batch of `ReviewSourceLocation`s in one
call — the literal shape `ReanchorContext.forwardSearch` needs. It is not
bound to `reanchorAnnotations` from application code; see "Still open."

## What the probe found that changed the design

**Reading only box headers finds nothing for a real paragraph.** The
starting plan was a "minimal surface" — box begin/end and skip every leaf
type. The real file falsified that immediately: the box enclosing our
marker's first typeset line is itself tagged `1,6` (line 6, the *blank* line
after it), because TeX's line counter had already advanced by the time the
box closed. The accurate tag — `1,5`, our marker's real line — appears only
on the `h`/`k`/`g` leaves *inside* that box. A parser reading headers alone
would report "not found" for the first line of every paragraph, silently.
So every leaf type is parsed, and a leaf match resolves to its **enclosing
box**, not its own point (a `g` leaf carries no size at all) or its own box
when it has one (the `h` leaf in the sample was a 15pt paragraph-indent
marker with zero height — a sliver, not something a person could see
highlighted).

**The tex-pt-to-bp conversion is real, not noise.** `X Offset` and
`Y Offset` in the sample (4736287 sp) are TeX's standard 1-inch margin —
4736287 / 65536 = 72.27, which is 1 inch in TeX points, not PDF points.
Converting sp to PDF points without multiplying by `72/72.27` first put
every position off by about 0.4%, small in absolute terms (under a point for
this document) but a documented unit error rather than acceptable rounding,
and one that grows with distance from the origin on a large page.

## Consequences

- **The four `ReviewAnchorStatus` states in `reanchor.ts` can now actually
  reach `shifted`/`drifted` via the SyncTeX route**, not only via text
  search — the only path an annotation with no `selectedText` had.
- **Magnification scaling is implemented but unverified.** Every document
  used to check this compiles at the default `Magnification:1000`,
  the ratio that makes the scale factor a no-op. `synctexBoxToRect` applies
  `magnification / 1000` uniformly to the box and the offsets, which matches
  every reference SyncTeX client, but nothing here has exercised a document
  using `\mag` or a non-default `\magnification`. Treat a magnified
  document's anchor as unverified until one is checked the same way this ADR
  checked the default case.
- **Path matching is by suffix, not exact identity.** `sameSource` strips a
  leading `./` and any `/./` segment and compares by `endsWith`. This is
  correct for this project's single-root layout; a project with two files
  sharing a suffix (`chapters/intro.tex` and `intro.tex` both ending in
  `intro.tex`) could match the wrong one. Not observed, because no corpus
  document has this shape — worth a real fixture before it is trusted at
  scale.
- **Still open, same as ADR-010 left it:** nothing calls
  `synctexForwardSearch` from application code. `WorkspaceScreen` and
  `PreviewPane` are untouched; `reanchorAnnotations` still has no caller. The
  next increment is the UI itself — comments panel, gutter marks, drawing
  overlay — now that both of `ReanchorContext`'s routes have a real
  implementation behind them.

## Evidence

- `pnpm test`: 401 passed, including 6 new
  (`tests/unit/synctex-parse.test.ts`) checked against the committed real
  fixture and real `searchPage` ground truth.
- `pnpm typecheck` and `pnpm lint`: clean.
- Manual verification session, 2026-09-19: compiled
  `tests/fixtures/synctex-probe/main.tex` via `TexlyreLatexCompiler` (`basic`
  tier, xelatex) through the `?harness=1` compiler spike, driven by a
  throwaway Playwright script (not committed). Captured the decompressed
  `.synctex.gz` text and the `searchPage(0, "SYNCTEXPROBEMARKER", 4)` result
  from the same compiled PDF; both are now fixed in the fixture and the test.
