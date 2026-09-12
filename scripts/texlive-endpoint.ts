import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Connect } from "vite";
import {
  ARCHIVE_TIER,
  buildIndex,
  type IndexEntry,
  TEXLIVE_ROOT,
  TexliveArchive,
} from "./texlive-index";

/**
 * Self-hosted TeX Live endpoint for texlyre-busytex (ADR-011).
 *
 * The engine's patched kpathsea asks JS for any file it cannot find, and the
 * wire protocol is fixed by `busytex.js`:
 *
 *     GET <endpoint>/<kpathsea format>/<encodeURIComponent(name)>
 *
 * with a synchronous XHR, a 30 s timeout, and two meanings that matter:
 * **200 with a non-empty body** registers the file, and **404** is recorded as
 * a miss and never asked for again in that compile. Anything else — a 500, a
 * timeout, an empty 200 — is treated as "not this time" and will be re-asked,
 * so an endpoint that returns 500 on an unknown name turns one missing file
 * into a retry per pass. 404 is therefore the correct answer for "no", and it
 * is the only correct one.
 *
 * Serving is a read out of `texlive-extra.data`. There is no repacking step and
 * no second copy of the tree: the tier is an LZ4-chunked archive with an offset
 * table, so a request decompresses the two or three 2 KiB chunks the file spans
 * and nothing else.
 *
 * ADR-001 is satisfied by construction — this is our own origin, serving files
 * we already ship, with no third party learning which packages a document
 * uses.
 */

/** The format code the engine sends for a plain TeX input file. */
const KPSE_TEX_FORMAT = 26;

/**
 * Suffixes to try when the name as asked for is not in the index.
 *
 * kpathsea resolves a TeX input by trying the name, then the name with `.tex`,
 * and the engine asks the endpoint the same way it would ask a local tree — so
 * `\input beamerbasenavigationsymbols` arrives here with no extension at all.
 * Answering 404 to those is not a missing file, it is a resolver that stops one
 * step early: measured, it cost `presentation-beamer`
 * (`beamerbasenavigationsymbols`) and `thesis-standard` (`lipsum.ltd`, whose
 * real name is `lipsum.ltd.tex`), both of which compile when the tier holding
 * them is preloaded instead. 2,295 of the 23,446 indexed names end in `.tex`.
 */
const SUFFIXES: Record<number, readonly string[]> = {
  [KPSE_TEX_FORMAT]: [".tex"],
};

const ARCHIVE = resolve(TEXLIVE_ROOT, `texlive-${ARCHIVE_TIER}.data`);

/**
 * Names are taken from a URL and used only for a map lookup, never for a path,
 * so the archive cannot be escaped. They are still validated, because the
 * engine will not ask for anything outside this shape and a request that does
 * is not one of ours.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/;

export interface EndpointStats {
  hits: number;
  misses: number;
  bytes: number;
}

export function texliveEndpointMiddleware(
  log: (message: string) => void = () => {},
  stats: EndpointStats = { hits: 0, misses: 0, bytes: 0 },
): Connect.NextHandleFunction {
  let index: Map<string, IndexEntry> | null = null;
  let archive: TexliveArchive | null = null;

  return (req, res, next) => {
    const url = req.url?.split("?")[0] ?? "";
    if (!url.startsWith("/texlive/")) {
      next();
      return;
    }

    const match = /^\/texlive\/(\d+)\/([^/]+)$/.exec(url);
    if (!match) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const format = Number(match[1]);
    const name = decodeURIComponent(match[2] ?? "");

    if (!SAFE_NAME.test(name)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    if (!existsSync(ARCHIVE)) {
      // A 500 here rather than a 404: the tree is missing, which is an
      // operator error, and answering "no such file" would teach the engine
      // to stop asking for every name in the document.
      res.statusCode = 500;
      res.end(
        "texlive archive missing; run ./scripts/download-texlyre-assets.sh",
      );
      return;
    }

    index ??= buildIndex();
    archive ??= new TexliveArchive();

    let entry = index.get(name);
    let served = name;
    if (!entry) {
      for (const suffix of SUFFIXES[format] ?? []) {
        const candidate = `${name}${suffix}`;
        const found = index.get(candidate);
        if (found) {
          entry = found;
          served = candidate;
          break;
        }
      }
    }

    if (!entry) {
      stats.misses += 1;
      log(`[texlive] 404 ${format}/${name}`);
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    stats.hits += 1;
    stats.bytes += entry.length;
    log(
      `[texlive] 200 ${format}/${name}${
        served === name ? "" : ` -> ${served}`
      } ${entry.length}B${
        format === KPSE_TEX_FORMAT ? "" : ` (format ${format})`
      } ${entry.path}`,
    );

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(entry.length));
    // Same-origin and served to a synchronous XHR inside a worker; no caching
    // headers, because the engine caches registered files in its own FS for
    // the life of the compile and a browser cache entry would only confuse the
    // byte accounting a first-load measurement depends on.
    res.end(archive.read(entry.start, entry.length));
  };
}
