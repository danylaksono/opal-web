/**
 * Reading TeX support files out of an indexed archive (ADR-011).
 *
 * The archive is a single static file. An index says where each TeX file lives
 * inside it, and a client fetches one with an HTTP range request. Nothing runs
 * on the server: an index and byte offsets, which is why this works from the
 * same static hosting the app itself uses and satisfies ADR-001's requirement
 * that runtime assets come from an origin we control.
 *
 * This replaces bundle-shaped delivery, where the engine downloads a whole
 * bundle to reach one file inside it — 57.2 MB of `cm-super` for a few font
 * faces. Measured against the corpus, `presentation-beamer` reads 2.1 MB of TeX
 * files and currently transfers 118.9 MB to get them.
 *
 * Two index formats exist. The one Tectonic publishes today is a plain text
 * sidecar next to an uncompressed tar; `.ttb` is its documented successor,
 * which stores each file gzipped and puts the index inside the archive. Both
 * are parsed here because the format is a deployment choice we should be able
 * to change without touching anything above this module.
 */

/** Where one file sits inside the archive. */
export interface FileLocation {
  /** Byte offset of the file's first byte within the archive. */
  offset: number;
  /** Bytes to request. Compressed length when `gzipped` is true. */
  length: number;
  /** Decompressed length, when the format records one. */
  realLength?: number;
  /** Whether those bytes need inflating before use. */
  gzipped: boolean;
}

export type TexFileIndex = ReadonlyMap<string, FileLocation>;

/**
 * Parse the sidecar index of an uncompressed indexed tar.
 *
 * One file per line, `<name> <offset> <length>`, and names are bare basenames
 * rather than paths — which matches how TeX looks files up, by name across a
 * search path, rather than by location. Verified against Tectonic's published
 * bundle: 134,980 entries in 1.28 MB gzipped.
 *
 * A name may not contain spaces in this format, so splitting from the right is
 * unnecessary here; the two trailing fields are taken from the end anyway, so a
 * malformed line with extra fields is rejected rather than misread.
 */
export function parseTarIndex(text: string): TexFileIndex {
  const index = new Map<string, FileLocation>();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split(" ");
    if (parts.length !== 3) continue;
    const [name, offset, length] = parts;
    if (!name) continue;
    const start = Number(offset);
    const size = Number(length);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size)) continue;
    if (start < 0 || size < 0) continue;
    index.set(name, { offset: start, length: size, gzipped: false });
  }
  return index;
}

/** Bytes at the head of a `.ttb` archive that describe where its index is. */
export interface TtbHeader {
  version: number;
  indexOffset: number;
  indexLength: number;
  indexRealLength: number;
}

/** `tectonicbundle`, at the start of every `.ttb` whatever its version. */
const TTB_MAGIC = "tectonicbundle";
export const TTB_HEADER_BYTES = 66;

/**
 * Parse a `.ttb` header.
 *
 * Little-endian throughout: 14 magic bytes, a `u32` version, a `u64` index
 * offset, two `u32` index lengths, then a 32-byte content hash this does not
 * check — the transport is HTTPS from our own origin, and a hash we compute
 * from the same response that carried it proves nothing on its own.
 */
export function parseTtbHeader(bytes: Uint8Array): TtbHeader {
  if (bytes.length < TTB_HEADER_BYTES) {
    throw new Error(
      `Bundle header is ${bytes.length} bytes, expected ${TTB_HEADER_BYTES}`,
    );
  }
  const magic = new TextDecoder().decode(bytes.subarray(0, TTB_MAGIC.length));
  if (magic !== TTB_MAGIC) {
    throw new Error(`Not a Tectonic bundle: magic reads ${JSON.stringify(magic)}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(14, true);
  // A u64 offset into a file the browser must also be able to address; anything
  // beyond 2^53 is unreachable here regardless of what the format allows.
  const offset = view.getBigUint64(18, true);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Bundle index offset exceeds the addressable range");
  }
  return {
    version,
    indexOffset: Number(offset),
    indexLength: view.getUint32(26, true),
    indexRealLength: view.getUint32(30, true),
  };
}

/**
 * Parse a `.ttb` index.
 *
 * Sectioned text; only `[FILELIST]` is read here, whose lines are
 * `<start> <gzip_len> <real_len> <hash> <path>`. The path is last precisely
 * because it may contain spaces, so it is split from the left for the four
 * fixed fields and the remainder taken whole.
 *
 * Paths are stored with directories, unlike the tar sidecar, so the basename is
 * indexed as well — TeX asks for `article.cls`, not for where it lives.
 */
export function parseTtbIndex(text: string): TexFileIndex {
  const index = new Map<string, FileLocation>();
  let inFileList = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) {
      inFileList = line.startsWith("[FILELIST]");
      continue;
    }
    if (!inFileList || line.length === 0) continue;
    const parts = line.split(" ");
    if (parts.length < 5) continue;
    const start = Number(parts[0]);
    const gzipLength = Number(parts[1]);
    const realLength = Number(parts[2]);
    const path = parts.slice(4).join(" ");
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(gzipLength)) {
      continue;
    }
    if (path.length === 0) continue;
    const location: FileLocation = {
      offset: start,
      length: gzipLength,
      realLength: Number.isSafeInteger(realLength) ? realLength : 0,
      gzipped: true,
    };
    const name = path.slice(path.lastIndexOf("/") + 1);
    // First writer wins, matching how a TeX search path resolves a duplicate
    // name: the earliest entry shadows later ones.
    if (!index.has(name)) index.set(name, location);
  }
  return index;
}

/** The HTTP `Range` header value for one file. */
export function rangeHeader(location: FileLocation): string {
  return `bytes=${location.offset}-${location.offset + location.length - 1}`;
}
