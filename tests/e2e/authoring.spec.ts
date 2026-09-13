import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { zipSync } from "fflate";

/**
 * A project with a figure and a PDF in it, delivered the way a user gets one.
 *
 * Nothing in the product creates a binary file — `Add file` makes empty text —
 * so an import is the only honest way to have one, and it is also how a real
 * project arrives. The PDF is the corpus's own reference output, which is a
 * real PDF rather than a fixture pretending to be one.
 */
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function importProjectWithAssets(page: Page) {
  const archive = zipSync(
    {
      "main.tex": new TextEncoder().encode(
        "\\documentclass{article}\n\\begin{document}\n\\includegraphics{figure.png}\n\\end{document}\n",
      ),
      "figure.png": new Uint8Array(PIXEL_PNG),
      "reference.pdf": new Uint8Array(
        readFileSync(
          resolve("tests/fixtures/compiler-corpus/blank/main.reference.pdf"),
        ),
      ),
    },
    { mtime: Date.UTC(1980, 0, 1) },
  );

  await page.getByTestId("import-archive").setInputFiles({
    name: "withassets.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  await expect(page.getByTestId("project-row")).toHaveCount(2);
  // By title, not by position: the list is ordered most-recently-opened first,
  // so "the last row" is whichever project this test did not just import.
  await page
    .getByTestId("project-row")
    .filter({ hasText: "withassets" })
    .getByTestId("open-project")
    .click();
  await expect(
    page.locator('[data-testid="file-open"][data-path="figure.png"]'),
  ).toBeVisible();
}

/**
 * The authoring surface over the semantic index (PLAN.md 14, Phase 3).
 *
 * Separate from `workspace.spec.ts` because none of this needs the engine: the
 * index is the part of the product that answers questions *without* compiling,
 * which is most of what a person does between compiles. These tests run in a
 * checkout with no engine assets at all.
 */

test.describe("outline and project health", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of (
        root as unknown as AsyncIterable<[string, FileSystemHandle]>
      )[Symbol.asyncIterator]()) {
        await root.removeEntry(name, { recursive: true });
      }
      await new Promise<void>((resolve) => {
        const deleting = indexedDB.deleteDatabase("opal-projects");
        deleting.onsuccess = () => resolve();
        deleting.onerror = () => resolve();
        deleting.onblocked = () => resolve();
      });
    });
    await page.goto("/");
    await page.getByTestId("project-title").fill("Authoring");
    await page.getByTestId("create-project").click();
    await page.getByTestId("open-project").first().click();
    await expect(page.getByTestId("editor")).toBeVisible();
  });

  test("the outline spans files and jumps to a section", async ({ page }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill("\\section{First}\n\\input{chapter}\n");

    await page.getByTestId("new-file-name").fill("chapter.tex");
    await page.getByTestId("create-file").click();
    await expect(
      page.locator('[data-testid="file-open"][data-path="chapter.tex"]'),
    ).toHaveAttribute("aria-current", "true");
    await editor.fill("\\section{Second}\n\\subsection{Detail}\n");

    await page
      .locator('[data-testid="file-open"][data-path="main.tex"]')
      .click();

    // Reading order, not file order: the chapter's sections appear where the
    // `\input` puts them, which is the only thing that makes an outline of a
    // split-up document worth showing.
    await page.getByTestId("outline").click();
    await expect(page.getByTestId("outline-entry")).toHaveText([
      "First",
      "Second",
      "Detail",
    ]);

    // Clicking an entry in another file opens that file.
    await page.getByTestId("outline-entry").nth(2).click();
    await expect(
      page.locator('[data-testid="file-open"][data-path="chapter.tex"]'),
    ).toHaveAttribute("aria-current", "true");
  });

  test("completing a reference offers the project's own labels", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill("\\section{One}\\label{sec:one}\n");

    // Typed rather than filled: completion is a response to input, and `fill`
    // sets the document without producing any.
    await editor.click();
    await page.keyboard.press("Control+End");
    await editor.pressSequentially("See \\ref{sec", { delay: 20 });

    const option = page.locator(".cm-tooltip-autocomplete li").first();
    await expect(option).toHaveText("sec:one");
    await option.click();

    // The key a user cannot hold in their head, spelled exactly: a `\ref` to a
    // label that does not exist renders as `??` and says nothing else.
    await expect(editor).toContainText("\\ref{sec:one");
  });

  test("completing a citation offers keys from the bibliography", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill("\\cite{}\n");

    await page.getByTestId("new-file-name").fill("refs.bib");
    await page.getByTestId("create-file").click();
    await expect(
      page.locator('[data-testid="file-open"][data-path="refs.bib"]'),
    ).toHaveAttribute("aria-current", "true");
    await editor.fill("@book{knuth1984, title={The TeXbook}}\n");

    await page
      .locator('[data-testid="file-open"][data-path="main.tex"]')
      .click();
    await editor.click();
    await page.keyboard.press("Control+End");
    await editor.pressSequentially("\\cite{knu", { delay: 20 });

    await expect(
      page.locator(".cm-tooltip-autocomplete li").first(),
    ).toHaveText("knuth1984");
  });

  test("project health reports a dangling reference and clears it", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill("See \\ref{sec:one}.\n");

    // No compile: this is the half of "is my document right" that does not
    // need TeX, and the half a user meets first.
    await expect(page.getByTestId("project-health")).toContainText("1 problem");
    await expect(page.getByTestId("project-health")).toContainText(
      "No \\label{sec:one}",
    );

    await editor.fill("\\section{One}\\label{sec:one}\nSee \\ref{sec:one}.\n");
    await expect(page.getByTestId("project-health")).toHaveCount(0);
  });

  test("a problem is marked in the gutter of the line it is on", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill("\\section{One}\n\nSee \\ref{sec:nowhere}.\n");

    // The list says the project has a problem; the gutter says where, on the
    // line the cursor is near. Both, because a writer scrolling through a
    // chapter is not reading a list.
    const marker = page.locator(".cm-lint-marker-warning");
    await expect(marker).toHaveCount(1);

    await editor.fill("\\section{One}\\label{sec:nowhere}\n");
    await expect(marker).toHaveCount(0);
  });

  test("renaming the main file keeps the project compiling", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill("\\section{One}\n");

    await page.getByTestId("rename-to").fill("paper.tex");
    await page.getByTestId("rename-file").click();

    await expect(
      page.locator('[data-testid="file-open"][data-path="paper.tex"]'),
    ).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("file-open")).toHaveCount(1);
    // The star marks the compile target, and the record's root file follows a
    // rename — otherwise the button would point at a name nothing has.
    await expect(page.getByTestId("file-open")).toHaveText("paper.tex ★");
    await expect(page.getByTestId("compile-target")).toHaveText("paper.tex");
    await expect(editor).toContainText("section{One}");

    // And it is still there after a reload, which is the part a rename that
    // wrote the new name without removing the old one would also pass — so the
    // file count above is the assertion that matters.
    await page.reload();
    await page.getByTestId("open-project").first().click();
    await expect(page.getByTestId("file-open")).toHaveText("paper.tex ★");
  });

  test("an image opens as a picture, not as text", async ({ page }) => {
    await importProjectWithAssets(page);
    await page
      .locator('[data-testid="file-open"][data-path="figure.png"]')
      .click();

    // The editor is not merely ugly for a PNG: its bytes would be decoded as
    // UTF-8, and the first keystroke would autosave that back over the image.
    await expect(page.getByTestId("asset-view")).toHaveAttribute(
      "data-kind",
      "image",
    );
    await expect(page.getByTestId("editor-content")).toHaveCount(0);
    await expect(page.getByTestId("asset-image")).toBeVisible();
  });

  test("a PDF opens through the renderer the product already has", async ({
    page,
  }) => {
    await importProjectWithAssets(page);
    await page
      .locator('[data-testid="file-open"][data-path="reference.pdf"]')
      .click();

    await expect(page.getByTestId("asset-view")).toHaveAttribute(
      "data-kind",
      "pdf",
    );
    // Drawn, not merely present: a canvas that was never painted looks exactly
    // like one whose render failed.
    await expect(page.getByTestId("asset-view")).toContainText("1 page", {
      timeout: 30_000,
    });
    const inked = await page.evaluate(() => {
      const canvas = document.querySelector(
        '[data-testid="asset-canvas"]',
      ) as HTMLCanvasElement;
      const pixels = canvas
        .getContext("2d")
        ?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!pixels) return 0;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] !== 255 || pixels[i + 1] !== 255 || pixels[i + 2] !== 255)
          count += 1;
      }
      return count;
    });
    expect(inked).toBeGreaterThan(0);
  });

  test("a rename onto an existing file is refused", async ({ page }) => {
    await page.getByTestId("new-file-name").fill("notes.tex");
    await page.getByTestId("create-file").click();
    await expect(
      page.locator('[data-testid="file-open"][data-path="notes.tex"]'),
    ).toHaveAttribute("aria-current", "true");

    await page.getByTestId("rename-to").fill("main.tex");
    await page.getByTestId("rename-file").click();

    // Refused rather than silently overwriting `main.tex`, and said out loud:
    // the user who typed the name is the one who can pick another.
    await expect(page.getByTestId("projects-error")).toContainText(
      "already has main.tex",
    );
    await expect(page.getByTestId("file-open")).toHaveCount(2);
  });

  test("a reference resolves against a label in another file", async ({
    page,
  }) => {
    // The cross-file case is the whole reason the index is a project-level
    // thing rather than a per-file one, and it is invisible to the compiler
    // until a compile finishes.
    const editor = page.getByTestId("editor-content");
    await editor.fill("\\input{chapter}\nSee \\ref{sec:elsewhere}.\n");
    // Two, not one: the `\input` names a file the project does not have yet,
    // which is the same mistake as a misspelled filename and is reported the
    // same way. Creating the file below fixes both at once.
    await expect(page.getByTestId("project-health")).toContainText(
      "2 problems",
    );

    await page.getByTestId("new-file-name").fill("chapter.tex");
    await page.getByTestId("create-file").click();
    await expect(
      page.locator('[data-testid="file-open"][data-path="chapter.tex"]'),
    ).toHaveAttribute("aria-current", "true");
    await editor.fill("\\section{Elsewhere}\\label{sec:elsewhere}\n");

    await expect(page.getByTestId("project-health")).toHaveCount(0);
  });
});
