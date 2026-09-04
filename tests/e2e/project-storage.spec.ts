import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

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

test.describe("archive round trip", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearStorage(page);
    await page.reload();
  });

  test("an exported project imports back with its files intact", async ({
    page,
  }) => {
    // Phase 1's exit criterion: exported projects round-trip without data loss.
    await page.getByTestId("project-title").fill("Roundtrip");
    await page.getByTestId("create-project").click();
    await expect(page.getByTestId("project-row")).toHaveCount(1);

    // Armed before the click: the download event can arrive before an awaited
    // click resolves, and racing the two lets the click win with nothing.
    const downloading = page.waitForEvent("download");
    await page.getByTestId("export-project").click();
    const path = await (await downloading).path();
    expect(path).toBeTruthy();

    await page.getByTestId("import-archive").setInputFiles(path as string);
    await expect(page.getByTestId("project-row")).toHaveCount(2);

    // The imported copy holds the same file the original was created with.
    const restored = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const projects = await root.getDirectoryHandle("projects");
      const contents: string[] = [];
      for await (const [, handle] of (
        projects as unknown as AsyncIterable<
          [string, FileSystemDirectoryHandle]
        >
      )[Symbol.asyncIterator]()) {
        const file = await handle.getFileHandle("main.tex");
        contents.push(await (await file.getFile()).text());
      }
      return contents;
    });
    expect(restored).toHaveLength(2);
    expect(restored[0]).toBe(restored[1]);
    expect(restored[0]).toContain("Hello from Opal Web");
  });

  test("a traversing archive is refused and creates nothing", async ({
    page,
  }) => {
    // The hostile case, driven through the real import path rather than only
    // through the unit tests: nothing is created, and the reason is shown.
    // Built here rather than in the page: the app ships no zip writer, and
    // what is under test is what the import path does with the bytes.
    const archive = zipSync(
      { "../../escape.tex": new TextEncoder().encode("x") },
      { mtime: Date.UTC(1980, 0, 1) },
    );

    await page.getByTestId("import-archive").setInputFiles({
      name: "hostile.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(archive),
    });

    await expect(page.getByTestId("projects-error")).toContainText(
      "invalid-path",
    );
    await expect(page.getByTestId("projects-empty")).toBeVisible();
  });
});

test.describe("autosave", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearStorage(page);
    await page.reload();
    await page.getByTestId("project-title").fill("Autosaved");
    await page.getByTestId("create-project").click();
    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("editor")).toBeVisible();
  });

  test("an edit is written without being asked and survives a reload", async ({
    page,
  }) => {
    await page.getByTestId("editor-content").fill("section{Autosaved}");
    await expect(page.getByTestId("save-status")).toContainText("Saved at");

    await page.reload();
    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("editor-content")).toHaveValue(
      "section{Autosaved}",
    );
  });

  test("a burst of typing produces one revision, not one per keystroke", async ({
    page,
  }) => {
    const before = Number(
      await page.getByTestId("project-row-revision").textContent(),
    );
    await page.getByTestId("editor-content").pressSequentially("hello", {
      delay: 20,
    });
    await expect(page.getByTestId("save-status")).toContainText("Saved at");

    const after = Number(
      await page.getByTestId("project-row-revision").textContent(),
    );
    expect(after).toBe(before + 1);
  });

  test("a change made elsewhere is reported rather than overwritten", async ({
    page,
    context,
  }) => {
    // A real second tab on the same origin, which is the situation the
    // conditional write exists for, rather than a stand-in for one.
    const other = await context.newPage();
    await other.goto("/");
    await other.getByTestId("open-project").click();
    await other.getByTestId("editor-content").fill("written by the other tab");
    await expect(other.getByTestId("save-status")).toContainText("Saved at");

    // This tab still holds the revision it read before that write landed.
    await page.getByTestId("editor-content").fill("written by this tab");
    await expect(page.getByTestId("save-status")).toContainText(
      "changed elsewhere",
    );

    // And the other tab's work is still there, which is the point.
    await other.reload();
    await other.getByTestId("open-project").click();
    await expect(other.getByTestId("editor-content")).toHaveValue(
      "written by the other tab",
    );
    await other.close();
  });
});
