/**
 * Build an indexed TeX archive from one pinned TeX Live tree (ADR-011, ADR-003).
 *
 * `build-tex-archive.ts` builds an archive out of Siglum's bundles, which is
 * useful for measuring delivery but useless as a package set: ADR-003 found
 * those bundles span five TeX Live vintages and are missing packages the corpus
 * needs. This builds from a single vintage instead — Tectonic's published
 * bundle, which is the tree the desktop app compiles against, so comparing our
 * output against desktop's stops comparing two package sets as well as two
 * engines.
 *
 * **The source is a flat tar.** Its sidecar index is `<name> <offset> <length>`
 * and the offsets point at file data; the 512 bytes before each one are a tar
 * header whose name field is the bare basename. There are no directories in it
 * at all, which means TeX Live paths cannot be recovered from this bundle and
 * have to be synthesised. That is fine, and is what `texmfPath` does: kpathsea
 * searches by file *type* across a search path, so what matters is that a
 * `.tfm` lands somewhere under `fonts/tfm/` and a `.sty` under `tex/latex/`,
 * not which package subdirectory it sits in. Siglum's own CTAN fetcher places
 * unrecognised files the same way, and those resolve today.
 *
 * **Scopes.** Sizes are computed from the index without downloading anything,
 * so `--scope x` with no `--fetch` prints what a tier would cost:
 *
 * - `corpus` — every macro file the corpus is known to open or to have reported
 *   missing. Small, and enough to test whether one vintage fixes the documents
 *   that version skew broke.
 * - `macros` — every runtime macro in TeX Live and no fonts. Built to end the
 *   discovery chain, and measured not to: while files arrive because TeX
 *   reported them missing, a package that catches its own failure still
 *   resolves nothing. Useful only once the engine reads from the archive.
 * - `latin`  — every runtime macro in TeX Live, plus metrics, encodings, maps
 *   and Type 1 outlines for Latin-script families. No discovery chain: nothing
 *   a Latin-script document opens is absent.
 * - `full`   — the whole tree, 2.6 GB, for reference rather than for shipping.
 *
 * Usage: pnpm spike:pinned-archive [--scope corpus|macros|latin|full]
 *        [--fetch] [--via range|whole]
 */
import {
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const BUNDLE_URL =
  process.env.OPAL_PINNED_BUNDLE ??
  "https://data1.fullyjustified.net/tlextras-2022.0r0.tar";
const INDEX_FILE = resolve(".cache/tectonic/index.txt");
const LOG_DIR = resolve("spike-results/logs");
const OUT_DIR = resolve("public/tex-pinned");
const ARCHIVE = resolve(OUT_DIR, "texfiles.bin");
const INDEX_OUT = resolve(OUT_DIR, "texfiles.index");

/**
 * How many range requests to keep in flight against the upstream host.
 *
 * Low on purpose. The bundle is served by a volunteer-run host that rate-limits:
 * sixteen in flight earned HTTP 429 on every request and then a block lasting
 * minutes. Range fetching suits small scopes; anything large should use
 * `--via whole`, which asks for the archive once rather than tens of thousands
 * of times.
 */
const CONCURRENCY = 4;

/** Consecutive failures after which a run is being refused, not unlucky. */
const FAILURE_LIMIT = 20;

interface Entry {
  name: string;
  offset: number;
  length: number;
}

/** Extensions TeX reads while typesetting, as opposed to documentation. */
const RUNTIME_MACROS = new Set([
  "sty",
  "cls",
  "def",
  "cfg",
  "clo",
  "fd",
  "tex",
  "ltx",
  "code",
  "bst",
  "cbx",
  "bbx",
  "lbx",
  "ldf",
  "dict",
  "tikz",
  "sub",
  "rtx",
  "opm",
  "cnf",
  "mkii",
  "mkiv",
  "pool",
  "ini",
  "lua",
]);

/**
 * Latin-script font families, by the prefix their filenames are built from.
 *
 * Fonts are 81% of this tree — 1,346 MB of outlines against 249 MB of macros —
 * and almost all of that is CJK and exotic scripts. Scoping fonts is therefore
 * the whole of scoping the archive; scoping macros saves little and costs the
 * property worth having.
 */
const LATIN_FAMILIES =
  /^(lm|cm|ec|tc|sf|cs|p(ag|bk|cr|hv|nc|pl|tm|zc|zd)|u(ag|bk|cr|hv|nc|pl|tm|zc|zd)|q(ag|bk|cr|cs|hv|pl|tm|zc)|Latin|FontAwesome|txr|txb|pxr|zi4)/i;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The published index, one entry per file in the bundle. */
function readIndex(): Entry[] {
  if (!existsSync(INDEX_FILE)) {
    throw new Error(
      `No index at ${INDEX_FILE}. Fetch ${BUNDLE_URL}.index.gz and gunzip it there.`,
    );
  }
  const entries: Entry[] = [];
  for (const line of readFileSync(INDEX_FILE, "utf8").split("\n")) {
    const parts = line.split(" ");
    if (parts.length !== 3) continue;
    const [name, offset, length] = parts;
    if (!name) continue;
    const start = Number(offset);
    const size = Number(length);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size)) continue;
    entries.push({ name, offset: start, length: size });
  }
  return entries;
}

/**
 * Every file name the corpus is known to touch.
 *
 * Both what TeX recorded opening and what it reported missing: the second set
 * is the point, since those are the files Siglum's bundles do not have.
 */
function corpusNames(): Set<string> {
  const names = new Set<string>();
  if (!existsSync(LOG_DIR)) return names;
  for (const file of readdirSync(LOG_DIR)) {
    const text = readFileSync(resolve(LOG_DIR, file), "utf8");
    for (const match of text.matchAll(/\((\/texlive\/[^\s()]+)/g)) {
      const path = match[1];
      if (path) names.add(path.slice(path.lastIndexOf("/") + 1));
    }
    for (const match of text.matchAll(/File `([^']+)' not found/g)) {
      if (match[1]) names.add(match[1]);
    }
    for (const match of text.matchAll(/I can't find file `([^']+)'/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return names;
}

/**
 * A name without its `.tex`, since that is how TeX asks for it.
 *
 * LaTeX appends the default extension when searching, so a document that wants
 * `lipsum.ltd.tex` reports `lipsum.ltd` missing. Matching both spellings is
 * what puts the file in the archive under the name it is stored by.
 */
function dropTexSuffix(name: string): string {
  return name.endsWith(".tex") ? name.slice(0, -4) : name;
}

function selectScope(entries: Entry[], scope: string): Entry[] {
  if (scope === "full") return entries;
  if (scope === "macros") {
    // Every runtime macro in the tree and no fonts. Built to end the discovery
    // chain — `listings` catches its own missing-file failure and reports only
    // "Couldn't load requested aspect", which no on-demand resolver can act on
    // — and measured not to: the corpus compiles the same 9 of 13 as the 4.8 MB
    // tier. A complete archive is not a complete filesystem while files arrive
    // only when TeX asks for them by name.
    return entries.filter((entry) =>
      RUNTIME_MACROS.has(extensionOf(entry.name)),
    );
  }
  if (scope === "latin") {
    return entries.filter((entry) => {
      const ext = extensionOf(entry.name);
      if (RUNTIME_MACROS.has(ext)) return true;
      if (ext === "enc" || ext === "map") return true;
      if (["tfm", "vf", "pfb"].includes(ext)) {
        return LATIN_FAMILIES.test(entry.name);
      }
      return false;
    });
  }
  const wanted = corpusNames();
  if (wanted.size === 0) {
    throw new Error("No corpus logs; run pnpm spike:corpus-run first");
  }
  // No extension filter: the name list is already the scope, and filtering it
  // again by type drops the data files packages read beside their macros.
  // `lipsum.ltd.tex` is one, and without it `lipsum` fails having loaded fine.
  return entries.filter(
    (entry) => wanted.has(entry.name) || wanted.has(dropTexSuffix(entry.name)),
  );
}

/**
 * Where to put a file so that kpathsea finds it.
 *
 * By type, not by package, because the source bundle records no package and
 * kpathsea searches by type anyway. `pinned` is a single directory per type:
 * a search path does not care how many directories it walks, and one per
 * package would only invent structure the source never had.
 */
export function texmfPath(name: string): string {
  const root = "/texlive/texmf-dist";
  const ext = extensionOf(name);
  if (ext === "tfm") return `${root}/fonts/tfm/pinned/${name}`;
  if (ext === "vf") return `${root}/fonts/vf/pinned/${name}`;
  if (ext === "pfb" || ext === "pfa")
    return `${root}/fonts/type1/pinned/${name}`;
  if (ext === "otf") return `${root}/fonts/opentype/pinned/${name}`;
  if (ext === "ttf") return `${root}/fonts/truetype/pinned/${name}`;
  if (ext === "afm") return `${root}/fonts/afm/pinned/${name}`;
  if (ext === "enc") return `${root}/fonts/enc/pinned/${name}`;
  if (ext === "map") return `${root}/fonts/map/pinned/${name}`;
  if (ext === "bst") return `${root}/bibtex/bst/pinned/${name}`;
  // Generic rather than latex for plain-TeX inputs: `tex/generic` is on the
  // search path for both, and pgf reaches for its `.tex` files that way.
  if (ext === "tex" || ext === "tikz" || ext === "code") {
    return `${root}/tex/generic/pinned/${name}`;
  }
  return `${root}/tex/latex/pinned/${name}`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** One range request per file, into the output stream, in index order. */
/** Tar headers are 512 bytes, and every entry is padded to a multiple. */
const TAR_BLOCK = 512;

/**
 * Build the archive from a single sequential download.
 *
 * One request instead of one per file. That is politeness as much as speed: the
 * bundle is hosted by a volunteer project, and asking it for 19,222 byte ranges
 * is an unreasonable way to read a file it will happily send once — sixteen
 * concurrent ranges earned HTTP 429 on every request and then a block.
 *
 * The whole 2.6 GB streams past, but only files in scope are kept, so the
 * archive written is the size of the scope rather than of the source. Parsing
 * is just walking header blocks, since the tar is flat: the name is the first
 * 100 bytes and the size a 12-byte octal field at offset 124.
 */
async function fetchWhole(selected: Entry[]): Promise<void> {
  const wanted = new Set(selected.map((entry) => entry.name));
  await mkdir(OUT_DIR, { recursive: true });
  const out = createWriteStream(ARCHIVE);
  const index: string[] = [];
  let offset = 0;
  let kept = 0;
  let seen = 0;
  let read = 0;

  const response = await fetch(BUNDLE_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Bundle fetch failed: ${response.status}`);
  }

  // A rolling buffer, because a tar entry rarely aligns with a network chunk.
  let buffer = new Uint8Array(0);
  let pending: { name: string; size: number } | null = null;
  const decoder = new TextDecoder();
  const field = (bytes: Uint8Array): string => {
    const text = decoder.decode(bytes);
    const end = text.indexOf("\0");
    return (end === -1 ? text : text.slice(0, end)).trim();
  };

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const grown = new Uint8Array(buffer.length + chunk.length);
    grown.set(buffer);
    grown.set(chunk, buffer.length);
    buffer = grown;
    read += chunk.length;

    for (;;) {
      if (!pending) {
        if (buffer.length < TAR_BLOCK) break;
        const header = buffer.subarray(0, TAR_BLOCK);
        buffer = buffer.subarray(TAR_BLOCK);
        const name = field(header.subarray(0, 100));
        const size = Number.parseInt(
          field(header.subarray(124, 136)) || "0",
          8,
        );
        // Two zero blocks end the archive; anything nameless is padding.
        if (!name || !Number.isFinite(size)) continue;
        seen++;
        pending = { name, size };
      }
      // Entries are padded to a block boundary; the padding is not content.
      const padded = Math.ceil(pending.size / TAR_BLOCK) * TAR_BLOCK;
      if (buffer.length < padded) break;
      if (pending.size > 0 && wanted.has(pending.name)) {
        const bytes = buffer.slice(0, pending.size);
        if (!out.write(bytes)) {
          await new Promise<void>((r) => out.once("drain", () => r()));
        }
        index.push(
          `${pending.name} ${offset} ${bytes.length} ${texmfPath(pending.name)}`,
        );
        offset += bytes.length;
        kept++;
      }
      buffer = buffer.subarray(padded);
      pending = null;
      if (seen % 20000 === 0) {
        process.stdout.write(
          `  ${seen} entries, ${kept} kept, ${(read / 1048576).toFixed(0)} MB read\n`,
        );
      }
    }
  }

  await new Promise<void>((finished, reject) => {
    out.on("error", reject);
    out.end(() => {
      finished();
    });
  });
  await writeFile(INDEX_OUT, `${index.join("\n")}\n`, "utf8");
  console.log(
    `\n${kept} of ${selected.length} wanted files found in ${seen} entries\n` +
      `archive ${megabytes((await stat(ARCHIVE)).size)} at ${ARCHIVE}\n` +
      `index   ${((await stat(INDEX_OUT)).size / 1024).toFixed(0)} KB at ${INDEX_OUT}`,
  );
}

async function fetchAll(selected: Entry[]): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const out = createWriteStream(ARCHIVE);
  const index: string[] = [];
  let offset = 0;
  let done = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  // Fetched in parallel but written in order: the archive's own offsets are
  // assigned as bytes are appended, so writes cannot race.
  const results = new Array<Uint8Array | null>(selected.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const entry = selected[i];
      if (!entry) return;
      try {
        const response = await fetch(BUNDLE_URL, {
          headers: {
            Range: `bytes=${entry.offset}-${entry.offset + entry.length - 1}`,
          },
        });
        if (response.status === 429) throw new Error("rate limited (429)");
        if (response.status !== 206)
          throw new Error(`status ${response.status}`);
        results[i] = new Uint8Array(await response.arrayBuffer());
        consecutiveFailures = 0;
      } catch (error) {
        results[i] = null;
        failed++;
        // Stop rather than grind through thousands of doomed requests and then
        // write an empty archive: this many failures in a row is a host
        // refusing the rate, and continuing is both useless and rude.
        if (++consecutiveFailures >= FAILURE_LIMIT) {
          throw new Error(
            `${consecutiveFailures} consecutive failures (last: ` +
              `${error instanceof Error ? error.message : "unknown"}). ` +
              "Use --via whole, which asks for the archive once.",
          );
        }
      }
      done++;
      if (done % 250 === 0) {
        process.stdout.write(`  ${done}/${selected.length} fetched\n`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () =>
      worker(),
    ),
  );

  for (const [i, entry] of selected.entries()) {
    const bytes = results[i];
    if (!bytes || bytes.length === 0) continue;
    if (!out.write(bytes)) {
      await new Promise<void>((r) => out.once("drain", () => r()));
    }
    index.push(
      `${entry.name} ${offset} ${bytes.length} ${texmfPath(entry.name)}`,
    );
    offset += bytes.length;
  }

  await new Promise<void>((done_, reject) => {
    out.on("error", reject);
    out.end(() => {
      done_();
    });
  });
  await writeFile(INDEX_OUT, `${index.join("\n")}\n`, "utf8");

  const archiveSize = (await stat(ARCHIVE)).size;
  console.log(
    `\n${index.length} files written, ${failed} failed\n` +
      `archive ${megabytes(archiveSize)} at ${ARCHIVE}\n` +
      `index   ${((await stat(INDEX_OUT)).size / 1024).toFixed(0)} KB at ${INDEX_OUT}`,
  );
}

async function main(): Promise<void> {
  const at = process.argv.indexOf("--scope");
  const scope = at === -1 ? "corpus" : (process.argv[at + 1] ?? "corpus");
  const fetching = process.argv.includes("--fetch");

  const entries = readIndex();
  const selected = selectScope(entries, scope);
  const bytes = selected.reduce((sum, entry) => sum + entry.length, 0);
  const total = entries.reduce((sum, entry) => sum + entry.length, 0);

  console.log(`source ${BUNDLE_URL}`);
  console.log(
    `whole tree     ${String(entries.length).padStart(7)} files ${megabytes(total).padStart(9)}`,
  );
  console.log(
    `scope ${scope.padEnd(9)}${String(selected.length).padStart(7)} files ${megabytes(bytes).padStart(9)}`,
  );

  if (!fetching) {
    console.log("\nSizing only. Pass --fetch to build it.");
    return;
  }
  // One request per file is fine for a small scope and abusive for a large one,
  // so the default follows the scope rather than the caller's memory.
  const viaAt = process.argv.indexOf("--via");
  const via =
    (viaAt === -1 ? undefined : process.argv[viaAt + 1]) ??
    (selected.length > 1000 ? "whole" : "range");

  if (via === "whole") {
    console.log(
      `\nStreaming the archive once, keeping ${selected.length} files.`,
    );
    await fetchWhole(selected);
    return;
  }
  console.log(`\nFetching ${selected.length} files, ${CONCURRENCY} at a time.`);
  await fetchAll(selected);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
