import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Connect } from "vite";

/**
 * Self-hosted, version-pinned CTAN proxy for the ADR-003 spike.
 *
 * ADR-001 permits fetching *runtime assets* from an origin we control, and
 * nothing else. On-demand package fetching reveals which packages a document
 * uses, so this must not become a live pass-through to a third-party mirror at
 * request time. Two properties make it acceptable:
 *
 * - **Pinned.** Packages come from TeX Live 2025's `tlnet-final` archive, which
 *   is frozen, rather than `tlnet`, which tracks the current release. PLAN.md
 *   7.3 requires this: a mutable package URL makes builds unreproducible and
 *   can poison an offline cache.
 * - **Cached on disk.** After the first fetch the upstream is never contacted
 *   again for that package, so a warm deployment serves packages entirely from
 *   its own origin.
 *
 * Name resolution uses Siglum's own `file-to-package.json`, already on disk,
 * instead of CTAN's JSON API — so no package name leaves the machine at compile
 * time.
 *
 * Mounted at `/ctan`, same-origin, so there is no CORS surface and no
 * cross-origin isolation interaction.
 */

/** TeX Live 2025, final frozen state. Deliberately not `tlnet`. */
const UPSTREAM =
  "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final/archive";

const CACHE_DIR = resolve(".cache/ctan");
const SIGLUM_BUNDLES = resolve("public/engines/siglum/bundles");

/**
 * Package names are taken from a URL and used to build a filename, so they are
 * validated rather than sanitised. TeX Live names are conservative: letters,
 * digits, dot, dash, underscore. Anything else is rejected outright.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

let fileToPackage: Record<string, string> | null = null;

async function loadFileToPackage(): Promise<Record<string, string>> {
  if (fileToPackage) return fileToPackage;
  const path = resolve(SIGLUM_BUNDLES, "file-to-package.json");
  fileToPackage = existsSync(path)
    ? (JSON.parse(await readFile(path, "utf8")) as Record<string, string>)
    : {};
  return fileToPackage;
}

/** Map a requested name to the TeX Live package that actually ships it. */
async function resolvePackage(name: string): Promise<string> {
  const index = await loadFileToPackage();
  for (const extension of [".sty", ".cls", ".bst", ".def", ".fd"]) {
    const owner = index[`${name}${extension}`];
    if (owner) return owner;
  }
  return name;
}

interface FetchResult {
  bytes: Buffer;
  fromCache: boolean;
  sha256: string;
}

async function fetchPackage(name: string): Promise<FetchResult | null> {
  const cached = resolve(CACHE_DIR, `${name}.tar.xz`);
  if (existsSync(cached)) {
    const bytes = await readFile(cached);
    return {
      bytes,
      fromCache: true,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  const response = await fetch(`${UPSTREAM}/${name}.tar.xz`);
  if (!response.ok) return null;

  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cached, bytes);
  return {
    bytes,
    fromCache: false,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sendJson(
  res: Parameters<Connect.NextHandleFunction>[1],
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function ctanProxyMiddleware(
  log: (message: string) => void = () => {},
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split("?")[0] ?? "";
    if (!url.startsWith("/ctan/")) {
      next();
      return;
    }

    void (async () => {
      const texlive = /^\/ctan\/api\/(?:texlive|fetch)\/([^/]+)$/.exec(url);
      const lookup = /^\/ctan\/api\/ctan-pkg\/([^/]+)$/.exec(url);

      // Strip a trailing year suffix; Siglum appends one on its CTAN fallback.
      const raw = decodeURIComponent(
        (texlive?.[1] ?? lookup?.[1] ?? "").replace(/-20\d\d$/, ""),
      );

      if (!SAFE_NAME.test(raw)) {
        sendJson(res, 400, { error: "invalid package name" });
        return;
      }

      if (lookup) {
        const owner = await resolvePackage(raw);
        sendJson(res, 200, {
          name: raw,
          ...(owner === raw ? {} : { contained_in: owner }),
        });
        return;
      }

      if (!texlive) {
        sendJson(res, 404, { error: "unknown route" });
        return;
      }

      try {
        // Try the name as given, then the package that ships that file.
        let name = raw;
        let result = await fetchPackage(name);
        if (!result) {
          const owner = await resolvePackage(raw);
          if (owner !== raw) {
            name = owner;
            result = await fetchPackage(name);
          }
        }

        if (!result) {
          log(`[ctan] MISS ${raw} — not in TeX Live 2025`);
          sendJson(res, 404, { error: `package ${raw} not found` });
          return;
        }

        log(
          `[ctan] ${result.fromCache ? "cache" : "fetch"} ${name} ` +
            `${(result.bytes.byteLength / 1024).toFixed(1)} KB sha256=${result.sha256.slice(0, 12)}`,
        );
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-xz");
        // Pinned to a frozen archive, so the bytes for a given name never
        // change and may be cached indefinitely.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.setHeader("X-Opal-Package-Sha256", result.sha256);
        res.end(result.bytes);
      } catch (error) {
        log(`[ctan] ERROR ${raw}: ${String(error)}`);
        sendJson(res, 502, { error: "upstream fetch failed" });
      }
    })();
  };
}
