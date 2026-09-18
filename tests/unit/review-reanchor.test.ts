import { describe, expect, it, vi } from "vitest";
import type { Rect } from "@/core/pdf/types";
import type { ReviewAnchor, ReviewComment } from "@/core/review/model";
import { pagesNearest, reanchorAnnotations } from "@/core/review/reanchor";

/**
 * Ported from `opal-editor@8f95519`'s `review-reanchor.test.ts`, with rects
 * in this repo's `{ width, height }` shape rather than desktop's `{ w, h }`.
 */

const SENTENCE =
  "The estimator remains unbiased under the stated regularity conditions.";

/** `Partial<ReviewAnchor>`, but explicit about allowing `selectedText:
 *  undefined` to override the default below — `exactOptionalPropertyTypes`
 *  otherwise rejects it as distinct from omitting the key. */
type AnchorOverride = Omit<Partial<ReviewAnchor>, "selectedText"> & {
  selectedText?: string | undefined;
};

function makeComment(
  override: AnchorOverride = {},
  id = "review-1",
): ReviewComment {
  const merged: { selectedText?: string | undefined } & Omit<
    ReviewAnchor,
    "selectedText"
  > = {
    kind: "text",
    page: 12,
    x: 100,
    y: 200,
    width: 300,
    height: 14,
    selectedText: SENTENCE,
    ...override,
  };
  // `selectedText: undefined` in an override means "no text", which the spread
  // above leaves as a literal `undefined` value — remove the key rather than
  // keep it, matching what an anchor with no selected text actually looks like.
  if (merged.selectedText === undefined) delete merged.selectedText;
  const anchor = merged as ReviewAnchor;

  return {
    id,
    kind: "highlight",
    documentRoot: "main.tex",
    author: "Dany",
    body: "",
    status: "open",
    anchor,
    replies: [],
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  };
}

/** A PDF whose only copy of the sentence lives on `hitPage`. */
function searchStub(hitPage: number, rects: Rect[]) {
  return vi.fn(async (pageIndex: number) =>
    pageIndex + 1 === hitPage ? [rects] : [],
  );
}

const noForwardSearch = vi.fn(async () => []);

describe("pagesNearest", () => {
  it("walks outwards from the stored page", () => {
    expect(pagesNearest(5, 100, 2)).toEqual([5, 6, 4, 7, 3]);
  });

  it("stays inside the document", () => {
    expect(pagesNearest(1, 3, 3)).toEqual([1, 2, 3]);
    expect(pagesNearest(99, 3, 2)).toEqual([3, 2, 1]);
  });
});

describe("reanchorAnnotations", () => {
  it("never returns a replacement anchor — the annotation stays put", async () => {
    const searchPage = searchStub(14, [
      { x: 90, y: 400, width: 310, height: 16 },
    ]);
    const updates = await reanchorAnnotations([makeComment()], {
      pageCount: 40,
      searchPage,
      forwardSearch: noForwardSearch,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty("anchor");
  });

  it("reports where text that moved to another page turned up", async () => {
    const searchPage = searchStub(14, [
      { x: 90, y: 400, width: 310, height: 16 },
    ]);
    const updates = await reanchorAnnotations([makeComment()], {
      pageCount: 40,
      searchPage,
      forwardSearch: noForwardSearch,
    });

    expect(updates[0]?.status).toBe("shifted");
    expect(updates[0]?.foundAt).toEqual({
      page: 14,
      x: 90,
      y: 400,
      width: 310,
      height: 16,
    });
    expect(noForwardSearch).not.toHaveBeenCalled();
  });

  it("reports text still under the annotation as ok", async () => {
    const searchPage = searchStub(12, [
      { x: 100, y: 200, width: 300, height: 14 },
    ]);
    const updates = await reanchorAnnotations([makeComment()], {
      pageCount: 40,
      searchPage,
      forwardSearch: noForwardSearch,
    });

    expect(updates[0]?.status).toBe("ok");
    expect(updates[0]?.foundAt).toBeUndefined();
  });

  it("does not call a highlight drawn loosely around its words a shift", async () => {
    // Swept box starts a few points above and left of the text inside it —
    // the normal result of dragging a highlighter, not movement.
    const searchPage = searchStub(12, [
      { x: 106, y: 208, width: 280, height: 12 },
    ]);
    const updates = await reanchorAnnotations([makeComment()], {
      pageCount: 40,
      searchPage,
      forwardSearch: noForwardSearch,
    });

    expect(updates[0]?.status).toBe("ok");
  });

  it("treats a move down the same page as a shift", async () => {
    const searchPage = searchStub(12, [
      { x: 100, y: 480, width: 300, height: 14 },
    ]);
    const updates = await reanchorAnnotations([makeComment()], {
      pageCount: 40,
      searchPage,
      forwardSearch: noForwardSearch,
    });

    expect(updates[0]?.status).toBe("shifted");
    expect(updates[0]?.foundAt?.y).toBe(480);
  });

  it("spans every rectangle of a match that wraps across lines", async () => {
    const searchPage = searchStub(14, [
      { x: 300, y: 200, width: 100, height: 14 },
      { x: 100, y: 216, width: 120, height: 14 },
    ]);
    const updates = await reanchorAnnotations([makeComment()], {
      pageCount: 40,
      searchPage,
      forwardSearch: noForwardSearch,
    });

    expect(updates[0]?.foundAt).toMatchObject({
      x: 100,
      y: 200,
      width: 300,
      height: 30,
    });
  });

  it("falls back to SyncTeX when there is no text to search for", async () => {
    const comment = makeComment({
      kind: "point",
      selectedText: undefined,
      width: 18,
      height: 18,
      source: { file: "chapters/method.tex", line: 42, column: 0 },
    });
    const searchPage = vi.fn(async () => []);
    const forwardSearch = vi.fn(async () => [
      { page: 9, x: 72, y: 512, width: 400, height: 12 },
    ]);

    const updates = await reanchorAnnotations([comment], {
      pageCount: 40,
      searchPage,
      forwardSearch,
    });

    expect(searchPage).not.toHaveBeenCalled();
    expect(forwardSearch).toHaveBeenCalledWith([
      { file: "chapters/method.tex", line: 42, column: 0 },
    ]);
    expect(updates[0]?.status).toBe("shifted");
    expect(updates[0]?.foundAt?.page).toBe(9);
  });

  it("asks SyncTeX for every unplaced annotation in one batch", async () => {
    const comments = [
      makeComment(
        {
          selectedText: undefined,
          source: { file: "a.tex", line: 1, column: 0 },
        },
        "a",
      ),
      makeComment(
        {
          selectedText: undefined,
          source: { file: "b.tex", line: 2, column: 0 },
        },
        "b",
      ),
    ];
    const forwardSearch = vi.fn(async () => [
      null,
      { page: 3, x: 10, y: 20, width: 100, height: 12 },
    ]);

    const updates = await reanchorAnnotations(comments, {
      pageCount: 40,
      searchPage: vi.fn(async () => []),
      forwardSearch,
    });

    expect(forwardSearch).toHaveBeenCalledTimes(1);
    expect(updates.find((u) => u.id === "a")?.status).toBe("drifted");
    expect(updates.find((u) => u.id === "b")?.status).toBe("shifted");
  });

  it("marks an annotation drifted when neither route can find its text", async () => {
    const updates = await reanchorAnnotations([makeComment()], {
      pageCount: 40,
      searchPage: vi.fn(async () => []),
      forwardSearch: noForwardSearch,
    });

    expect(updates[0]?.status).toBe("drifted");
    expect(updates[0]?.foundAt).toBeUndefined();
  });

  it("keeps checking rather than throwing when a page cannot be read", async () => {
    const searchPage = vi.fn(async (pageIndex: number) => {
      if (pageIndex === 11) throw new Error("bad page");
      return pageIndex === 12 ? [[{ x: 1, y: 2, width: 3, height: 4 }]] : [];
    });

    const updates = await reanchorAnnotations([makeComment()], {
      pageCount: 40,
      searchPage,
      forwardSearch: noForwardSearch,
    });

    expect(updates[0]?.status).toBe("shifted");
    expect(updates[0]?.foundAt?.page).toBe(13);
  });

  it("reports an annotation with nothing to locate it by as unverified, not drifted", async () => {
    const searchPage = vi.fn(async () => [
      [{ x: 1, y: 2, width: 3, height: 4 }],
    ]);
    const updates = await reanchorAnnotations(
      // Too short to search for, and no source line either.
      [makeComment({ selectedText: "the" })],
      { pageCount: 40, searchPage, forwardSearch: noForwardSearch },
    );

    expect(searchPage).not.toHaveBeenCalled();
    // Never searched, so its position is unknown - claiming drift here would
    // cry wolf over every old annotation in the project.
    expect(updates[0]?.status).toBe("unverified");
  });

  it("stops when cancelled by a newer build", async () => {
    let cancelled = false;
    const searchPage = vi.fn(async () => {
      cancelled = true;
      return [];
    });

    const updates = await reanchorAnnotations(
      [makeComment({}, "a"), makeComment({}, "b")],
      {
        pageCount: 40,
        searchPage,
        forwardSearch: noForwardSearch,
        isCancelled: () => cancelled,
      },
    );

    expect(updates).toHaveLength(0);
    expect(noForwardSearch).not.toHaveBeenCalled();
  });

  it("does nothing for a document with no pages", async () => {
    const searchPage = vi.fn(async () => []);
    expect(
      await reanchorAnnotations([makeComment()], {
        pageCount: 0,
        searchPage,
        forwardSearch: noForwardSearch,
      }),
    ).toEqual([]);
    expect(searchPage).not.toHaveBeenCalled();
  });
});
