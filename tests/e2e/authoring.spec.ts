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
  // Back to the picker: importing is a thing you do to the collection, and
  // the workspace fills the window while a project is open.
  const home = page.getByTestId("close-project");
  if (await home.isVisible()) await home.click();

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
    await page.getByTestId("panel-outline").click();
    await expect(page.getByTestId("outline-entry")).toHaveText([
      "First",
      "Second",
      "Detail",
    ]);

    // Clicking an entry in another file opens that file. The outline is the
    // panel on screen, so the editor's own header is what says which.
    await page.getByTestId("outline-entry").nth(2).click();
    await expect(page.getByTestId("open-file-name")).toContainText(
      "chapter.tex",
    );
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
    await page.getByTestId("panel-health").click();
    await expect(page.getByTestId("project-health")).toContainText("1 problem");
    await expect(page.getByTestId("project-health")).toContainText(
      "No \\label{sec:one}",
    );

    await editor.fill("\\section{One}\\label{sec:one}\nSee \\ref{sec:one}.\n");
    await expect(page.getByTestId("project-health")).toContainText(
      "Nothing to report",
    );
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
    await expect(page.getByTestId("file-open")).toHaveText("paper.tex");
    await expect(page.getByTestId("compile-target")).toHaveText("paper.tex");
    await expect(editor).toContainText("section{One}");

    // And it is still there after a reload, which is the part a rename that
    // wrote the new name without removing the old one would also pass — so the
    // file count above is the assertion that matters.
    await page.reload();
    await page.getByTestId("open-project").first().click();
    await expect(page.getByTestId("file-open")).toHaveText("paper.tex");
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

  test("deleting a file while an image is open keeps the image an image", async ({
    page,
  }) => {
    await importProjectWithAssets(page);
    await page
      .locator('[data-testid="file-open"][data-path="figure.png"]')
      .click();
    await expect(page.getByTestId("asset-view")).toBeVisible();

    // The other door into the data-loss path: deleting *another* file re-opens
    // whatever was on screen, and that reader decoded everything as UTF-8. The
    // PNG would land in the text editor, one keystroke from being autosaved
    // over itself.
    await page
      .locator('[data-testid="file-delete"][data-path="reference.pdf"]')
      .click();

    await expect(page.getByTestId("asset-view")).toHaveAttribute(
      "data-kind",
      "image",
    );
    await expect(page.getByTestId("editor-content")).toHaveCount(0);
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
    await page.getByTestId("panel-health").click();
    await expect(page.getByTestId("project-health")).toContainText(
      "2 problems",
    );

    await page.getByTestId("panel-files").click();
    await page.getByTestId("new-file-name").fill("chapter.tex");
    await page.getByTestId("create-file").click();
    await expect(
      page.locator('[data-testid="file-open"][data-path="chapter.tex"]'),
    ).toHaveAttribute("aria-current", "true");
    await editor.fill("\\section{Elsewhere}\\label{sec:elsewhere}\n");

    await page.getByTestId("panel-health").click();
    await expect(page.getByTestId("project-health")).toContainText(
      "Nothing to report",
    );
  });
});

/**
 * The first structured editor (PLAN.md 14, Phase 3).
 *
 * Driven through the source it edits, because that is the only thing that
 * matters about it: what lands in the document, whether undo takes it back in
 * one step, and whether it refuses rather than guesses when the document has
 * moved underneath it.
 */
test.describe("table editor", () => {
  const TABLE = [
    "Before.",
    "\\begin{tabular}{lr}",
    "\\toprule",
    "Name & Count \\\\",
    "\\midrule",
    "apples & 3 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "",
  ].join("\n");

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
    await page.getByTestId("project-title").fill("Tables");
    await page.getByTestId("create-project").click();
    await page.getByTestId("open-project").first().click();
    await expect(page.getByTestId("editor")).toBeVisible();
  });

  /** The document as the editor holds it, one line per CodeMirror line. */
  async function sourceOf(page: Page): Promise<string> {
    // An empty line is rendered as a `<br>`, whose inner text is a newline.
    return (await page.locator(".cm-line").allInnerTexts())
      .map((line) => line.replace(/\n$/, ""))
      .join("\n");
  }

  test("edits a cell, adds a row, and undoes it in one step", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill(TABLE);
    await page.locator(".cm-line", { hasText: "apples" }).click();

    await expect(page.getByTestId("table-open")).toHaveText("Edit table");
    await page.getByTestId("table-open").click();
    const grid = page.getByTestId("table-editor");
    await expect(grid.getByTestId("table-cell")).toHaveCount(4);
    // Focus goes into the grid, not back to the button that opened it.
    await expect(grid.getByTestId("table-cell").first()).toBeFocused();
    // Every rule the table has, each where it sits — including the one above
    // the first row, which the grid keeps and therefore has to show.
    await expect(grid.locator(".table-rule")).toHaveText([
      "\\toprule",
      "\\midrule",
      "\\bottomrule",
    ]);

    await page.getByRole("textbox", { name: "Row 2, column 2" }).fill("30");
    await page.getByTestId("table-add-row").click();
    // Onto the new row, which is what adding one means.
    await expect(
      page.getByRole("textbox", { name: "Row 3, column 1" }),
    ).toBeFocused();
    await page.keyboard.type("pears");
    await page.getByTestId("table-apply").click();

    await expect(grid).toHaveCount(0);
    await expect
      .poll(() => sourceOf(page))
      .toBe(
        [
          "Before.",
          "\\begin{tabular}{lr}",
          "  \\toprule",
          "  Name   & Count \\\\",
          "  \\midrule",
          "  apples & 30 \\\\",
          "  pears  &  \\\\",
          "  \\bottomrule",
          "\\end{tabular}",
          "",
        ].join("\n"),
      );

    // One change, so one undo: a grid edit that took a dozen presses of
    // Ctrl+Z to reverse would be one nobody dared make.
    await page.keyboard.press("Control+z");
    await expect.poll(() => sourceOf(page)).toBe(TABLE);
  });

  test("inserts a table where there is none", async ({ page }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill("Results:");
    await editor.click();
    await page.keyboard.press("Control+End");

    await expect(page.getByTestId("table-open")).toHaveText("Insert table");
    await page.getByTestId("table-open").click();
    await page.getByRole("textbox", { name: "Row 1, column 1" }).fill("x");
    await page.keyboard.press("Control+Enter");

    await expect
      .poll(() => sourceOf(page))
      .toContain("Results:\n\\begin{tabular}{lll}\n  \\hline\n  x &  &  \\\\");
    // The cursor is left inside what was inserted, so it can be edited again.
    await expect(page.getByTestId("table-open")).toHaveText("Edit table");
  });

  test("Escape leaves the document alone and returns to it", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill(TABLE);
    await page.locator(".cm-line", { hasText: "apples" }).click();
    await page.getByTestId("table-open").click();
    await page.getByRole("textbox", { name: "Row 1, column 1" }).fill("Fruit");
    await page.keyboard.press("Escape");

    await expect(page.getByTestId("table-editor")).toHaveCount(0);
    await expect(editor).toBeFocused();
    expect(await sourceOf(page)).toBe(TABLE);
  });

  test("refuses to write over a table that moved while the grid was open", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill(TABLE);
    await page.locator(".cm-line", { hasText: "apples" }).click();
    await page.getByTestId("table-open").click();
    await page.getByRole("textbox", { name: "Row 2, column 1" }).fill("figs");

    // The source is still editable. Typing above the table shifts it, and a
    // grid that wrote back to the old offsets would cut through its first line.
    await page.locator(".cm-line", { hasText: "Before." }).click();
    await page.keyboard.press("Home");
    await page.keyboard.type("Much ");
    await page.getByTestId("table-apply").click();

    await expect(page.getByTestId("projects-error")).toContainText(
      "changed in the source",
    );
    expect(await sourceOf(page)).toBe(`Much ${TABLE}`);
  });

  test("says why a table cannot be edited as a grid", async ({ page }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill(TABLE.replace("apples & 3", "apples & 3 % recount"));
    await page.locator(".cm-line", { hasText: "apples" }).click();

    await expect(page.getByTestId("table-open")).toBeDisabled();
    await expect(page.getByTestId("table-refused")).toContainText("comments");
  });
});

/**
 * The citation picker, driven the way a writer uses it: by what they remember
 * about a work rather than by its key.
 */
test.describe("citation editor", () => {
  const BIB = [
    "@book{knuth1984, author = {Knuth, Donald E.}, title = {The {\\TeX}book}, year = {1984}}",
    '@article{godel1931, author = {G{\\"o}del, Kurt}, title = {On Formally Undecidable Propositions}, year = {1931}}',
    "@book{lamport1994, author = {Lamport, Leslie}, title = {{\\LaTeX}: A Document Preparation System}, year = {1994}}",
    "",
  ].join("\n");

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
    await page.getByTestId("project-title").fill("Citations");
    await page.getByTestId("create-project").click();
    await page.getByTestId("open-project").first().click();
    await expect(page.getByTestId("editor")).toBeVisible();

    await page.getByTestId("new-file-name").fill("refs.bib");
    await page.getByTestId("create-file").click();
    await expect(
      page.locator('[data-testid="file-open"][data-path="refs.bib"]'),
    ).toHaveAttribute("aria-current", "true");
    await page.getByTestId("editor-content").fill(BIB);
    await page
      .locator('[data-testid="file-open"][data-path="main.tex"]')
      .click();
    // Waited for: the switch reads storage first, and filling before it lands
    // writes the test's "main.tex" into the bibliography's editor instead.
    await expect(
      page.locator('[data-testid="file-open"][data-path="main.tex"]'),
    ).toHaveAttribute("aria-current", "true");
  });

  /**
   * Put the cursor inside the citation at the end of a line.
   *
   * A click lands in the middle of the line's box, which spans the editor's
   * width — past the end of a short line, and so outside its `\cite`.
   */
  async function intoCitation(page: Page, text: string) {
    await page.locator(".cm-line", { hasText: text }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
  }

  /** The document as the editor holds it, one line per CodeMirror line. */
  async function sourceOf(page: Page): Promise<string> {
    return (await page.locator(".cm-line").allInnerTexts())
      .map((line) => line.replace(/\n$/, ""))
      .join("\n");
  }

  test("finds a work by author, adds it, and undoes in one step", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill("As shown by \\cite{knuth1984}.");
    await intoCitation(page, "knuth");

    await expect(page.getByTestId("citation-open")).toHaveText("Edit citation");
    await page.getByTestId("citation-open").click();
    const picker = page.getByTestId("citation-editor");
    // Straight into the search, which is what the picker is for.
    await expect(page.getByTestId("citation-search")).toBeFocused();
    await expect(picker.getByTestId("citation-selected")).toContainText(
      "Knuth (1984). The TeXbook",
    );

    // Accents folded: nobody types the umlaut to find Gödel.
    await page.keyboard.type("godel");
    await expect(page.getByTestId("citation-count")).toHaveText("1 match");
    await page
      .locator('[data-testid="citation-result"][data-key="godel1931"]')
      .check();
    await page.getByTestId("citation-apply").click();

    await expect(picker).toHaveCount(0);
    await expect
      .poll(() => sourceOf(page))
      .toBe("As shown by \\cite{knuth1984,godel1931}.");

    await page.keyboard.press("Control+z");
    await expect
      .poll(() => sourceOf(page))
      .toBe("As shown by \\cite{knuth1984}.");
  });

  test("Enter adds the top match, or a key the bibliography lacks", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill("See ");
    await editor.click();
    await page.keyboard.press("Control+End");

    await expect(page.getByTestId("citation-open")).toHaveText(
      "Insert citation",
    );
    await page.getByTestId("citation-open").click();
    await page.keyboard.type("1994 lamport");
    await page.keyboard.press("Enter");
    // A key from a `.bib` outside the project: kept, and said to be missing.
    await page.keyboard.type("external2020");
    await expect(page.getByTestId("citation-count")).toContainText(
      "Enter adds it as a key",
    );
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("citation-selected")).toContainText(
      "not in this project's bibliography",
    );
    await page.keyboard.press("Control+Enter");

    await expect
      .poll(() => sourceOf(page))
      .toBe("See \\cite{lamport1994,external2020}");
    // Left on the citation it wrote, so it can be reopened at once.
    await expect(page.getByTestId("citation-open")).toHaveText("Edit citation");
  });

  test("keeps both notes, and Escape leaves the document alone", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    const source = "\\usepackage{natbib}\nSee \\citep[see][p.~4]{knuth1984}.";
    await editor.fill(source);
    await intoCitation(page, "p.~4");
    await page.getByTestId("citation-open").click();

    await expect(page.getByTestId("citation-prenote")).toHaveValue("see");
    await expect(page.getByTestId("citation-postnote")).toHaveValue("p.~4");
    // natbib is loaded, so its commands are offered alongside the one in use.
    // A listbox rather than a native select, as on desktop: the options exist
    // once it is open.
    await page.getByTestId("citation-command").click();
    await expect(page.getByRole("option")).toContainText([
      "\\cite",
      "\\citep",
      "\\citet",
    ]);
    await page.keyboard.press("Escape");

    await page.getByTestId("citation-postnote").fill("ch.~2");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("citation-editor")).toHaveCount(0);
    await expect(editor).toBeFocused();
    expect(await sourceOf(page)).toBe(source);
  });

  test("refuses to write over a citation that moved while open", async ({
    page,
  }) => {
    const editor = page.getByTestId("editor-content");
    await editor.fill("First.\nSee \\cite{knuth1984}.");
    await intoCitation(page, "knuth");
    await page.getByTestId("citation-open").click();
    await page.keyboard.type("lamport");
    await page.keyboard.press("Enter");

    await page.locator(".cm-line", { hasText: "First." }).click();
    await page.keyboard.press("Home");
    await page.keyboard.type("Very ");
    await page.getByTestId("citation-apply").click();

    await expect(page.getByTestId("projects-error")).toContainText(
      "citation changed in the source",
    );
    expect(await sourceOf(page)).toBe("Very First.\nSee \\cite{knuth1984}.");
  });
});
