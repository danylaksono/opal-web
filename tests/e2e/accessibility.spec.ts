import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Keyboard and screen-reader parity for the core workflow
 * (PLAN.md 13.1 item 8, and Phase 3's exit criteria).
 *
 * Two kinds of test, because they fail in different ways:
 *
 * - **axe** catches what is *absent* — a button with no accessible name, a
 *   region nobody can reach, text that does not meet contrast. It is
 *   mechanical, it has no opinions about workflow, and it will not notice that
 *   a keyboard user cannot compile.
 * - **the keyboard paths below** catch what is *unusable*: reaching the compile
 *   button by tabbing, having the status said out loud, and getting focus back
 *   somewhere sensible after the thing you were on disappears.
 *
 * Neither replaces trying it with a screen reader, which has not been done and
 * is recorded as not done in PLAN.md.
 */

/**
 * Serious and critical only, deliberately.
 *
 * axe's "minor" and "moderate" findings on this app are mostly advisory
 * (landmark structure on a page that is one panel), and a gate that fails on
 * advice is a gate people disable. The two levels kept are the ones that stop
 * somebody using the product.
 */
async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    )
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}) on ${violation.nodes
          .map((node) => node.target.join(" "))
          .join(", ")}`,
    );
}

async function clearStorage(page: Page) {
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
}

test.describe("accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearStorage(page);
    await page.goto("/");
  });

  test("the project list has no serious violations", async ({ page }) => {
    expect(await seriousViolations(page)).toEqual([]);
  });

  test("the editor and its panels have no serious violations", async ({
    page,
  }) => {
    await page.getByTestId("project-title").fill("Accessible");
    await page.getByTestId("create-project").click();
    await page.getByTestId("open-project").first().click();
    await expect(page.getByTestId("editor")).toBeVisible();

    // With something to show in every panel: an outline, a problem, and the
    // file list with more than one entry in it.
    await page
      .getByTestId("editor-content")
      .fill("\\section{One}\nSee \\ref{sec:nowhere}.\n");
    await page.getByTestId("new-file-name").fill("chapter.tex");
    await page.getByTestId("create-file").click();
    await expect(page.getByTestId("file-open")).toHaveCount(2);
    await page.getByTestId("outline").click();

    expect(await seriousViolations(page)).toEqual([]);
  });

  test("save and compile status are announced, not just shown", async ({
    page,
  }) => {
    await page.getByTestId("project-title").fill("Announced");
    await page.getByTestId("create-project").click();
    await page.getByTestId("open-project").first().click();

    // `role="status"` is what makes a change here reach a screen reader at all.
    // Without it the save status is a paragraph that silently changes, which
    // is exactly the failure PLAN.md 13.1 names.
    await expect(page.getByTestId("save-status")).toHaveAttribute(
      "role",
      "status",
    );
    await expect(page.getByTestId("workspace-status")).toHaveAttribute(
      "role",
      "status",
    );

    await page.getByTestId("editor-content").fill("typed");
    await expect(page.getByTestId("save-status")).toContainText("Saved at");
  });

  test("focus lands somewhere after the file it was on is deleted", async ({
    page,
  }) => {
    await page.getByTestId("project-title").fill("Focus");
    await page.getByTestId("create-project").click();
    await page.getByTestId("open-project").first().click();
    await page.getByTestId("new-file-name").fill("notes.tex");
    await page.getByTestId("create-file").click();
    await expect(page.getByTestId("file-open")).toHaveCount(2);

    await page
      .locator('[data-testid="file-delete"][data-path="notes.tex"]')
      .click();

    // The button that was pressed no longer exists. Focus has to go somewhere
    // deliberate, or a keyboard user is returned to the top of the document
    // with no idea where they are.
    await expect(page.locator(":focus")).toHaveAttribute(
      "data-path",
      "main.tex",
    );
  });

  test("the main file is named, not starred, for a screen reader", async ({
    page,
  }) => {
    await page.getByTestId("project-title").fill("Named");
    await page.getByTestId("create-project").click();
    await page.getByTestId("open-project").first().click();

    // The star is a picture. What is read aloud has to say the same thing.
    await expect(page.getByTestId("file-open")).toHaveAttribute(
      "aria-label",
      "main.tex, main file",
    );
  });

  test("a project can be created and opened with the keyboard alone", async ({
    page,
  }) => {
    // No clicks in this test at all. A workflow that needs a pointer is not
    // available to a keyboard user, and that is most of the point.
    await page.keyboard.press("Tab");
    while (
      !(await page.evaluate(
        () =>
          document.activeElement?.getAttribute("data-testid") ===
          "project-title",
      ))
    ) {
      await page.keyboard.press("Tab");
    }
    await page.keyboard.type("By keyboard");

    // Tabbed to rather than assumed to be next: this used to assert that the
    // button follows the title field, and adding the template picker between
    // them broke a test about reachability over a change to the order. What
    // matters is that tabbing gets there, and an unreachable control still
    // fails this — by never arriving.
    while (
      !(await page.evaluate(
        () =>
          document.activeElement?.getAttribute("data-testid") ===
          "create-project",
      ))
    ) {
      await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("project-row")).toBeVisible();
    while (
      !(await page.evaluate(
        () =>
          document.activeElement?.getAttribute("data-testid") ===
          "open-project",
      ))
    ) {
      await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("editor")).toBeVisible();
  });
});
