import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { zipSync } from "fflate";

/**
 * The review panel over files a reviewer sent (ADR-010).
 *
 * The project arrives as a ZIP holding `main.tex` and two reviewer files: the
 * desktop fixture, and one this version cannot fully read. The second is the
 * one that matters — a panel that resolves a comment in a file it only half
 * understood would delete whatever the other product wrote there.
 */

const FIXTURE = readFileSync(
  resolve("tests/fixtures/review/dany-laksono.json"),
  "utf8",
);

const FUTURE = JSON.stringify({
  version: 2,
  author: "Newer App",
  annotations: [
    {
      ...JSON.parse(FIXTURE).annotations[0],
      id: "future-1",
      author: "Newer App",
      body: "Readable one",
    },
    { id: "future-2", kind: "sticker" },
  ],
});

const hasEngine = existsSync(
  resolve("public/engines/texlyre/busytex/texlive-min-xelatex.data"),
);

/** A comment with the fields a check needs and nothing it does not. */
function commentAt(id: string, selectedText: string, y: number) {
  return {
    ...JSON.parse(FIXTURE).annotations[0],
    id,
    status: "open",
    replies: [],
    body: id,
    anchor: {
      kind: "text",
      page: 1,
      x: 72,
      y,
      width: 200,
      height: 14,
      selectedText,
    },
  };
}

async function openReviewedProject(
  page: Page,
  extra: Record<string, Uint8Array> = {},
) {
  await page.goto("/");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of (
      root as unknown as AsyncIterable<[string, FileSystemHandle]>
    )[Symbol.asyncIterator]()) {
      await root.removeEntry(name, { recursive: true });
    }
    localStorage.clear();
    await new Promise<void>((done) => {
      const deleting = indexedDB.deleteDatabase("opal-projects");
      deleting.onsuccess = () => done();
      deleting.onerror = () => done();
      deleting.onblocked = () => done();
    });
  });
  await page.goto("/");

  const archive = zipSync(
    {
      "main.tex": new TextEncoder().encode(
        "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
      ),
      "review/dany-laksono.json": new TextEncoder().encode(FIXTURE),
      "review/newer-app.json": new TextEncoder().encode(FUTURE),
      ...extra,
    },
    { mtime: Date.UTC(1980, 0, 1) },
  );
  await page.getByTestId("import-archive").setInputFiles({
    name: "reviewed.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  await page.getByTestId("open-project").first().click();
  await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByTestId("panel-review").click();
}

test.describe("review panel", () => {
  test("shows each reviewer's comments and counts the open ones", async ({
    page,
  }) => {
    await openReviewedProject(page);
    // Three from the fixture and one readable entry from the newer app.
    await expect(page.getByTestId("review-annotation")).toHaveCount(4);
    // Two open in the fixture, one open from the newer app.
    await expect(page.getByTestId("panel-review")).toContainText("3");
    await expect(page.getByText("read-only")).toBeVisible();
  });

  test("a file it cannot fully read offers no way to change it", async ({
    page,
  }) => {
    await openReviewedProject(page);
    const newer = page.getByRole("region", { name: "Comments by Newer App" });
    await expect(newer.getByTestId("review-annotation")).toHaveCount(1);
    await expect(newer.getByTestId("review-resolve")).toHaveCount(0);
    await expect(newer.getByTestId("review-delete")).toHaveCount(0);
  });

  test("resolving and replying survive a reload", async ({ page }) => {
    await openReviewedProject(page);
    await page.getByTestId("reviewer-name").fill("Test Reviewer");
    await page.getByTestId("reviewer-name").press("Enter");

    const mine = page.getByRole("region", { name: "Comments by Dany Laksono" });
    await mine
      .locator('[data-status="open"]')
      .first()
      .getByTestId("review-resolve")
      .click();
    await mine
      .locator('[data-status="open"]')
      .first()
      .getByTestId("review-reply")
      .fill("Added the citation");
    await mine
      .locator('[data-status="open"]')
      .first()
      .getByTestId("review-reply")
      .press("Enter");
    await expect(page.getByTestId("save-status")).toContainText(
      /^Saved · revision/,
    );

    await page.reload();
    await page.getByTestId("open-project").first().click();
    await expect(page.getByTestId("editor")).toBeVisible();
    // The layout is remembered, so the panel is already open: a click would
    // close it.
    await expect(page.getByTestId("review-panel")).toBeVisible();

    const reloaded = page.getByRole("region", {
      name: "Comments by Dany Laksono",
    });
    await expect(reloaded.locator('[data-status="resolved"]')).toHaveCount(2);
    await expect(reloaded.getByText("Added the citation")).toBeVisible();
    // The other product's file was never rewritten, so its entry is intact.
    await expect(
      page
        .getByRole("region", { name: "Comments by Newer App" })
        .getByTestId("review-annotation"),
    ).toHaveCount(1);
  });
});

test.describe("review anchors after a compile", () => {
  test.skip(!hasEngine, "engine assets absent");
  test.setTimeout(300_000);

  test("says when an annotation's text moved, and when it is gone", async ({
    page,
  }) => {
    const review = {
      version: 2,
      author: "Anchor Tester",
      annotations: [
        // The words are in the document, but the mark is a long way below them.
        commentAt("moved", "estimator remains unbiased", 650),
        commentAt("gone", "a sentence that was deleted entirely", 100),
      ],
    };
    await openReviewedProject(page, {
      "main.tex": new TextEncoder().encode(
        "\\documentclass{article}\n\\begin{document}\nThe estimator remains unbiased here.\n\\end{document}\n",
      ),
      "review/anchor-tester.json": new TextEncoder().encode(
        JSON.stringify(review, null, 2),
      ),
    });

    await page.getByTestId("compile-button").click();
    await expect(page.getByTestId("preview")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 280_000 },
    );

    const mine = page.getByRole("region", {
      name: "Comments by Anchor Tester",
    });
    await expect(
      mine.locator('[data-testid="review-annotation"]', { hasText: "moved" }),
    ).toContainText("text has moved", { timeout: 30_000 });
    await expect(
      mine.locator('[data-testid="review-annotation"]', { hasText: "gone" }),
    ).toContainText("no longer in the document");
    // Reported, not repaired: the file on disk is whatever it was.
    await expect(page.getByTestId("save-status")).not.toContainText(
      /^Saved · revision/,
    );
  });
});

test.describe("pinning a comment to the page", () => {
  test.skip(!hasEngine, "engine assets absent");
  test.setTimeout(300_000);

  /** Click a fraction of the way across and down the displayed page. */
  async function pin(page: Page, fx: number, fy: number, body: string) {
    await page.getByTestId("comment-mode").click();
    const canvas = page.getByTestId("preview-canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas");
    await canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
    await page.getByTestId("comment-draft-body").fill(body);
    await page.getByTestId("comment-draft-add").click();
  }

  test("stores the point in PDF coordinates, whatever the zoom", async ({
    page,
  }) => {
    await openReviewedProject(page);
    await page.getByTestId("compile-button").click();
    await expect(page.getByTestId("preview")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 280_000 },
    );

    // No name yet: the click is refused and the panel asks for one.
    await pin(page, 0.5, 0.25, "nameless");
    await expect(page.getByTestId("projects-error")).toContainText(
      "Set your name",
    );
    await page.getByTestId("reviewer-name").fill("Pin Tester");
    await page.getByTestId("reviewer-name").press("Enter");

    await pin(page, 0.5, 0.25, "at the default zoom");
    await page.getByTestId("zoom-in").click();
    await expect(page.getByTestId("preview")).toHaveAttribute(
      "data-status",
      "ready",
    );
    await pin(page, 0.5, 0.25, "after zooming in");

    const mine = page.getByRole("region", { name: "Comments by Pin Tester" });
    await expect(mine.getByTestId("review-annotation")).toHaveCount(2);
    await expect(page.getByTestId("save-status")).toContainText(
      /^Saved · revision/,
    );

    const saved = await page.evaluate(async () => {
      const find = async (
        dir: FileSystemDirectoryHandle,
      ): Promise<string | null> => {
        for await (const [name, handle] of (
          dir as unknown as AsyncIterable<[string, FileSystemHandle]>
        )[Symbol.asyncIterator]()) {
          if (handle.kind === "directory") {
            const found = await find(handle as FileSystemDirectoryHandle);
            if (found) return found;
          } else if (name === "review%2Fpin-tester.json") {
            return (await (handle as FileSystemFileHandle).getFile()).text();
          }
        }
        return null;
      };
      return find(await navigator.storage.getDirectory());
    });
    if (!saved) throw new Error("pin-tester.json was not written");
    const [first, second] = JSON.parse(saved).annotations;
    expect(first.anchor).toMatchObject({ kind: "point", page: 1 });
    // Half-way across a Letter or A4 page, a quarter of the way down.
    expect(first.anchor.x).toBeGreaterThan(0.5 * 590);
    expect(first.anchor.x).toBeLessThan(0.5 * 615);
    expect(first.anchor.y).toBeGreaterThan(0.25 * 790);
    expect(first.anchor.y).toBeLessThan(0.25 * 845);
    // The same click at another zoom lands on the same point of the page.
    expect(Math.abs(second.anchor.x - first.anchor.x)).toBeLessThan(2);
    expect(Math.abs(second.anchor.y - first.anchor.y)).toBeLessThan(2);
  });
});

test.describe("markers on the page", () => {
  test.skip(!hasEngine, "engine assets absent");
  test.setTimeout(300_000);

  /** Where the marker's tip sits, as a fraction of the displayed page. */
  async function tipFraction(page: Page) {
    const canvas = await page.getByTestId("preview-canvas").boundingBox();
    const marker = await page.getByTestId("page-marker").boundingBox();
    if (!canvas || !marker) throw new Error("canvas or marker not on screen");
    return {
      x: (marker.x - canvas.x) / canvas.width,
      y: (marker.y + marker.height - canvas.y) / canvas.height,
    };
  }

  test("a comment is drawn where it was placed, at any zoom, and selects", async ({
    page,
  }) => {
    await openReviewedProject(page);
    await page.getByTestId("compile-button").click();
    await expect(page.getByTestId("preview")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 280_000 },
    );
    await page.getByTestId("reviewer-name").fill("Marker Tester");
    await page.getByTestId("reviewer-name").press("Enter");

    await page.getByTestId("comment-mode").click();
    const canvas = page.getByTestId("preview-canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas");
    await canvas.click({
      position: { x: box.width * 0.5, y: box.height * 0.25 },
    });
    await page.getByTestId("comment-draft-body").fill("look here");
    await page.getByTestId("comment-draft-add").click();

    await expect(page.getByTestId("page-marker")).toHaveCount(1);
    const before = await tipFraction(page);
    expect(before.x).toBeCloseTo(0.5, 1);
    expect(before.y).toBeCloseTo(0.25, 1);

    await page.getByTestId("zoom-in").click();
    await expect(page.getByTestId("preview")).toHaveAttribute(
      "data-status",
      "ready",
    );
    const after = await tipFraction(page);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);

    await page.getByTestId("page-marker").click();
    await expect(
      page.locator('[data-testid="review-annotation"][data-selected="true"]'),
    ).toContainText("look here");
  });
});
