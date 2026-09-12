/**
 * Build a minimal boot tier for one engine, and let the endpoint do the rest
 * (ADR-011).
 *
 * Preloading nothing does not work: with no tiers mounted the engine dies
 * before kpathsea starts, on `lstat(/bin) failed` and `kpathsea: Can't get
 * directory of program name: /bin/busytex`, having asked the endpoint for
 * nothing at all. Two classes of file cannot come from a remote resolver — the
 * ones read before the resolver exists, and the ones named by absolute path
 * rather than looked up. Everything else can.
 *
 * So the floor is not "a tier"; it is that set. This builds it.
 *
 * The output is an Emscripten data package the engine loads exactly like its
 * own, produced without Emscripten: the `.data` is written as LZ4 chunks that
 * are all *stored* rather than compressed, which the format allows
 * (`successes[i] = 0`), so no compressor is needed — and the loader `.js` is
 * the shipped one with three substitutions, so the parts that are easy to get
 * subtly wrong are not rewritten at all.
 *
 * Usage: pnpm spike:texlive-min [engine] [--write]   (default: xelatex)
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  readPackagedFiles,
  TEXLIVE_ROOT,
  TexliveArchive,
} from "./texlive-index";

/** Emscripten's LZ4 packages are chunked at 2 KiB; a stored chunk is verbatim. */
const CHUNK_SIZE = 2048;

/** The template: its loader is the one the engine already runs. */
const TEMPLATE = resolve(TEXLIVE_ROOT, "texlive-basic.js");

/**
 * What has to be mounted, by engine.
 *
 * Deliberately expressed as paths rather than "a tier": the point of the
 * exercise is that the boot set is small and specific, and that everything
 * outside it is a kpathsea lookup the endpoint can answer.
 *
 * The format file is the reason this is per-engine. `basic` carries four
 * (`xelatex` 5.9 MB, `luahblatex` 5.7 MB, `pdflatex` 3.4 MB, `tex` 0.3 MB) and
 * a compile uses one — ADR-003's "the engine ships four engines and we use one"
 * finding, in bytes.
 */
const FORMATS: Record<string, string> = {
  xelatex: "/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt",
  pdflatex: "/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt",
  lualatex: "/texlive/texmf-dist/texmf-var/web2c/luahbtex/luahblatex.fmt",
};

function bootSet(path: string, engine: string): boolean {
  // kpathsea derives its own location from argv[0]; the file is one byte, and
  // without it nothing starts.
  if (path === "/bin/busytex") return true;
  // fontconfig reads these directly, not through kpathsea.
  if (path.startsWith("/etc/")) return true;
  if (path === "/texlive/fonts.conf") return true;
  // Configuration kpathsea reads to know where anything else lives, so it
  // cannot itself be resolved by kpathsea.
  if (path.endsWith("/texmf.cnf")) return true;
  if (path.includes("/web2c/") && path.endsWith(".tcx")) return true;
  // The format is passed to the binary as an absolute path, never looked up.
  if (path === FORMATS[engine]) return true;
  // ICU's data file is opened by name from inside the XeTeX binary.
  if (path.endsWith("icudt78l.dat")) return true;
  return false;
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

/** Brace-match a JS object literal starting at the first `{` after `from`. */
function literalRange(source: string, from: number): [number, number] {
  const open = source.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return [open, i + 1];
    }
  }
  throw new Error("unterminated literal");
}

async function main(): Promise<void> {
  const engine = process.argv[2]?.startsWith("--")
    ? "xelatex"
    : (process.argv[2] ?? "xelatex");
  const write = process.argv.includes("--write");
  if (!FORMATS[engine]) throw new Error(`unknown engine ${engine}`);

  // Selected from `extra`, not `basic`: it is a superset, so the boot set is
  // the same bytes and the tier that ships it stops mattering.
  const selected = readPackagedFiles("extra").filter((file) =>
    bootSet(file.filename, engine),
  );
  if (selected.length === 0) throw new Error("boot set is empty");

  const archive = new TexliveArchive();
  const chunks: Buffer[] = [];
  const table: { filename: string; start: number; end: number }[] = [];
  let offset = 0;
  try {
    for (const file of selected.sort((a, b) =>
      a.filename < b.filename ? -1 : 1,
    )) {
      const bytes = archive.read(file.start, file.end - file.start);
      chunks.push(bytes);
      table.push({
        filename: file.filename,
        start: offset,
        end: offset + bytes.byteLength,
      });
      offset += bytes.byteLength;
    }
  } finally {
    archive.close();
  }

  const blob = Buffer.concat(chunks);
  console.log(`${engine}: ${table.length} files, ${mb(blob.byteLength)}`);
  for (const file of table) {
    console.log(`  ${mb(file.end - file.start).padStart(9)}  ${file.filename}`);
  }

  const basic = readPackagedFiles("basic");
  const basicBytes = basic.reduce((sum, f) => sum + (f.end - f.start), 0);
  console.log(
    `\nagainst basic: ${table.length}/${basic.length} files, ` +
      `${mb(blob.byteLength)} of ${mb(basicBytes)} uncompressed`,
  );

  if (!write) {
    console.log("\n(--write to emit it)");
    return;
  }

  // Every chunk stored, so the payload is the blob itself and the table just
  // says where the boundaries are.
  const count = Math.ceil(blob.byteLength / CHUNK_SIZE);
  const offsets: number[] = [];
  const sizes: number[] = [];
  const successes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    offsets.push(i * CHUNK_SIZE);
    sizes.push(Math.min(CHUNK_SIZE, blob.byteLength - i * CHUNK_SIZE));
    successes.push(0);
  }

  const template = await import("node:fs/promises").then((fs) =>
    fs.readFile(TEMPLATE, "utf8"),
  );

  // Order in the template is: the directory calls, then the chunk table, then
  // the file table. Splicing them in any other order silently drops the loader
  // glue between them, which fails as a bare SyntaxError inside a worker.
  const CREATE_PATH = "Module['FS_createPath']";
  const createPathsStart = template.indexOf(CREATE_PATH);
  const createPathsEnd =
    template.indexOf(";", template.lastIndexOf(CREATE_PATH)) + 1;
  const [compressedOpen, compressedClose] = literalRange(
    template,
    template.indexOf("var compressedData = {"),
  );
  const loadPackageAt = template.indexOf('loadPackage({"files":');
  const [argOpen, argClose] = literalRange(template, loadPackageAt);
  if (
    !(
      createPathsStart < createPathsEnd &&
      createPathsEnd < compressedOpen &&
      compressedClose < argOpen
    )
  ) {
    throw new Error("template layout changed; the splice would corrupt it");
  }

  // Directories, parent before child, deduplicated — the loader creates files
  // into paths that must already exist.
  const made = new Set<string>();
  const createPaths: string[] = [];
  for (const file of table) {
    const parts = file.filename.split("/").slice(1, -1);
    let parent = "/";
    for (const part of parts) {
      const full = parent === "/" ? `/${part}` : `${parent}/${part}`;
      if (!made.has(full)) {
        made.add(full);
        createPaths.push(
          `Module['FS_createPath'](${JSON.stringify(parent)}, ${JSON.stringify(part)}, true, true);`,
        );
      }
      parent = full;
    }
  }

  // The `.data` is not only the chunks. Emscripten allocates
  // `total + CHUNK_SIZE * 2` and sets `cachedOffset` to `total`, using the tail
  // as scratch for the two decompressed chunks it caches — so the file has to
  // carry that room. Without it the loader stalls part-way through reading the
  // package: `Downloading data... (41380/28023892)` and then nothing, for the
  // full four-minute compile timeout, with no error anywhere.
  const payload = Buffer.concat([blob, Buffer.alloc(CHUNK_SIZE * 2)]);

  const out =
    template.slice(0, createPathsStart) +
    createPaths.join("\n") +
    template.slice(createPathsEnd, compressedOpen) +
    JSON.stringify({
      data: null,
      cachedOffset: blob.byteLength,
      cachedIndexes: [-1, -1],
      cachedChunks: [null, null],
      offsets,
      sizes,
      successes,
    }) +
    template.slice(compressedClose, argOpen) +
    JSON.stringify({ files: table, remote_package_size: payload.byteLength }) +
    template.slice(argClose);

  await mkdir(TEXLIVE_ROOT, { recursive: true });
  await writeFile(resolve(TEXLIVE_ROOT, `texlive-min-${engine}.data`), payload);
  await writeFile(
    resolve(TEXLIVE_ROOT, `texlive-min-${engine}.js`),
    out.replaceAll("texlive-basic.data", `texlive-min-${engine}.data`),
    "utf8",
  );
  console.log(
    `\nWritten texlive-min-${engine}.js and .data to ${TEXLIVE_ROOT}`,
  );
}

if (!existsSync(TEMPLATE)) {
  throw new Error(
    "texlyre assets missing; run ./scripts/download-texlyre-assets.sh",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
