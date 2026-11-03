/**
 * What to do with each request, and which cache it belongs in
 * (investigation.md 9, Phase 4: offline startup and update).
 *
 * A pure function, so the policy can be read and tested without a browser:
 * the service worker around it is then thin enough to hold in the head, which
 * matters for code that can serve a stale application to everyone who visits.
 *
 * Two classes of cached thing, with different lifetimes, and keeping them
 * apart is the whole point:
 *
 * - **The application** is hashed by the build, so a deploy renames every
 *   asset. Its cache is keyed by the build and thrown away on the next one.
 * - **The engine** is 22.7 MB of WASM, boot set and TeX files pinned to one
 *   `texlyre-busytex` version (ADR-011). Its cache is keyed by *that* version
 *   and survives deploys — re-downloading it because a button moved would be
 *   the worst possible trade.
 */

export type Strategy =
  /** Serve from the cache and never re-fetch: the URL names the content. */
  | { kind: "cache-first"; cache: string }
  /** Try the network, fall back to the cache, and keep the cache fresh. */
  | { kind: "network-first"; cache: string }
  /** Nothing to cache: ask the network and pass on whatever comes back. */
  | { kind: "network" };

export interface CacheNames {
  /** Changes with every build. */
  app: string;
  /** Changes only when the engine does. */
  engine: string;
}

export function cacheNames(build: string, engine: string): CacheNames {
  return { app: `opal-app-${build}`, engine: `opal-engine-${engine}` };
}

/**
 * The policy, by URL.
 *
 * `/texlive/` is the endpoint the engine asks for single TeX files, and those
 * answers are cached with the engine rather than with the application: they
 * are files out of the same pinned tree, and they are what makes a second
 * compile need no network at all.
 *
 * The harness is never cached. It is a debug route whose panels drive real
 * measurements, and a measurement served from a cache is not a measurement.
 */
export function strategyFor(url: URL, caches: CacheNames): Strategy {
  if (url.searchParams.has("harness")) return { kind: "network" };

  if (
    url.pathname.startsWith("/engines/") ||
    url.pathname.startsWith("/texlive/")
  ) {
    return { kind: "cache-first", cache: caches.engine };
  }

  // Vite's own output: hashed, so the name is the version.
  if (url.pathname.startsWith("/assets/")) {
    return { kind: "cache-first", cache: caches.app };
  }

  // The document itself, and anything else the shell needs. Network-first, so
  // a deploy is picked up on the next visit rather than after an eviction.
  if (url.pathname === "/" || url.pathname.endsWith(".html")) {
    return { kind: "network-first", cache: caches.app };
  }

  return { kind: "network" };
}

/**
 * Whether a response is worth keeping.
 *
 * A 404 from the TeX endpoint is *information the engine acts on* — it records
 * the miss and stops asking for that file in that compile — so caching one
 * would turn a transient answer into a permanent one. A 206 is part of a file
 * rather than a file.
 *
 * Origin is not checked here: the worker answers only same-origin GETs, and
 * one place deciding that is better than two that could disagree.
 */
export function isCacheable(response: Response): boolean {
  return response.ok && response.status === 200;
}
