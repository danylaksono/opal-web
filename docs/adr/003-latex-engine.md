# ADR-003: LaTeX WASM engine and package distribution

- **Status:** Open — spike in progress
- **Date:** 2026-09-01
- **Deciders:** danylaksono

## Context

Desktop compiles with Tectonic, which is XeTeX-derived. A browser engine that
only offers pdfTeX will differ in font handling, Unicode and package behaviour
even where simple documents compile identically, so "it compiled" is not the
acceptance test.

The corpus in `tests/fixtures/compiler-corpus` is pinned from the desktop
examples and is the measurement instrument. It is 13 projects, 6 document
classes and 32 distinct packages, and it already exposes the hard cases:

- `acmart` and `IEEEtran` are third-party classes, not baseline TeX;
- `beamer` is a class with heavy asset requirements;
- `fontawesome5` needs a non-core font package;
- `tikz`, `siunitx`, `tcolorbox`, `listings`, `microtype` are common
  browser-engine failure points;
- 4 of 13 projects need bibliography passes across `natbib`, `cite` and
  `acmart` styles, so multi-pass orchestration is in scope from the start;
- `poster-academic` is `a0paper`, which stresses renderer memory as well.

## Options considered

Per PLAN.md 7.1: SwiftLaTeX pdfTeX, SwiftLaTeX XeTeX, TeXlyre/BusyTeX variants,
a custom Tectonic-to-WASM port, and a remote compile API. The remote API is
already excluded by ADR-001.

## Decision

**Open.** Exit criteria for this ADR:

1. Compile outcome recorded for all 13 corpus projects, per engine.
2. Comparison is not byte-level. Compare outcome, page count, extracted text,
   diagnostics and rendered page images within tolerance — the reference PDFs
   carry nondeterministic metadata.
3. Cold and warm compile time, peak memory, package-miss count, and
   cancellation behaviour measured per engine.
4. Whether usable SyncTeX is emitted at all.
5. Exact licence of every engine artifact, its generated glue and the package
   server component, recorded in the licence inventory before integration.

## Consequences

Until this is decided, `LatexCompiler` in `src/core/compiler/types.ts` is the
only compiler surface any other code may depend on. `EngineIdentity` carries the
package-set version on every result so a compile stays reproducible and offline
caches cannot be poisoned by a mutable package URL.
