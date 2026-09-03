import { describe, expect, it } from "vitest";
import {
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
    expect(() => parseTtbHeader(ttbHeader({ magic: "notabundle!!!!" }))).toThrow(
      /Not a Tectonic bundle/,
    );
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
