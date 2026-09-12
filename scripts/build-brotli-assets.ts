/**
 * Pre-compress the engine assets that dominate a first load (ADR-011).
 *
 * After the boot set, a first compile is 69.4 MB and 60.4 MB of it is four
 * artifacts the delivery model cannot touch: the engine, ICU, the format file
 * and the boot package that carries the last two. Those are not *files TeX
 * opens*, they are bytes that must arrive whatever the document says — so the
 * only lever left on them is the transport.
 *
 * Brotli is precomputed rather than negotiated at request time: compressing
 * 33 MB at quality 11 takes minutes, which is fine once in a build and absurd
 * per request. The `.br` sibling sits next to the original and the server picks
 * it when the client says it can decode it.
 *
 * What is *not* compressed here matters as much. Siglum's `.data.gz` bundles
 * are payloads the engine gunzips itself, and ADR-003 records two deployments
 * broken by encoding them again. The same trap applies to texlyre's own tiers,
 * whose `.data` blobs are LZ4-chunked and read by offset — this only touches
 * the files listed below.
 *
 * Usage: pnpm spike:brotli [--quality n] [--write]
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";

const compress = promisify(brotliCompress);

const ROOT = resolve("public/engines/texlyre/busytex");

/**
 * The artifacts worth pre-compressing, and why each one is safe to.
 *
 * Every entry is fetched whole and consumed as bytes by the engine, so a
 * transport encoding the browser removes before the engine sees it is
 * invisible to it. Nothing here is read by byte range: `texlive-extra.data`
 * deliberately is, which is exactly why it is absent.
 */
const TARGETS = [
  "busytex.wasm",
  "texlive-min-xelatex.data",
  "texlive-min-xelatex.js",
];

/**
 * The renderer, which is a build output rather than a downloaded asset.
 *
 * MuPDF's WASM is 10.4 MB and Vite emits it hashed into `dist/assets`, where
 * the preview server does not compress it — measured, it was the largest single
 * response of a first load once the engine was compressed. It is read whole by
 * the worker, so the same reasoning applies.
 */
const DIST_ASSETS = resolve("dist/assets");

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

async function main(): Promise<void> {
  if (!existsSync(ROOT)) {
    throw new Error(
      "texlyre assets missing; run ./scripts/download-texlyre-assets.sh",
    );
  }
  const qualityArg = process.argv.indexOf("--quality");
  const quality = qualityArg === -1 ? 11 : Number(process.argv[qualityArg + 1]);
  const write = process.argv.includes("--write");

  let rawTotal = 0;
  let brTotal = 0;

  const built = existsSync(DIST_ASSETS)
    ? readdirSync(DIST_ASSETS)
        .filter((name) => name.endsWith(".wasm"))
        .map((name) => resolve(DIST_ASSETS, name))
    : [];
  if (built.length === 0) {
    console.log("(no built .wasm in dist/assets; run vite build first)\n");
  }

  for (const path of [...TARGETS.map((n) => resolve(ROOT, n)), ...built]) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!existsSync(path)) {
      console.log(`${name.padEnd(34)} (absent, skipped)`);
      continue;
    }
    const raw = await readFile(path);
    const started = Date.now();
    const compressed = await compress(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: quality,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
      },
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    rawTotal += raw.byteLength;
    brTotal += compressed.byteLength;

    console.log(
      `${name.padEnd(34)} ${mb(raw.byteLength).padStart(9)} -> ` +
        `${mb(compressed.byteLength).padStart(9)} ` +
        `(${Math.round((100 * compressed.byteLength) / raw.byteLength)}%, ${seconds}s)`,
    );

    if (write) await writeFile(`${path}.br`, compressed);
  }

  console.log(
    `\ntotal ${mb(rawTotal)} -> ${mb(brTotal)} ` +
      `(${Math.round((100 * brTotal) / rawTotal)}%), quality ${quality}`,
  );
  if (!write) console.log("\n(--write to emit the .br files)");
}

export { TARGETS };

/** Whether a pre-compressed sibling exists and is newer than its source. */
export function brotliSibling(file: string): string | null {
  const candidate = `${file}.br`;
  if (!existsSync(candidate) || !existsSync(file)) return null;
  return statSync(candidate).mtimeMs >= statSync(file).mtimeMs
    ? candidate
    : null;
}

// Imported by `vite.config.ts` for `brotliSibling`, so the build step only runs
// when this file is the entry point. A config import must not compress 33 MB.
if (process.argv[1]?.endsWith("build-brotli-assets.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
