import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIndex,
  decompressBlock,
  TEXLIVE_ROOT,
  TexliveArchive,
} from "../../scripts/texlive-index";

/**
 * The LZ4 decoder is the one piece of this path with no upstream to trust: the
 * engine's assets are compressed with Emscripten's block format, and a decoder
 * that is subtly wrong returns plausible bytes rather than an error — a `.sty`
 * that is almost right fails somewhere else entirely, hours later.
 *
 * The blocks below are written by hand rather than round-tripped through an
 * encoder, so they test the format as specified and not as some encoder
 * happens to emit it.
 */
describe("decompressBlock", () => {
  it("copies a literals-only block", () => {
    // Token 0x50: five literals, no match. A block always ends in literals.
    const block = Buffer.from([0x50, ...Buffer.from("hello")]);
    expect(decompressBlock(block, 5).toString()).toBe("hello");
  });

  it("resolves a match that overlaps its own output", () => {
    // Three literals "abc", then a six-byte match three bytes back. The match
    // reads bytes this same sequence is still writing, which is how LZ4 spells
    // a repeat — copying it as a block move instead of byte by byte silently
    // produces "abcabc\0\0\0".
    const block = Buffer.from([0x32, ...Buffer.from("abc"), 0x03, 0x00]);
    expect(decompressBlock(block, 9).toString()).toBe("abcabcabc");
  });

  it("reads the 255-extension form for long literal runs", () => {
    // Nibble saturates at 15, so the length continues in 255-extension bytes:
    // 15 + 5 = 20 literals.
    const text = "0123456789abcdefghij";
    const block = Buffer.from([0xf0, 0x05, ...Buffer.from(text)]);
    expect(decompressBlock(block, 20).toString()).toBe(text);
  });
});

/**
 * Skipped unless the engine assets are present: they are 700 MB and gitignored,
 * so this must not fail a checkout that has not fetched them.
 */
const assets = existsSync(resolve(TEXLIVE_ROOT, "texlive-extra.data"));

describe.skipIf(!assets)("the TeX Live tree, read through the index", () => {
  it("extracts files the corpus is blocked on, at their exact length", () => {
    const index = buildIndex();
    const archive = new TexliveArchive();
    try {
      // One per corpus blocker, plus a class and a file large enough to span
      // hundreds of 2 KiB chunks — a decoder that loses a chunk boundary
      // passes on small files and fails here.
      for (const [name, provides] of [
        ["booktabs.sty", "booktabs"],
        ["enumitem.sty", "enumitem"],
        ["titlesec.sty", "titlesec"],
        ["tcolorbox.sty", "tcolorbox"],
        ["translator.sty", "translator"],
        ["article.cls", "article"],
      ] as const) {
        const entry = index.get(name);
        if (!entry) throw new Error(`${name} is not in the index`);
        const bytes = archive.read(entry.start, entry.length);
        expect(bytes.byteLength, name).toBe(entry.length);
        expect(bytes.toString("utf8"), name).toContain(`{${provides}}`);
      }

      const ltx = index.get("latex.ltx");
      if (!ltx) throw new Error("latex.ltx is not in the index");
      const kernel = archive.read(ltx.start, ltx.length);
      expect(kernel.byteLength).toBe(ltx.length);
      expect(kernel.toString("utf8")).toContain("latex.ltx");
    } finally {
      archive.close();
    }
  });

  it("prefers the canonical path when a name collides", () => {
    // `article.cls` exists in both tex/latex/base and tex/latex-dev/base.
    // A default TeX Live install resolves the former.
    expect(buildIndex().get("article.cls")?.path).toContain("/tex/latex/base/");
  });
});
