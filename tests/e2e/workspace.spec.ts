import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Phase 2's exit criteria, through the product rather than a spike
 * (PLAN.md 14).
 *
 * Everything below was verified by hand during the work that produced it, by a
 * throwaway script that lived outside the repository — which protected nothing.
 * Four defects found in that session would each have passed every test that
 * existed at the time, because every test that existed either stopped at the
 * ports or drove the corpus, and the corpus is not a product:
 *
 * - the default font path, which 12 of 13 corpus documents avoid by loading
 *   `fontenc`, so the first document a user creates was the first to try it;
 * - a boot package with no `ls-R`, which made everything mounted under
 *   `texmf-dist` invisible to kpathsea;
 * - a stale pre-compressed asset served in place of the one just built;
 * - cancellation that returned control 180 seconds after the abort.
 *
 * None of them is visible from a unit test, and all of them are visible from
 * "create a project, press Compile, look at the page".
 */

/**
 * Skipped without the engine assets.
 *
 * They are 700 MB plus a built boot package, gitignored, and fetched by
 * `./scripts/download-texlyre-assets.sh` and `pnpm spike:texlive-min --write`.
 * A checkout that has not done that should not fail this suite; it should say
 * why it is not running it.
 */
const BOOT_PACKAGE = resolve(
  "public/engines/texlyre/busytex/texlive-min-xelatex.data",
);
const hasEngine = existsSync(BOOT_PACKAGE);

test.describe("compile and preview", () => {
  test.skip(
    !hasEngine,
    "engine assets absent: ./scripts/download-texlyre-assets.sh && pnpm spike:texlive-min xelatex --write",
  );

  // A cold first compile fetches ~22 MB and initialises the engine before TeX
  // runs at all, so the default 60 s is a timeout on the environment rather
  // than on the behaviour under test.
  test.setTimeout(300_000);

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
  });

  async function openWorkspace(page: import("@playwright/test").Page) {
    await page.getByTestId("project-title").fill("Compile and preview");
    await page.getByTestId("create-project").click();
    // The list is re-read after the write lands, so the row is not there yet.
    await expect(page.getByTestId("project-row")).toBeVisible();
    await page.getByTestId("open-project").first().click();
    await expect(page.getByTestId("workspace")).toBeVisible();
  }

  test("a new project compiles and renders a page with ink on it", async ({
    page,
  }) => {
    await openWorkspace(page);
    await page.getByTestId("compile-button").click();

    await expect(page.getByTestId("workspace-status")).toHaveAttribute(
      "data-status",
      "done",
      { timeout: 280_000 },
    );
    // The starter document has no `fontenc`, so this is the default Unicode
    // font path: the one the corpus does not cover and the one that broke.
    await expect(page.getByTestId("workspace-status")).toContainText(
      "Compiled",
    );
    await expect(page.getByTestId("workspace-engine")).toContainText(
      "texlive-2026",
    );

    await expect(page.getByTestId("preview")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 60_000 },
    );

    // A blank canvas is what a broken render looks like, and it is also what a
    // canvas that was never drawn looks like, so the pixels are the assertion.
    const inked = await page.evaluate(() => {
      const canvas = document.querySelector(
        '[data-testid="preview-canvas"]',
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
    expect(inked).toBeGreaterThan(1000);
  });

  test("the reader's page survives a recompile", async ({ page }) => {
    await openWorkspace(page);
    // Three pages, so there is somewhere to be other than the first.
    await page
      .getByTestId("editor-content")
      .fill(
        "\\documentclass{article}\n\\begin{document}\nOne\n\\newpage\nTwo\n\\newpage\nThree\n\\end{document}\n",
      );
    await page.getByTestId("compile-button").click();
    await expect(page.getByTestId("preview")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 280_000 },
    );
    await expect(page.getByTestId("preview")).toContainText("Page 1 of 3");

    await page.getByTestId("next-page").click();
    await expect(page.getByTestId("preview")).toContainText("Page 2 of 3");

    // Recompiling is what a user does after every edit. Landing back on page 1
    // each time is the behaviour that makes a preview feel like it is fighting
    // you, and it is what this asserts against.
    await page.getByTestId("compile-button").click();
    await expect(page.getByTestId("workspace-status")).toHaveAttribute(
      "data-status",
      "done",
      { timeout: 280_000 },
    );
    await expect(page.getByTestId("preview")).toContainText("Page 2 of 3");
  });

  test("zoom re-renders the page rather than stretching it", async ({
    page,
  }) => {
    await openWorkspace(page);
    await page.getByTestId("compile-button").click();
    await expect(page.getByTestId("preview")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 280_000 },
    );

    const width = () =>
      page.evaluate(
        () =>
          (
            document.querySelector(
              '[data-testid="preview-canvas"]',
            ) as HTMLCanvasElement
          ).width,
      );
    const before = await width();
    await page.getByTestId("zoom-in").click();
    await expect(page.getByTestId("zoom-level")).toHaveText("150%");

    // The canvas itself is larger, which is the difference between rendering
    // at a scale and scaling a bitmap: only one of them stays sharp.
    await expect.poll(width).toBeGreaterThan(before);
  });

  test("cancelling returns control instead of hanging", async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId("compile-button").click();
    await expect(page.getByTestId("workspace-status")).toHaveAttribute(
      "data-status",
      "compiling",
    );

    await page.getByTestId("cancel-button").click();

    // The measurement that found this had the adapter awaiting a promise the
    // terminated worker would never settle, so control came back after three
    // minutes. Ten seconds is generous and still fails that.
    await expect(page.getByTestId("workspace-status")).toHaveAttribute(
      "data-status",
      "idle",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("compile-button")).toBeEnabled();
  });

  test("typing is not blocked while the engine works", async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId("compile-button").click();
    await expect(page.getByTestId("workspace-status")).toHaveAttribute(
      "data-status",
      "compiling",
    );

    // Typed a key at a time rather than filled: each keystroke needs its own
    // turn of the main thread, so this fails by timing out if the engine ever
    // moves off its worker — which is the only way "the UI stays responsive
    // during compilation" (PLAN.md 14, Phase 2) can be observed from outside.
    const editor = page.getByTestId("editor-content");
    await editor.click();
    await editor.pressSequentially("% typed while compiling", { delay: 20 });
    await expect(editor).toHaveValue(/% typed while compiling/);

    // And the edit is not merely on screen: autosave runs on the same thread
    // and has to have got its turn too, or the keystrokes are lost on reload.
    await expect(page.getByTestId("save-status")).toContainText("Saved at", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("workspace-status")).toHaveAttribute(
      "data-status",
      "done",
      { timeout: 280_000 },
    );
  });

  test("a failed compile is recoverable without losing the edit", async ({
    page,
  }) => {
    await openWorkspace(page);
    const editor = page.getByTestId("editor-content");
    await editor.fill(
      "\\documentclass{article}\n\\begin{document}\n\\error\n\\end{document}\n",
    );
    await page.getByTestId("compile-button").click();
    await expect(page.getByTestId("workspace-status")).toContainText("Failed", {
      timeout: 280_000,
    });

    // The engine is torn down and rebuilt after a failure it did not model, so
    // the question this answers is whether the *next* compile runs at all —
    // "worker failures recover without losing edits", from the outside. The
    // editor still holding the source is half of it; a page coming back is the
    // other half.
    await expect(editor).toHaveValue(/\\error/);
    await editor.fill(
      "\\documentclass{article}\n\\begin{document}\nRecovered\n\\end{document}\n",
    );
    await page.getByTestId("compile-button").click();
    await expect(page.getByTestId("preview")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 280_000 },
    );
    await expect(page.getByTestId("workspace-status")).toContainText(
      "Compiled",
    );
  });

  test("a second file compiles into the document", async ({ page }) => {
    await openWorkspace(page);

    // The compile path has taken every project file since it was written, and
    // nothing could exercise it: there was no way to make a project with two
    // files in it. This is that path, end to end.
    await page.getByTestId("new-file-name").fill("chapter.tex");
    await page.getByTestId("create-file").click();
    // Addressed by path, not by position: `listFiles` promises a stable order
    // and that order is the repository's business, not this test's.
    await expect(
      page.locator('[data-testid="file-open"][data-path="chapter.tex"]'),
    ).toHaveAttribute("aria-current", "true");
    await page
      .getByTestId("editor-content")
      .fill("Chapter one\n\\newpage\nChapter two\n");

    // Switching files flushes the autosave, so the compile reads this chapter
    // from disk rather than from the editor — which is what makes the page
    // count below evidence about storage and not just about the textarea.
    await page
      .locator('[data-testid="file-open"][data-path="main.tex"]')
      .click();
    await expect(page.getByTestId("editor-content")).toHaveValue(
      /documentclass/,
    );
    await page
      .getByTestId("editor-content")
      .fill(
        "\\documentclass{article}\n\\begin{document}\n\\input{chapter}\n\\end{document}\n",
      );

    // Compiling while `main.tex` is open, and it says so: the button follows
    // the project's main file, not the editor's.
    await expect(page.getByTestId("compile-target")).toHaveText("main.tex");
    await page.getByTestId("compile-button").click();
    await expect(page.getByTestId("preview")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 280_000 },
    );
    // Two pages only if `chapter.tex` arrived: the main file's own body is one
    // \input and nothing else.
    await expect(page.getByTestId("preview")).toContainText("Page 1 of 2");
  });

  test("the main file cannot be deleted, and another can", async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId("new-file-name").fill("notes.tex");
    await page.getByTestId("create-file").click();
    await expect(page.getByTestId("file-open")).toHaveCount(2);

    // A project whose main file is gone cannot compile and offers no way back,
    // so the button is not there to press.
    await expect(
      page.locator('[data-testid="file-delete"][data-path="main.tex"]'),
    ).toHaveCount(0);

    await page
      .locator('[data-testid="file-delete"][data-path="notes.tex"]')
      .click();
    await expect(page.getByTestId("file-open")).toHaveCount(1);
    // Deleting the open file falls back to the main file rather than to a
    // blank editor with nowhere to go.
    await expect(page.getByTestId("editor-content")).toHaveValue(
      /documentclass/,
    );
  });

  test("a failed compile shows the engine log", async ({ page }) => {
    await openWorkspace(page);
    // `\error` is not a control sequence, so TeX stops. The point is not the
    // error: it is that a failure is legible without opening the console.
    await page
      .getByTestId("editor-content")
      .fill(
        "\\documentclass{article}\n\\begin{document}\n\\error\n\\end{document}\n",
      );
    await page.getByTestId("compile-button").click();

    await expect(page.getByTestId("workspace-status")).toHaveAttribute(
      "data-status",
      "done",
      { timeout: 280_000 },
    );
    await expect(page.getByTestId("workspace-status")).toContainText("Failed");
    await expect(page.getByTestId("workspace-log")).toBeVisible();
  });
});
