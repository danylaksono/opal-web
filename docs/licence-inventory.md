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

## Pending evaluation — blocked on ADR-003 and ADR-004

Nothing below is installed yet. Each must be entered here with its exact
version and terms *before* it is added to `package.json`.

| Candidate | Expected licence | Blocking question |
|---|---|---|
| pdfjs-dist | Apache-2.0 | Confirm the shipped worker build and any bundled CMap/standard-font assets carry the same terms. |
| mupdf | AGPL-3.0-or-later or commercial | Cannot be installed until ADR-002 accepts AGPL or a commercial licence is obtained. |
| SwiftLaTeX engine artifacts | Mixed; must be read per file | Engine WASM, generated JS glue, and the package-server component may differ from the repository's headline licence. |
| TeX packages and fonts | Per package (LPPL, GPL, OFL, …) | Whether the intended redistribution and caching model is permitted, and whether they may be hosted under an Opal domain. |

## Content carried from the desktop repository

| Artifact | Source | Terms |
|---|---|---|
| `tests/fixtures/compiler-corpus/**` | `tectonic-editor` `apps/desktop/public/examples` | Same project, MIT. Copied rather than linked, per PLAN.md 18. Attribution retained here. |
