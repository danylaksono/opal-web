import { expect, test } from "@playwright/test";

/**
 * Phase 1's storage exit criteria, in a real browser (PLAN.md 14).
 *
 * The unit suite proves the contract against an in-memory repository, which
 * cannot fail the way storage fails: it has no quota, no eviction, and nothing
 * survives it. The claims worth testing here are the ones that only mean
 * something with OPFS and IndexedDB underneath — that a project is still there
 * after a reload, and that deleting it takes the bytes with it.
 */

async function clearStorage(page: import("@playwright/test").Page) {
  // A fresh origin per test, since these assert on what persisted.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of (
      root as unknown as AsyncIterable<[string, FileSystemHandle]>
    )[Symbol.asyncIterator]()) {
      await root.removeEntry(name, { recursive: true });
    }
    await new Promise<void>((resolve) => {
      const deleting = indexedDB.deleteDatabase("opal-projects");
      deleting.onsuccess = () => {
        resolve();
      };
      deleting.onerror = () => {
        resolve();
      };
      deleting.onblocked = () => {
        resolve();
      };
    });
  });
}

test.describe("project storage", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearStorage(page);
    await page.reload();
  });

  test("a created project survives a reload", async ({ page }) => {
    await expect(page.getByTestId("projects-empty")).toBeVisible();

    await page.getByTestId("project-title").fill("Thesis");
    await page.getByTestId("create-project").click();
    await expect(page.getByTestId("project-row")).toHaveCount(1);
    await expect(page.getByTestId("project-row-title")).toHaveText("Thesis");

    // The whole point of Phase 1: the bytes are still there afterwards.
    await page.reload();
    await expect(page.getByTestId("project-row-title")).toHaveText("Thesis");
  });

  test("deleting a project removes it and its files", async ({ page }) => {
    await page.getByTestId("project-title").fill("Temporary");
    await page.getByTestId("create-project").click();
    await expect(page.getByTestId("project-row")).toHaveCount(1);

    await page.getByTestId("delete-project").click();
    await expect(page.getByTestId("projects-empty")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("projects-empty")).toBeVisible();

    // The record is gone; so is the directory that held its files.
    const remaining = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const projects = await root.getDirectoryHandle("projects", {
        create: true,
      });
      let count = 0;
      for await (const _entry of (
        projects as unknown as AsyncIterable<[string, FileSystemHandle]>
      )[Symbol.asyncIterator]()) {
        count++;
      }
      return count;
    });
    expect(remaining).toBe(0);
  });

  test("a project keeps its revision across a reload", async ({ page }) => {
    await page.getByTestId("project-title").fill("Revisioned");
    await page.getByTestId("create-project").click();

    const revision = await page
      .getByTestId("project-row-revision")
      .textContent();
    await page.reload();
    await expect(page.getByTestId("project-row-revision")).toHaveText(
      revision ?? "",
    );
  });

  test("two projects can be told apart after a reload", async ({ page }) => {
    for (const title of ["First", "Second"]) {
      await page.getByTestId("project-title").fill(title);
      await page.getByTestId("create-project").click();
    }
    await expect(page.getByTestId("project-row")).toHaveCount(2);

    await page.reload();
    await expect(page.getByTestId("project-row")).toHaveCount(2);
    await expect(page.getByTestId("project-row-title")).toHaveText([
      "Second",
      "First",
    ]);
  });
});
