/**
 * Build an indexed TeX archive from the engine's bundles (ADR-011).
 *
 * Turns bundle-shaped delivery into file-shaped delivery without needing a TeX
 * Live installation: the bundles already contain every file, and
 * `file-manifest.json` already records where each one sits inside them. This
 * decompresses each bundle once, writes every file into a single flat archive,
 * and records `<name> <offset> <length> <path>` — Tectonic's published index
 * plus a field, and the client in `indexed-bundle.ts` reads either.
 *
 * The extra field is the file's location in the TeX Live tree. Tectonic does
 * not need one because its engine asks the bundle for a name and takes back
 * bytes; we inject files into an engine's filesystem instead, and where a file
 * lands decides whether TeX finds it — kpathsea searches by file type, so a
 * `.tfm` written under `tex/latex/` is a `.tfm` that does not exist.
 *
 * The output is large and gitignored. It is a build artifact of assets that are
 * themselves downloaded, not a source of truth: the archive worth shipping is
 * one built from a single pinned TeX Live tree, which is ADR-003's version-skew
 * decision. This exists to prove the delivery model against real files first.
 *
 * Usage: pnpm spike:tex-archive
 */
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const BUNDLES = resolve("public/engines/siglum/bundles");
const OUT_DIR = resolve("public/tex");
const ARCHIVE = resolve(OUT_DIR, "texfiles.bin");
const INDEX = resolve(OUT_DIR, "texfiles.index");

interface ManifestEntry {
  bundle: string;
  start: number;
  end: number;
}

/**
 * Files worth putting in the archive.
 *
 * The precompiled formats are excluded: a 20 MB `.fmt` is not something a
 * document opens by name, and including it would put a fifth of the archive
 * behind a file nothing ever range-requests.
 */
function isArchivable(path: string): boolean {
  return !path.endsWith(".fmt");
}

async function main(): Promise<void> {
  if (!existsSync(BUNDLES)) {
    throw new Error(
      "Engine bundles missing; run ./scripts/download-siglum-assets.sh first",
    );
  }

  const manifest = JSON.parse(
    readFileSync(resolve(BUNDLES, "file-manifest.json"), "utf8"),
  ) as Record<string, ManifestEntry>;

  // Grouped by bundle so each one is decompressed exactly once. Decompressing
  // per file would inflate cm-super 409 times.
  const byBundle = new Map<string, [string, ManifestEntry][]>();
  for (const [path, entry] of Object.entries(manifest)) {
    if (!isArchivable(path)) continue;
    const group = byBundle.get(entry.bundle) ?? [];
    group.push([path, entry]);
    byBundle.set(entry.bundle, group);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const out = createWriteStream(ARCHIVE);
  const index: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let written = 0;
  let skipped = 0;

  for (const [bundle, files] of [...byBundle].sort()) {
    const bundlePath = resolve(BUNDLES, `${bundle}.data.gz`);
    if (!existsSync(bundlePath)) {
      skipped += files.length;
      continue;
    }
    const data = gunzipSync(readFileSync(bundlePath));

    for (const [path, entry] of files) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      // TeX resolves by name across a search path, so the archive is keyed by
      // name and the first entry wins — the same shadowing a search path does.
      if (seen.has(name)) continue;
      const bytes = data.subarray(entry.start, entry.end);
      if (bytes.length === 0) continue;
      seen.add(name);

      if (!out.write(bytes)) {
        await new Promise<void>((r) => out.once("drain", () => r()));
      }
      index.push(`${name} ${offset} ${bytes.length} ${path}`);
      offset += bytes.length;
      written++;
    }
    process.stdout.write(
      `${bundle.padEnd(22)} ${String(files.length).padStart(5)} files, ` +
        `archive now ${(offset / 1024 / 1024).toFixed(1)} MB\n`,
    );
  }

  // `end` is asynchronous, and the index must not be written against an
  // archive whose last bytes are still buffered.
  await new Promise<void>((resolve, reject) => {
    out.on("error", reject);
    out.end(() => {
      resolve();
    });
  });

  await writeFile(INDEX, `${index.join("\n")}\n`, "utf8");

  const archiveSize = (await stat(ARCHIVE)).size;
  const indexSize = (await stat(INDEX)).size;
  console.log(
    `\n${written} files, ${skipped} skipped for a missing bundle\n` +
      `archive ${(archiveSize / 1024 / 1024).toFixed(1)} MB at ${ARCHIVE}\n` +
      `index   ${(indexSize / 1024).toFixed(0)} KB at ${INDEX}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
