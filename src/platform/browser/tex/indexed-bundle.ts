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
  /**
   * Where the file belongs in the TeX Live tree, when the index records it.
   *
   * Tectonic's own index does not, because its engine asks the bundle for a
   * name and is handed bytes. We inject files into an engine's filesystem
   * instead, and kpathsea searches by file type: a `.tfm` written under
   * `tex/latex/` is a `.tfm` TeX will not find.
   */
  path?: string;
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
 * A name may not contain spaces in this format, so the fields can be taken
 * positionally. A fourth field is the TeX Live path, which archives built by
 * `pnpm spike:tex-archive` record and Tectonic's does not; three-field lines
 * stay valid, which is what lets the same parser read the published bundle.
 * Anything else is rejected rather than misread.
 */
export function parseTarIndex(text: string): TexFileIndex {
  const index = new Map<string, FileLocation>();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split(" ");
    if (parts.length !== 3 && parts.length !== 4) continue;
    const [name, offset, length, path] = parts;
    if (!name) continue;
    const start = Number(offset);
    const size = Number(length);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size)) continue;
    if (start < 0 || size < 0) continue;
    index.set(name, {
      offset: start,
      length: size,
      gzipped: false,
      ...(path ? { path } : {}),
    });
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
    throw new Error(
      `Not a Tectonic bundle: magic reads ${JSON.stringify(magic)}`,
    );
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
      path,
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

/** Just enough of `fetch` to be substitutable in a test. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The global `fetch`, called on the global.
 *
 * `fetch` cannot be passed around bare: it throws "Illegal invocation" when
 * invoked with any other receiver, which is what a default parameter or a
 * stored field gives it. Every test injects a substitute, so only real use hits
 * this — it presented as an engine failure in a compile, not as a fetch error.
 */
const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/**
 * Fetch one file out of the archive.
 *
 * Every file in a document is a different range of the *same* URL, and that is
 * what makes the cache mode load-bearing rather than a detail. Chrome locks the
 * cache entry for a URL while a request against it is in flight, so concurrent
 * range requests to the archive queue behind each other however many the client
 * issues and whatever HTTP/2 would allow. Measured on the rig, fetching the 142
 * files `presentation-beamer` opens over a 150 ms link: 22.1 s under the default
 * cache mode, 0.58 s under `no-store`. The default makes a 64-way parallel
 * client perform exactly as if it were serial, and the gap grows with the
 * document.
 *
 * So this declines the HTTP cache deliberately. Caching happens a layer up,
 * keyed by file rather than by byte range, where a cache entry means something.
 *
 * A 200 rather than a 206 is treated as failure and not as a body: it means the
 * host ignored the `Range` header, and the response is then the entire archive.
 */
export async function fetchTexFile(
  archiveUrl: string,
  location: FileLocation,
  fetchImpl: FetchLike = globalFetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(archiveUrl, {
    headers: { Range: rangeHeader(location) },
    cache: "no-store",
  });
  if (response.status !== 206) {
    throw new Error(
      `Expected 206 for ${rangeHeader(location)}, got ${response.status}` +
        (response.status === 200 ? ": the host ignored the range request" : ""),
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return location.gzipped ? await gunzip(bytes) : bytes;
}

/** Inflate a `.ttb` entry, whose bytes are stored gzipped. */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * How many range requests to keep in flight.
 *
 * Measured on the rig: over HTTP/2 with the cache declined, fetching the 142
 * files `presentation-beamer` opens took 4093 ms at 6 in flight, 1043 ms at 24
 * and 575 ms at 64 on a 150 ms link. The curve is still bending at 64, but a
 * client that opens 64 streams for a document is one that behaves badly on a
 * shared connection, and the step from 24 to 64 buys less than the step to 24.
 */
const DEFAULT_CONCURRENCY = 24;

/** A file fetched out of the archive, with the path TeX expects it at. */
export interface ArchiveFile {
  name: string;
  path: string;
  bytes: Uint8Array;
}

/**
 * An indexed archive of TeX files, read over HTTP range requests.
 *
 * Holds the index — one fetch, and the one part of this model that costs
 * something before a document compiles — and answers requests for files by
 * name, which is how TeX asks for them.
 */
export class IndexedArchive {
  #index: TexFileIndex | undefined;
  readonly #archiveUrl: string;
  readonly #indexUrl: string;
  readonly #fetch: FetchLike;

  constructor(
    archiveUrl: string,
    indexUrl: string,
    fetchImpl: FetchLike = globalFetch,
  ) {
    this.#archiveUrl = archiveUrl;
    this.#indexUrl = indexUrl;
    this.#fetch = fetchImpl;
  }

  /** Load the index, once. Subsequent calls reuse it. */
  async load(): Promise<TexFileIndex> {
    if (this.#index) return this.#index;
    const response = await this.#fetch(this.#indexUrl);
    if (!response.ok) {
      throw new Error(`Archive index ${this.#indexUrl}: ${response.status}`);
    }
    this.#index = parseTarIndex(await response.text());
    return this.#index;
  }

  /** Whether the archive holds a file, without fetching it. */
  async has(name: string): Promise<boolean> {
    return (await this.load()).has(name);
  }

  /**
   * The names in the same TeX Live directory as a file, including it.
   *
   * TeX reports one missing file per run, so resolving strictly by name costs a
   * full TeX pass per file, and `presentation-beamer` opens 142 of them. A
   * package's files live in one directory, and a document that needs one of
   * them almost always needs its siblings — `pgfutil-common.tex` is reached
   * from `pgfrcs.sty` two directories along the same chain. Taking the
   * directory collapses the chain to a few passes while still transferring
   * kilobytes rather than a bundle.
   *
   * Capped, because a directory is not always small: the `cm-super` font
   * directories hold hundreds of files, and pulling one whole would recreate
   * the problem this exists to solve.
   */
  async neighbours(name: string, cap = 64): Promise<string[]> {
    const index = await this.load();
    const path = index.get(name)?.path;
    if (!path) return [];
    const directory = path.slice(0, path.lastIndexOf("/") + 1);
    const siblings: string[] = [];
    for (const [candidate, location] of index) {
      if (location.path?.startsWith(directory)) siblings.push(candidate);
      if (siblings.length > cap) return [name];
    }
    return siblings;
  }

  /**
   * Fetch every named file the archive holds, in parallel.
   *
   * Names it does not hold are skipped rather than raising: a document asks for
   * files from several sources, and this one answering for a subset is the
   * normal case, not a failure. The caller sees which names came back.
   *
   * A file with no recorded path is skipped too. Injecting bytes without
   * knowing where they belong would put a font metric somewhere kpathsea does
   * not look, which fails later and less legibly than not delivering it.
   */
  async fetchFiles(
    names: readonly string[],
    concurrency = DEFAULT_CONCURRENCY,
  ): Promise<ArchiveFile[]> {
    const index = await this.load();
    const wanted = names
      .map((name) => ({ name, location: index.get(name) }))
      .filter(
        (entry): entry is { name: string; location: FileLocation } =>
          entry.location?.path !== undefined,
      );

    const files: ArchiveFile[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const entry = wanted[next++];
        if (!entry) return;
        const bytes = await fetchTexFile(
          this.#archiveUrl,
          entry.location,
          this.#fetch,
        );
        // `path` is present by construction: the filter above requires it.
        files.push({
          name: entry.name,
          path: entry.location.path as string,
          bytes,
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, wanted.length) }, () =>
        worker(),
      ),
    );
    return files;
  }
}
