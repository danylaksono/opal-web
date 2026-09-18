# Licence inventory

Every third-party artifact that ships to a user, or whose code is copied into
this repository, is recorded here with the exact version evaluated. investigation.md 5.1
principle 10: licence gates are architecture gates. ADR-002 is open, so this
file is what stops an obligation being acquired by accident before it closes.

Repeat this audit against pinned versions before any distribution.

## Ships to the user

| Artifact | Version | Licence | Notes |
|---|---|---|---|
| react, react-dom | 19.2.3 | MIT | |
| **Opal desktop editor** (github.com/danylaksono/opal-editor @ 8f95519) | 1.5.0 | MIT | **Code copied into this repository**, not a dependency: the workspace theme (`src/app/styles/globals.css`) and the shadcn/Radix primitives under `src/ui/`, adapted from `apps/desktop`. MIT is compatible with this repository's AGPL-3.0-or-later; the notice belongs with the copies. Note for the desktop repo: its `LICENSE` is an MIT text whose copyright line names `assistant-ui` rather than the author. |
| tailwindcss | 4.1.18 | MIT | The workspace shell's styling, as on desktop. A build-time tool that emits CSS; nothing of it runs in the browser. |
| tw-animate-css | 1.4.0 | MIT | Animation utilities the copied theme imports. |
| radix-ui, @radix-ui/react-slot | 1.4.3 / 1.2.4 | MIT | Unstyled accessible primitives behind `src/ui/` — select, dialog, tooltip, tabs. Keyboard behaviour and focus management are the reason to take a dependency here rather than hand-roll. |
| lucide-react | 0.563.0 | ISC | The icon set desktop uses. Tree-shaken to the icons imported. |
| react-resizable-panels | 3.0.6 | MIT | The draggable splits between side panel, editor and preview. |
| class-variance-authority, clsx, tailwind-merge | 0.7.1 / 2.1.1 / 3.4.0 | Apache-2.0 / MIT / MIT | Class-name plumbing the copied primitives use. |
| next-themes | 0.4.6 | MIT | Light/dark selection, as on desktop. Nothing of Next.js comes with it. |
| katex | 0.16.28 | MIT | The maths form's preview, as on desktop. **Loaded on demand**, not with the application: a first load pays nothing, and opening the form fetches 265.5 kB of JS (77.6 kB gzipped) and 29.2 kB of CSS (8.0 kB), plus the woff2 faces the formula needs. The fonts are emitted into `dist/assets` and served from this origin — a CDN reference would break both ADR-001 and the offline claim. Measured on the build of 2026-09-18. |
| zustand | 5.0.15 | MIT | Now used: `src/app/store/layout-store.ts` holds which panes are open, and persists them. |
| @siglum/engine | 0.1.4 | MIT | ADR-003 spike. Runtime assets (busytex.wasm plus TeX Live 2025 bundles, 225 MB) are fetched separately and gitignored; they are third-party TeX Live content redistributed under their own per-package terms, which still needs auditing. |
| blake3-wasm (via @siglum/engine) | 2.1.5 | Apache-2.0 OR MIT | Browser build is broken upstream and is aliased to a stub; see docs/adr/003. |
| xzwasm (via @siglum/engine) | ^0.1.2 | MIT | Pulled in transitively; only used on the CTAN path, which is not yet enabled. |
| @codemirror/{state,view,commands,language} | 6.7.4 / 6.43.11 / 6.11.0 / 6.12.4 | MIT | The editing surface (investigation.md 14, Phase 3). Permissive, so it constrains nothing: ADR-002's AGPL comes from MuPDF and this does not add to it. |
| @codemirror/lint | 6.9.7 | MIT | Gutter markers for engine diagnostics and index problems; the marks are pushed in, not computed by a linter. |
| @codemirror/autocomplete | 6.20.3 | MIT | Label and citation completion, fed by the semantic index rather than by the document's words. |
| @codemirror/legacy-modes | 6.5.4 | MIT | `stex` highlighting only. A stream mode rather than a Lezer grammar, because no maintained LaTeX grammar is published; the consequence is colour without a parse tree, so folding and outline wait. |
| fflate | 0.8.3 | MIT | ZIP import and export (investigation.md 14 Phase 1). Zero dependencies. Chosen over hand-rolling a container reader because import is hostile input; the path and resource policy stays ours in `src/core/project/archive.ts`. |
| mupdf | 1.28.0 | AGPL-3.0-or-later | Selected in ADR-004. Sets the application licence via ADR-002. WASM binary is 10.4 MB raw, 4.8 MB gzipped; a `.br` variant ships alongside it. |

## Build and test only — not distributed

| Artifact | Version | Licence | Notes |
|---|---|---|---|
| vite | 6.4.3 | MIT | |
| @tailwindcss/vite | 4.1.18 | MIT | Compiles the stylesheet at build time. |
| vite-plugin-wasm | latest | MIT | Needed because blake3-wasm uses the ESM-WASM integration proposal. |
| typescript | 5.9.3 | Apache-2.0 | |
| vitest | 4.1.11 | MIT | |
| @playwright/test | 1.62.1 | Apache-2.0 | |
| @axe-core/playwright, axe-core | 4.13.0 | MPL-2.0 | Accessibility scanning in the e2e suite. MPL is file-level copyleft and this is never distributed, so it reaches no shipped artifact — but it is the only non-permissive licence outside MuPDF, which is why it is named rather than lumped in. |
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
| `tests/fixtures/compiler-corpus/**` | `tectonic-editor` `apps/desktop/public/examples` | Same project, MIT. Copied rather than linked, per investigation.md 18. Attribution retained here. |
