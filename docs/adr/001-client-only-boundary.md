# ADR-001: Client-only product boundary and permitted network features

- **Status:** Accepted
- **Date:** 2026-09-01
- **Deciders:** danylaksono

## Context

Opal Web's product promise is that editing, storage, compilation, preview,
history and import/export happen on the user's device. That promise is only
meaningful if it is testable, so the boundary has to be an architectural rule
rather than an intention.

"Client-side" does not mean "no network traffic": first load fetches the app,
the WASM engine, TeX packages and templates from a static host, and optional
integrations are network features by definition.

## Decision

1. No document content is sent to a server operated by Opal.
2. There is no server-side compilation path, and no remote compile fallback.
3. Network calls fall into exactly two classes, and the code makes the class
   visible at the module boundary:
   - **runtime assets** — the app shell, engine, packages, templates, fetched
     from the static origin;
   - **user-invoked integrations** — AI, Zotero, DOI metadata, LanguageTool,
     which are optional, individually disableable, and never on the core
     authoring path.
4. A feature may not become mandatory to authoring if it requires a network
   call. Anything on the compile/edit/preview loop must work offline once
   runtime assets are cached.
5. No shared secret ships in the bundle. A static JavaScript build cannot keep
   a credential, so integrations are bring-your-own-key or public-endpoint only.

## Consequences

- Package availability is bounded by what the distribution can ship or fetch
  from a static, version-pinned repository. Some TeX Live workflows will be
  unsupported, and that list must be published rather than hidden.
- Shell-escape must fail with a clear diagnostic, never silently.
- Anything that would need a server — real-time collaboration, account sync —
  is out of scope until this ADR is superseded.

## Evidence

PLAN.md sections 2.1, 5.1 and 12. Carried into the harness as the
`isolationHeaders` switch in vite.config.ts and the absence of any HTTP client
in `src/core`.
