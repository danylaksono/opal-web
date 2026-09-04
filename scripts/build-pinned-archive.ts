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
 * - `macros` — every runtime macro in TeX Live and no fonts. Ends discovery:
 *   a package that loads its own files and catches the failure reports no
 *   filename, so nothing can resolve it on demand.
 * - `latin`  — every runtime macro in TeX Live, plus metrics, encodings, maps
 *   and Type 1 outlines for Latin-script families. No discovery chain: nothing
 *   a Latin-script document opens is absent.
 * - `full`   — the whole tree, 2.6 GB, for reference rather than for shipping.
 *
 * Usage: pnpm spike:pinned-archive [--scope corpus|latin|full] [--fetch]
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

/** How many range requests to keep in flight against the upstream host. */
const CONCURRENCY = 16;

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
    // Every runtime macro in the tree and no fonts. This is the tier that ends
    // discovery: a package that loads its own auxiliary files and catches the
    // failure itself — `listings` asking for its aspects, and reporting only
    // "Couldn't load requested aspect" — cannot be resolved from an error
    // message, so the only fix is for the file to be there already.
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
async function fetchAll(selected: Entry[]): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const out = createWriteStream(ARCHIVE);
  const index: string[] = [];
  let offset = 0;
  let done = 0;
  let failed = 0;

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
        if (response.status !== 206)
          throw new Error(`status ${response.status}`);
        results[i] = new Uint8Array(await response.arrayBuffer());
      } catch {
        results[i] = null;
        failed++;
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
  console.log(`\nFetching ${selected.length} files, ${CONCURRENCY} at a time.`);
  await fetchAll(selected);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
