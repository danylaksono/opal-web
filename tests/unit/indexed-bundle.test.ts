import { describe, expect, it } from "vitest";
import {
  type FetchLike,
  fetchTexFile,
  IndexedArchive,
  parseTarIndex,
  parseTtbHeader,
  parseTtbIndex,
  rangeHeader,
  TTB_HEADER_BYTES,
} from "@/platform/browser/tex/indexed-bundle";

/** Lines copied from Tectonic's published `tlextras-2022.0r0.tar.index.gz`. */
const TAR_INDEX = [
  "SVNREV 512 6",
  "GITHASH 1536 41",
  "aasjournal.bst 2560 37930",
  "acmart.cls 52796928 107215",
].join("\n");

function ttbHeader(overrides: Partial<{ magic: string }> = {}): Uint8Array {
  const bytes = new Uint8Array(TTB_HEADER_BYTES);
  const magic = overrides.magic ?? "tectonicbundle";
  bytes.set(new TextEncoder().encode(magic).subarray(0, 14), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(14, 1, true);
  view.setBigUint64(18, 6_066_060n, true);
  view.setUint32(26, 133, true);
  view.setUint32(30, 360, true);
  return bytes;
}

describe("parseTarIndex", () => {
  it("reads name, offset and length", () => {
    const index = parseTarIndex(TAR_INDEX);
    expect(index.get("acmart.cls")).toEqual({
      offset: 52796928,
      length: 107215,
      gzipped: false,
    });
  });

  it("indexes every line", () => {
    expect(parseTarIndex(TAR_INDEX).size).toBe(4);
  });

  it("ignores blank lines rather than indexing an empty name", () => {
    expect(parseTarIndex("a 1 2\n\n\nb 3 4").size).toBe(2);
  });

  it("skips a line that is not three fields", () => {
    // A name containing a space cannot be represented in this format, so a
    // four-field line is malformed rather than a path to be reassembled.
    expect(parseTarIndex("two words 1 2").has("two")).toBe(false);
  });

  it("skips a line whose numbers are not numbers", () => {
    expect(parseTarIndex("a.sty x 2").size).toBe(0);
    expect(parseTarIndex("a.sty 1 y").size).toBe(0);
  });

  it("skips a negative offset, which would range backwards", () => {
    expect(parseTarIndex("a.sty -1 2").size).toBe(0);
  });

  it("marks tar entries as stored uncompressed", () => {
    // Verified against the live bundle: one range request returns the file's
    // bytes directly, with no inflate step.
    expect(parseTarIndex(TAR_INDEX).get("acmart.cls")?.gzipped).toBe(false);
  });
});

describe("parseTtbHeader", () => {
  it("reads the documented fields", () => {
    expect(parseTtbHeader(ttbHeader())).toEqual({
      version: 1,
      indexOffset: 6_066_060,
      indexLength: 133,
      indexRealLength: 360,
    });
  });

  it("rejects a file that is not a bundle", () => {
    expect(() =>
      parseTtbHeader(ttbHeader({ magic: "notabundle!!!!" })),
    ).toThrow(/Not a Tectonic bundle/);
  });

  it("rejects a truncated header rather than reading past it", () => {
    expect(() => parseTtbHeader(new Uint8Array(20))).toThrow(/expected 66/);
  });

  it("rejects an offset the browser could not address", () => {
    const bytes = ttbHeader();
    new DataView(bytes.buffer).setBigUint64(18, 2n ** 60n, true);
    expect(() => parseTtbHeader(bytes)).toThrow(/addressable range/);
  });
});

describe("parseTtbIndex", () => {
  const index = [
    "[DEFAULTSEARCH]",
    "MAIN",
    "[SEARCH:MAIN]",
    "/",
    "/texlive/tex/latex//",
    "[FILELIST]",
    "70 6065990 17331559 nohash FILELIST",
    "6066265 39 19 86d8d12c include/tectonic/tectonic-format-latex.tex",
    "6066304 100 250 abc123 texlive/tex/latex/base/article.cls",
  ].join("\n");

  it("reads only the file list, not the search sections", () => {
    const parsed = parseTtbIndex(index);
    expect(parsed.has("MAIN")).toBe(false);
    expect(parsed.has("article.cls")).toBe(true);
  });

  it("keys on the basename, because that is what TeX asks for", () => {
    expect(parseTtbIndex(index).get("article.cls")).toEqual({
      offset: 6066304,
      length: 100,
      realLength: 250,
      gzipped: true,
      // Keyed by name, but the location is kept: injecting a file into an
      // engine's filesystem needs somewhere to put it.
      path: "texlive/tex/latex/base/article.cls",
    });
  });

  it("marks ttb entries as gzipped, unlike the tar format", () => {
    expect(parseTtbIndex(index).get("article.cls")?.gzipped).toBe(true);
  });

  it("keeps a path containing spaces intact", () => {
    const withSpace = "[FILELIST]\n10 20 30 hash tex/some dir/file name.sty";
    expect(parseTtbIndex(withSpace).has("file name.sty")).toBe(true);
  });

  it("lets the first entry shadow a later duplicate, as a search path does", () => {
    const duplicated = [
      "[FILELIST]",
      "10 20 30 hash a/dup.sty",
      "40 50 60 hash b/dup.sty",
    ].join("\n");
    expect(parseTtbIndex(duplicated).get("dup.sty")?.offset).toBe(10);
  });

  it("ignores lines before any section marker", () => {
    expect(parseTtbIndex("10 20 30 hash a.sty\n[FILELIST]").size).toBe(0);
  });
});

describe("rangeHeader", () => {
  it("asks for an inclusive byte range", () => {
    // HTTP ranges are inclusive at both ends, so a 100-byte file at offset 0
    // ends at 99, not 100.
    expect(rangeHeader({ offset: 0, length: 100, gzipped: false })).toBe(
      "bytes=0-99",
    );
  });

  it("matches the range that fetched acmart.cls from the live bundle", () => {
    const location = parseTarIndex(TAR_INDEX).get("acmart.cls");
    expect(location && rangeHeader(location)).toBe("bytes=52796928-52904142");
  });
});

describe("fetchTexFile", () => {
  /** Records what it was asked for, and answers with `body` and `status`. */
  function stubFetch(
    body: Uint8Array,
    status = 206,
  ): FetchLike & { calls: RequestInit[] } {
    const calls: RequestInit[] = [];
    const impl = async (_input: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(body as BodyInit, { status });
    };
    return Object.assign(impl, { calls });
  }

  const location = { offset: 10, length: 4, gzipped: false };

  it("asks for exactly the file's byte range", async () => {
    const fetchImpl = stubFetch(new Uint8Array([1, 2, 3, 4]));
    await fetchTexFile("/tex/texfiles.bin", location, fetchImpl);
    expect(fetchImpl.calls[0]?.headers).toEqual({ Range: "bytes=10-13" });
  });

  it("declines the HTTP cache, which serialises same-URL range requests", async () => {
    // Not a preference. Chrome locks the cache entry per URL, and every file in
    // the archive shares one URL, so the default mode turns concurrent fetches
    // into sequential ones: 381 ms against 60 ms for six files on the rig.
    const fetchImpl = stubFetch(new Uint8Array([1, 2, 3, 4]));
    await fetchTexFile("/tex/texfiles.bin", location, fetchImpl);
    expect(fetchImpl.calls[0]?.cache).toBe("no-store");
  });

  it("returns the bytes for an uncompressed entry", async () => {
    const fetchImpl = stubFetch(new Uint8Array([1, 2, 3, 4]));
    const bytes = await fetchTexFile("/tex/x.bin", location, fetchImpl);
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  it("inflates a gzipped ttb entry", async () => {
    const source = new TextEncoder().encode("\\ProvidesPackage{opal}");
    const gzipped = new Uint8Array(
      await new Response(
        new Blob([source as BlobPart])
          .stream()
          .pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    );
    const fetchImpl = stubFetch(gzipped);
    const bytes = await fetchTexFile(
      "/tex/x.ttb",
      { offset: 0, length: gzipped.length, gzipped: true },
      fetchImpl,
    );
    expect(new TextDecoder().decode(bytes)).toBe("\\ProvidesPackage{opal}");
  });

  it("rejects a 200, which means the whole archive rather than one file", async () => {
    const fetchImpl = stubFetch(new Uint8Array([1, 2, 3, 4]), 200);
    await expect(
      fetchTexFile("/tex/texfiles.bin", location, fetchImpl),
    ).rejects.toThrow(/ignored the range request/);
  });
});

describe("parseTarIndex with paths", () => {
  it("reads the fourth field our own archives add", () => {
    const line =
      "article.cls 100 200 /texlive/texmf-dist/tex/latex/base/article.cls";
    expect(parseTarIndex(line).get("article.cls")).toEqual({
      offset: 100,
      length: 200,
      gzipped: false,
      path: "/texlive/texmf-dist/tex/latex/base/article.cls",
    });
  });

  it("still reads Tectonic's three-field lines, which have no path", () => {
    // The published bundle is the reason the field is optional rather than
    // required: the same parser has to read both.
    expect(
      parseTarIndex("acmart.cls 52796928 107215").get("acmart.cls"),
    ).toEqual({ offset: 52796928, length: 107215, gzipped: false });
  });

  it("rejects a line with more fields than the format has", () => {
    expect(parseTarIndex("a.sty 1 2 /p extra").size).toBe(0);
  });
});

describe("IndexedArchive", () => {
  const INDEX = [
    "a.sty 0 1 /texlive/texmf-dist/tex/latex/a/a.sty",
    "a-extra.tex 3 1 /texlive/texmf-dist/tex/latex/a/a-extra.tex",
    "b.sty 1 1 /texlive/texmf-dist/tex/latex/b/b.sty",
    "noplace.sty 2 1",
  ].join("\n");

  /** Serves the index at one URL and 206 slices of a byte string at the other. */
  function stubFetch(): {
    fetch: FetchLike;
    indexFetches: number;
    ranges: string[];
  } {
    const stub = {
      indexFetches: 0,
      ranges: [] as string[],
      fetch: async (input: string, init?: RequestInit) => {
        if (input.endsWith(".index")) {
          stub.indexFetches++;
          return new Response(INDEX, { status: 200 });
        }
        const headers = init?.headers as Record<string, string> | undefined;
        stub.ranges.push(headers?.Range ?? "");
        return new Response(new Uint8Array([7]), { status: 206 });
      },
    };
    return stub;
  }

  function archive(fetchImpl: FetchLike): IndexedArchive {
    return new IndexedArchive(
      "/tex/texfiles.bin",
      "/tex/texfiles.index",
      fetchImpl,
    );
  }

  it("fetches the index once, however many files are asked for", async () => {
    const stub = stubFetch();
    const subject = archive(stub.fetch);
    await subject.fetchFiles(["a.sty"]);
    await subject.fetchFiles(["b.sty"]);
    expect(stub.indexFetches).toBe(1);
  });

  it("returns each file at the path the index records for it", async () => {
    const files = await archive(stubFetch().fetch).fetchFiles([
      "a.sty",
      "b.sty",
    ]);
    expect(files.map((f) => f.path).sort()).toEqual([
      "/texlive/texmf-dist/tex/latex/a/a.sty",
      "/texlive/texmf-dist/tex/latex/b/b.sty",
    ]);
  });

  it("skips a name the archive does not hold rather than failing", async () => {
    // A document draws files from several sources; this one answering for a
    // subset is the normal case.
    const files = await archive(stubFetch().fetch).fetchFiles([
      "a.sty",
      "absent.sty",
    ]);
    expect(files.map((f) => f.name)).toEqual(["a.sty"]);
  });

  it("skips an entry with no path, which it could not place anyway", async () => {
    const files = await archive(stubFetch().fetch).fetchFiles(["noplace.sty"]);
    expect(files).toEqual([]);
  });

  it("asks for one byte range per file", async () => {
    const stub = stubFetch();
    await archive(stub.fetch).fetchFiles(["a.sty", "b.sty"]);
    expect(stub.ranges.sort()).toEqual(["bytes=0-0", "bytes=1-1"]);
  });

  it("takes the whole TeX Live directory a missing file sits in", async () => {
    // TeX names one missing file per run, so resolving strictly by name costs a
    // TeX pass per file. Siblings come along because a document needing one
    // file from a package almost always needs its neighbours.
    const names = await archive(stubFetch().fetch).neighbours("a.sty");
    expect(names.sort()).toEqual(["a-extra.tex", "a.sty"]);
  });

  it("does not take a directory bigger than the cap", async () => {
    // A cm-super font directory holds hundreds of files; pulling one whole
    // would recreate the bundle problem at a smaller scale.
    const many = Array.from(
      { length: 10 },
      (_, i) => `f${i}.tfm 0 1 /texlive/texmf-dist/fonts/tfm/x/f${i}.tfm`,
    ).join("\n");
    const subject = new IndexedArchive(
      "/tex/texfiles.bin",
      "/tex/texfiles.index",
      async (input: string) =>
        input.endsWith(".index")
          ? new Response(many, { status: 200 })
          : new Response(new Uint8Array([1]), { status: 206 }),
    );
    expect(await subject.neighbours("f0.tfm", 4)).toEqual(["f0.tfm"]);
  });
});
