import { expect, test } from "@playwright/test";

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
