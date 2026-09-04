import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  ArchiveRejectedError,
  DEFAULT_ARCHIVE_LIMITS,
  packProject,
  unpackProject,
} from "@/core/project/archive";
import { projectPath } from "@/core/project/ids";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

/** A ZIP built from raw names, bypassing the path validation import applies. */
function hostileZip(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries, { level: 0, mtime: Date.UTC(1980, 0, 1) });
}

describe("packProject", () => {
  it("round-trips a project without touching its bytes", () => {
    const files = [
      {
        path: projectPath("main.tex"),
        bytes: bytes("\\documentclass{article}"),
      },
      { path: projectPath("chapters/one.tex"), bytes: bytes("chapter one") },
    ];
    const restored = unpackProject(packProject(files));

    expect(restored.map((file) => file.path)).toEqual([
      "chapters/one.tex",
      "main.tex",
    ]);
    expect(text(restored[1]?.bytes ?? new Uint8Array())).toBe(
      "\\documentclass{article}",
    );
  });

  it("preserves binary content exactly", () => {
    // A figure or a font is not text, and a round trip that decodes and
    // re-encodes would quietly corrupt one.
    const binary = new Uint8Array(256);
    for (let i = 0; i < 256; i++) binary[i] = i;
    const restored = unpackProject(
      packProject([{ path: projectPath("figure.png"), bytes: binary }]),
    );
    expect(restored[0]?.bytes).toEqual(binary);
  });

  it("produces the same bytes for the same project", () => {
    // A backup whose bytes change every time it is taken cannot be diffed, and
    // a user cannot tell whether anything actually changed.
    const files = [{ path: projectPath("main.tex"), bytes: bytes("a") }];
    expect(packProject(files)).toEqual(packProject(files));
  });

  it("does not depend on the order files are given in", () => {
    const a = { path: projectPath("a.tex"), bytes: bytes("a") };
    const b = { path: projectPath("b.tex"), bytes: bytes("b") };
    expect(packProject([a, b])).toEqual(packProject([b, a]));
  });
});

describe("unpackProject rejects hostile archives", () => {
  it("rejects a path that escapes the project", () => {
    const archive = hostileZip({ "../../etc/passwd": bytes("x") });
    expect(() => unpackProject(archive)).toThrow(ArchiveRejectedError);
    expect(() => unpackProject(archive)).toThrow(/traverses upward/);
  });

  it("rejects an absolute path", () => {
    expect(() =>
      unpackProject(hostileZip({ "/etc/passwd": bytes("x") })),
    ).toThrow(/absolute/);
  });

  it("rejects a Windows drive letter", () => {
    expect(() =>
      unpackProject(hostileZip({ "C:/Windows/system.ini": bytes("x") })),
    ).toThrow(/drive letter/);
  });

  it("rejects a NUL byte, which truncates a path for some consumers", () => {
    expect(() =>
      unpackProject(hostileZip({ "main.tex\u0000.png": bytes("x") })),
    ).toThrow(/NUL/);
  });

  it("rejects a Windows device name, which is unwritable when exported", () => {
    expect(() => unpackProject(hostileZip({ "con.tex": bytes("x") }))).toThrow(
      ArchiveRejectedError,
    );
  });

  it("rejects two entries that normalise to the same path", () => {
    // Silently keeping the last would let the archive choose which of two
    // files the project ends up with.
    const archive = hostileZip({
      "a.tex": bytes("first"),
      "./a.tex": bytes("second"),
    });
    expect(() => unpackProject(archive)).toThrow(/both become a.tex/);
  });

  it("rejects a backslash spelling that collides with a forward-slash one", () => {
    const archive = hostileZip({
      "chapters/one.tex": bytes("first"),
      "chapters\\one.tex": bytes("second"),
    });
    expect(() => unpackProject(archive)).toThrow(/duplicate|both become/);
  });

  it("rejects more entries than the limit allows", () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i <= DEFAULT_ARCHIVE_LIMITS.maxEntries; i++) {
      entries[`file${i}.tex`] = bytes("x");
    }
    expect(() => unpackProject(hostileZip(entries))).toThrow(
      /more than .* entries/,
    );
  });

  it("rejects a file larger than the per-file limit", () => {
    const limits = { ...DEFAULT_ARCHIVE_LIMITS, maxFileBytes: 64 };
    const archive = hostileZip({ "big.tex": new Uint8Array(128) });
    expect(() => unpackProject(archive, limits)).toThrow(ArchiveRejectedError);
  });

  it("rejects an archive larger than the total limit", () => {
    const limits = {
      ...DEFAULT_ARCHIVE_LIMITS,
      maxFileBytes: 1024,
      maxTotalBytes: 100,
    };
    const archive = hostileZip({
      "a.tex": new Uint8Array(60),
      "b.tex": new Uint8Array(60),
    });
    expect(() => unpackProject(archive, limits)).toThrow(
      /expands past|declares/,
    );
  });

  it("rejects something that is not a ZIP at all", () => {
    expect(() => unpackProject(bytes("not a zip file"))).toThrow(
      ArchiveRejectedError,
    );
  });

  it("rejects an archive with no files in it", () => {
    expect(() => unpackProject(hostileZip({}))).toThrow(/no files/);
  });

  it("names the entry it rejected, so the message can be acted on", () => {
    try {
      unpackProject(hostileZip({ "../escape.tex": bytes("x") }));
      expect.unreachable("should have rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveRejectedError);
      expect((error as ArchiveRejectedError).entry).toBe("../escape.tex");
      expect((error as ArchiveRejectedError).reason).toBe("invalid-path");
    }
  });
});

describe("unpackProject accepts what a real archive looks like", () => {
  it("drops directory entries rather than rejecting the archive", () => {
    // Most zip tools record directories. They carry no content and the file
    // paths already imply the structure.
    const archive = hostileZip({
      "chapters/": new Uint8Array(0),
      "chapters/one.tex": bytes("one"),
    });
    expect(unpackProject(archive).map((file) => file.path)).toEqual([
      "chapters/one.tex",
    ]);
  });

  it("normalises a leading ./ that many tools write", () => {
    expect(
      unpackProject(hostileZip({ "./main.tex": bytes("x") }))[0]?.path,
    ).toBe("main.tex");
  });

  it("accepts a deflated archive, not only a stored one", () => {
    const compressible = bytes("x".repeat(10_000));
    const archive = zipSync({ "main.tex": compressible }, { level: 9 });
    expect(unpackProject(archive)[0]?.bytes.length).toBe(10_000);
  });
});

describe("a ZIP that lies about its sizes", () => {
  /** Rewrites both size fields so the headers understate the payload. */
  function understateSizes(zip: Uint8Array, claimed: number): Uint8Array {
    const patched = new Uint8Array(zip);
    const view = new DataView(patched.buffer);
    for (let i = 0; i + 4 <= patched.length; i++) {
      const signature = view.getUint32(i, true);
      // Local file header, then central directory header: the uncompressed
      // size sits at a different offset in each.
      if (signature === 0x04034b50) view.setUint32(i + 22, claimed, true);
      if (signature === 0x02014b50) view.setUint32(i + 24, claimed, true);
    }
    return patched;
  }

  it("cannot make the reader allocate more than it declared", () => {
    // The property the import limits rest on. Measured against fflate 0.8.3:
    // the declared size is what gets allocated, so a 4 MB payload declared as
    // 100 bytes yields 100 bytes rather than a bomb. If fflate ever grew the
    // buffer instead, this test is what would notice.
    const payload = new Uint8Array(4_000_000);
    const honest = zipSync({ "bomb.txt": payload }, { level: 9 });
    const lying = understateSizes(honest, 100);

    const files = unpackProject(lying, {
      ...DEFAULT_ARCHIVE_LIMITS,
      maxFileBytes: 1024,
      maxTotalBytes: 1024,
    });
    expect(files[0]?.bytes.length).toBe(100);
  });
});
