import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * An index of the TeX Live 2026 tree texlyre-busytex ships (ADR-011).
 *
 * The tiers are Emscripten file-packager output: a `.data` blob plus a `.js`
 * that records every file's byte range inside it. That is already the
 * indexed-archive format this ADR settled on — an archive and an offset table —
 * so there is nothing to repack. Reading the offsets out of the `.js` turns
 * 636 MB of preloaded tiers into an addressable tree, and the endpoint serves
 * one file per request out of it.
 *
 * The blob is LZ4-chunked rather than flat, which makes it *better* for this
 * than a plain archive would be; see `TexliveArchive` at the foot of the file.
 *
 * `extra` is a strict superset of `recommended`, which is a strict superset of
 * `basic` (checked: 7,185 ⊂ 13,236 ⊂ 23,883 files, no exceptions), so one
 * index over `texlive-extra.data` addresses everything any tier holds. The
 * smaller tiers stay useful as a preload floor, not as separate archives.
 */

export const TEXLIVE_ROOT = resolve("public/engines/texlyre/busytex");

/** The tier that contains every file, and therefore the one worth indexing. */
export const ARCHIVE_TIER = "extra";

export interface IndexEntry {
  /** Byte offset into the tier's `.data` file. */
  start: number;
  /** Byte length. */
  length: number;
  /** Where the file sits in the TeX Live tree, for disambiguation and logs. */
  path: string;
}

interface PackagedFile {
  filename: string;
  start: number;
  end: number;
}

/**
 * Pull the file table out of a data package.
 *
 * The `.js` is a script, not a data format, so the table is extracted by
 * finding the `loadPackage({"files":` call and brace-matching its argument.
 * Anchoring on that exact string matters: the file contains other
 * `loadPackage(` references, and the first one is not the call.
 */
export function readPackagedFiles(tier: string): PackagedFile[] {
  const source = readFileSync(resolve(TEXLIVE_ROOT, `texlive-${tier}.js`), {
    encoding: "utf8",
  });
  const anchor = 'loadPackage({"files":';
  const at = source.indexOf(anchor);
  if (at === -1) throw new Error(`no file table in texlive-${tier}.js`);

  const open = at + "loadPackage(".length;
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i + 1;
        break;
      }
    }
  }
  if (close === -1) throw new Error(`unterminated file table in ${tier}.js`);

  return (JSON.parse(source.slice(open, close)) as { files: PackagedFile[] })
    .files;
}

/**
 * How much a candidate path should be avoided when two files share a name.
 *
 * 383 of 23,446 names collide. The rule reproduces what a default TeX Live
 * install resolves rather than picking arbitrarily: `article.cls` must come
 * from `tex/latex/base`, not from `tex/latex-dev/base`, and `fonts.conf` from
 * the distribution rather than from `texmf-var`, which is generated state.
 * Within a tie, the shorter path wins, which prefers the canonical location
 * over a bundled copy.
 */
function penalty(path: string): number {
  let score = 0;
  if (path.includes("/latex-dev/")) score += 100;
  if (path.includes("/texmf-var/")) score += 50;
  if (!path.includes("/texmf-dist/")) score += 10;
  return score;
}

/**
 * Build a name-to-range index.
 *
 * Keyed by base name because that is what the engine asks for: kpathsea hands
 * the endpoint a bare filename, having already rejected anything containing a
 * slash.
 */
export function buildIndex(
  tier: string = ARCHIVE_TIER,
): Map<string, IndexEntry> {
  const index = new Map<string, IndexEntry>();
  const chosen = new Map<string, number>();

  for (const file of readPackagedFiles(tier)) {
    const name = basename(file.filename);
    const score = penalty(file.filename);
    const incumbent = chosen.get(name);
    if (
      incumbent !== undefined &&
      (incumbent < score ||
        (incumbent === score &&
          (index.get(name)?.path.length ?? 0) <= file.filename.length))
    ) {
      continue;
    }
    chosen.set(name, score);
    index.set(name, {
      start: file.start,
      length: file.end - file.start,
      path: file.filename,
    });
  }

  return index;
}

/** `<name> <offset> <length> <path>`, the format ADR-011 already reads. */
export function formatIndex(index: Map<string, IndexEntry>): string {
  const lines: string[] = [];
  for (const [name, entry] of [...index].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    lines.push(`${name} ${entry.start} ${entry.length} ${entry.path}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The tier is not a flat blob; it is a chunked, compressed, randomly
 * addressable archive already.
 *
 * Emscripten's `-sLZ4` file packager splits the virtual filesystem into fixed
 * 2 KiB chunks and LZ4-compresses each one independently, recording where every
 * compressed chunk starts. The offsets in the file table are into the
 * *uncompressed* stream. So reading one file means decompressing the two or
 * three chunks it spans — not the 341.6 MB tier, and not a repacked copy of it.
 *
 * That is worth stating plainly, because it is the thing ADR-011 set out to
 * build: a static archive, an index, and a byte range per file. It ships inside
 * the engine's own assets.
 */
const CHUNK_SIZE = 2048;

interface ChunkTable {
  offsets: number[];
  sizes: number[];
  /** 0 where a chunk was stored raw because compressing it did not pay. */
  successes: number[];
}

export function readChunkTable(tier: string = ARCHIVE_TIER): ChunkTable {
  const source = readFileSync(resolve(TEXLIVE_ROOT, `texlive-${tier}.js`), {
    encoding: "utf8",
  });
  const at = source.indexOf("var compressedData = {");
  if (at === -1) throw new Error(`texlive-${tier}.data is not LZ4-packed`);
  const open = source.indexOf("{", at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i + 1;
        break;
      }
    }
  }
  if (close === -1) throw new Error(`unterminated chunk table in ${tier}.js`);
  return JSON.parse(source.slice(open, close)) as ChunkTable;
}

/**
 * Decompress one LZ4 block.
 *
 * The block format, not the framed one: a token byte splitting literal and
 * match lengths into a nibble each, 255-extension bytes for either when the
 * nibble saturates, and a little-endian back-reference offset. Matches may
 * overlap their own output, which is how LZ4 encodes runs, so the copy is
 * byte-by-byte rather than a block move.
 */
export function decompressBlock(src: Buffer, outLength: number): Buffer {
  const out = Buffer.allocUnsafe(outLength);
  let ip = 0;
  let op = 0;

  while (ip < src.length) {
    const token = src[ip++] as number;

    let literals = token >> 4;
    if (literals === 15) {
      let next: number;
      do {
        next = src[ip++] as number;
        literals += next;
      } while (next === 255);
    }
    src.copy(out, op, ip, ip + literals);
    ip += literals;
    op += literals;
    if (ip >= src.length) break;

    const offset = (src[ip++] as number) | ((src[ip++] as number) << 8);
    let match = token & 0xf;
    if (match === 15) {
      let next: number;
      do {
        next = src[ip++] as number;
        match += next;
      } while (next === 255);
    }
    match += 4;

    let from = op - offset;
    for (let i = 0; i < match; i += 1) out[op++] = out[from++] as number;
  }

  return op === outLength ? out : out.subarray(0, op);
}

/**
 * Random access into a tier, one file at a time.
 *
 * Holds the chunk table and an open descriptor; reads only the compressed
 * bytes of the chunks a range touches. A one-chunk cache is enough because TeX
 * asks for whole files and consecutive files usually share a chunk boundary.
 */
export class TexliveArchive {
  readonly #fd: number;
  readonly #table: ChunkTable;
  #cachedIndex = -1;
  #cachedChunk: Buffer | null = null;

  constructor(tier: string = ARCHIVE_TIER) {
    this.#fd = openSync(resolve(TEXLIVE_ROOT, `texlive-${tier}.data`), "r");
    this.#table = readChunkTable(tier);
  }

  #chunk(index: number): Buffer {
    if (this.#cachedIndex === index && this.#cachedChunk) {
      return this.#cachedChunk;
    }
    const offset = this.#table.offsets[index] as number;
    const size = this.#table.sizes[index] as number;
    const compressed = Buffer.allocUnsafe(size);
    readSync(this.#fd, compressed, 0, size, offset);
    const chunk = this.#table.successes[index]
      ? decompressBlock(compressed, CHUNK_SIZE)
      : compressed;
    this.#cachedIndex = index;
    this.#cachedChunk = chunk;
    return chunk;
  }

  read(start: number, length: number): Buffer {
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    let position = start;
    while (written < length) {
      const index = Math.floor(position / CHUNK_SIZE);
      const within = position % CHUNK_SIZE;
      const chunk = this.#chunk(index);
      const take = Math.min(length - written, CHUNK_SIZE - within);
      // Advanced by what was actually copied, not by what was asked for. The
      // last chunk of a tier is short, and `copy` silently clamps to it — so a
      // request that ran past the end would leave the tail of this buffer as
      // whatever `allocUnsafe` handed back, and report it as file content. A
      // well-formed index never asks for those bytes, which is exactly why the
      // failure would be silent if one ever did.
      const copied = chunk.copy(out, written, within, within + take);
      if (copied === 0) {
        throw new Error(
          `chunk ${index} ended at ${chunk.length} before offset ${within}`,
        );
      }
      written += copied;
      position += copied;
    }
    return out;
  }

  close(): void {
    closeSync(this.#fd);
  }
}
