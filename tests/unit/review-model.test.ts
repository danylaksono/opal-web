import { describe, expect, it } from "vitest";
import {
  isReviewComment,
  parseReviewFile,
  type ReviewFile,
  reviewerFileName,
  reviewFilePath,
  serializeReviewFile,
} from "@/core/review/model";

/**
 * The interoperability claim ADR-010 makes — that `review/` means the same
 * thing on desktop and web — is only real if a round trip through this port
 * reproduces the same bytes a save produces. `dany-laksono.json` is exactly
 * `JSON.stringify(file, null, 2)` of a hand-built fixture covering all three
 * annotation kinds, replies, tags, colour and a SyncTeX source location, with
 * key order matching desktop's `addComment` object literal (`review-store.ts`
 * at `opal-editor@8f95519`); it is not generated from this port, so it cannot
 * pass by construction.
 *
 * The fixture is excluded from Biome in `biome.json`
 * (`!tests/fixtures/review`) for the same reason: Biome collapses a
 * single-element array onto one line, `JSON.stringify` never does, and
 * letting the formatter "tidy" the fixture makes this test start failing on
 * an array-wrapping diff that has nothing to do with the port.
 *
 * Read through `import.meta.glob`, not `node:fs`: see
 * `latex-corpus-index.test.ts` for why this project's unit tests have no
 * filesystem.
 */

const FIXTURES = import.meta.glob("../fixtures/review/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FIXTURE_TEXT = Object.entries(FIXTURES).find(([key]) =>
  key.endsWith("dany-laksono.json"),
)?.[1];
if (FIXTURE_TEXT === undefined)
  throw new Error("fixture dany-laksono.json not found");

describe("parseReviewFile / serializeReviewFile", () => {
  it("round-trips the fixture byte for byte", () => {
    const comments = parseReviewFile(FIXTURE_TEXT);
    expect(comments).toHaveLength(3);

    const file: ReviewFile = {
      version: 2,
      author: "Dany Laksono",
      annotations: comments,
    };
    expect(serializeReviewFile(file)).toBe(FIXTURE_TEXT);
  });

  it("reads every annotation kind the fixture carries", () => {
    const comments = parseReviewFile(FIXTURE_TEXT);
    expect(comments.map((c) => c.kind)).toEqual([
      "comment",
      "highlight",
      "drawing",
    ]);
  });

  it("keeps a reply and a SyncTeX source location intact", () => {
    const comment = parseReviewFile(FIXTURE_TEXT)[0];
    expect(comment?.replies).toHaveLength(1);
    expect(comment?.anchor.source).toEqual({
      file: "sections/method.tex",
      line: 42,
      column: 4,
    });
    expect(comment?.tags).toEqual(["cite-check"]);
  });

  it("rejects the wrong version rather than guessing at its shape", () => {
    expect(
      parseReviewFile(JSON.stringify({ version: 1, annotations: [] })),
    ).toEqual([]);
  });

  it("rejects text that is not JSON at all", () => {
    expect(parseReviewFile("not json")).toEqual([]);
  });

  it("drops a drawing annotation with no stroke rather than keep an invisible one", () => {
    const broken = {
      version: 2,
      author: "X",
      annotations: [
        {
          id: "1",
          kind: "drawing",
          documentRoot: "main.tex",
          author: "X",
          body: "",
          status: "open",
          anchor: { kind: "point", page: 1, x: 0, y: 0, width: 1, height: 1 },
          replies: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    expect(parseReviewFile(JSON.stringify(broken))).toEqual([]);
  });

  it("never emits an empty tags array — untagged stays absent", () => {
    const comment = parseReviewFile(FIXTURE_TEXT)[1];
    expect(comment).toBeDefined();
    expect(comment?.tags).toBeUndefined();
    const file: ReviewFile = {
      version: 2,
      author: "x",
      annotations: comment ? [comment] : [],
    };
    expect(serializeReviewFile(file)).not.toContain('"tags"');
  });
});

describe("isReviewComment", () => {
  it("accepts a well-formed comment", () => {
    expect(isReviewComment(parseReviewFile(FIXTURE_TEXT)[0])).toBe(true);
  });

  it("rejects a value missing required fields", () => {
    expect(isReviewComment({ id: "1" })).toBe(false);
    expect(isReviewComment(null)).toBe(false);
  });
});

describe("reviewerFileName / reviewFilePath", () => {
  it("slugs a display name to a stable file name", () => {
    expect(reviewerFileName("Dany Laksono")).toBe("dany-laksono.json");
  });

  it("collapses punctuation and mixed case the same way desktop does", () => {
    expect(reviewerFileName("  Dr. Dany_Laksono!! ")).toBe(
      "dr-dany-laksono.json",
    );
  });

  it("falls back to a generic name for input with nothing usable", () => {
    expect(reviewerFileName("###")).toBe("reviewer.json");
  });

  it("nests the file under the review/ directory", () => {
    expect(reviewFilePath("Dany Laksono")).toBe("review/dany-laksono.json");
  });
});
