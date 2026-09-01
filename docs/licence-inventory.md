# Licence inventory

Every third-party artifact that ships to a user, or whose code is copied into
this repository, is recorded here with the exact version evaluated. PLAN.md 5.1
principle 10: licence gates are architecture gates. ADR-002 is open, so this
file is what stops an obligation being acquired by accident before it closes.

Repeat this audit against pinned versions before any distribution.

## Ships to the user

| Artifact | Version | Licence | Notes |
|---|---|---|---|
| react, react-dom | 19.2.3 | MIT | |
| zustand | 5.0.15 | MIT | Not yet used; reserved for Phase 1 domain state. |
| mupdf | 1.28.0 | AGPL-3.0-or-later | Selected in ADR-004. Sets the application licence via ADR-002. WASM binary is 10.4 MB raw, 4.8 MB gzipped; a `.br` variant ships alongside it. |

## Build and test only — not distributed

| Artifact | Version | Licence | Notes |
|---|---|---|---|
| vite | 6.4.3 | MIT | |
| typescript | 5.9.3 | Apache-2.0 | |
| vitest | 4.1.11 | MIT | |
| @playwright/test | 1.62.1 | Apache-2.0 | |
| @biomejs/biome | 2.5.11 | MIT OR Apache-2.0 | |
| @vitejs/plugin-react | 4.7.0 | MIT | |
| tsx | 4.23.13 | MIT | |
| esbuild (transitive) | 0.25.12, 0.28.2 | MIT | |

## Pending evaluation — blocked on ADR-003

Nothing below is installed yet. Each must be entered here with its exact
version and terms *before* it is added to `package.json`.

| Candidate | Licence | Blocking question |
|---|---|---|
| `wasmtex` 0.1.1 | MIT | Ships a machine-checked audit of its 2545 TeX Live packages against an explicit allowlist, 0 failures — see `docs/evidence/wasmtex-0.1.1/licenses.json`, with `SHA256SUMS` and a pinned tlpdb revision. Does not provide `acmart` or `IEEEtran`. |
| `texlyre-busytex` 1.4.0 | AGPL-3.0-or-later | Compatible with the app licence since ADR-002. No equivalent package-level licence audit located. |
| `@siglum/engine` 0.1.4 | MIT | On-demand CTAN fetching means packages arrive at compile time; their licences must permit our caching and re-serving from a self-hosted proxy. |
| TeX packages and fonts | Per package (LPPL, GPL, OFL, …) | Whether the intended redistribution and caching model is permitted, and whether they may be hosted under an Opal domain. Largely answered for wasmtex by the audit above. |

## Evidence held in this repository

`docs/evidence/wasmtex-0.1.1/` holds that release's `manifest.json`,
`licenses.json` and `SHA256SUMS`, copied verbatim so the ADR-003 coverage
analysis is reproducible without re-fetching a 435 MB asset archive. They are
third-party artifacts, retained as evidence rather than distributed as part of
the app.

## Content carried from the desktop repository

| Artifact | Source | Terms |
|---|---|---|
| `tests/fixtures/compiler-corpus/**` | `tectonic-editor` `apps/desktop/public/examples` | Same project, MIT. Copied rather than linked, per PLAN.md 18. Attribution retained here. |
