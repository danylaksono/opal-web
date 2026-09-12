/**
 * Size and emit the index for the TeX Live 2026 tree (ADR-011).
 *
 * The archive itself is not built: `texlive-extra.data` already is one, and it
 * is a strict superset of the smaller tiers. What a deployment would have to
 * ship alongside it is this index, so the number that matters is how big it is
 * — ADR-011 records the Tectonic index at a fixed 1.28 MB before any document
 * compiles, which is the one place file-shaped delivery is worse than bundles
 * for a trivial document.
 *
 * Usage: pnpm spike:texlive-index [--write]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  ARCHIVE_TIER,
  buildIndex,
  formatIndex,
  readPackagedFiles,
} from "./texlive-index";

const OUT_DIR = resolve("public/texlive");
const OUT_FILE = resolve(OUT_DIR, "texlive-2026.index");

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");

  for (const tier of ["basic", "recommended", "extra"]) {
    const files = readPackagedFiles(tier);
    const bytes = files.reduce((sum, file) => sum + (file.end - file.start), 0);
    console.log(
      `${tier.padEnd(12)} ${String(files.length).padStart(6)} files  ${mb(bytes)}`,
    );
  }

  const index = buildIndex();
  const text = formatIndex(index);
  const raw = Buffer.byteLength(text);
  const gzipped = gzipSync(text, { level: 9 }).byteLength;

  console.log(
    `\nindex over texlive-${ARCHIVE_TIER}.data: ${index.size} names, ` +
      `${mb(raw)} raw, ${mb(gzipped)} gzipped`,
  );

  if (!write) {
    console.log("\n(--write to emit it)");
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, text, "utf8");
  console.log(`Written to ${OUT_FILE}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
