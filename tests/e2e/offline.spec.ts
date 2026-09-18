import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

/**
 * The offline shell (PLAN.md 9, Phase 4).
 *
 * The product's claim is that it compiles on the device with nothing sent
 * anywhere; the honest test of that is to take the network away and see
 * whether it still works. Two halves, and the second is the expensive one:
 *
 * - the application itself comes back with the network off;
 * - a document compiles with the network off, because the 22.7 MB the engine
 *   needs (ADR-011) is in Cache Storage from the first compile.
 *
 * The service worker is registered in built output only — `pnpm dev` never
 * runs it — so this suite is the only thing that sees it at all. That is the
 * same blind spot that let Vite's HTML fallback answer the TeX endpoint for
 * two phases, which is why it is tested here rather than assumed.
 */

const BOOT_PACKAGE = resolve(
  "public/engines/texlyre/busytex/texlive-min-xelatex.data",
);
const hasEngine = existsSync(BOOT_PACKAGE);

async function clearStorage(page: Page) {
  await page.evaluate(async () => {
    for (const name of await caches.keys()) await caches.delete(name);
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

/** Wait until the worker is not merely registered but in charge of this page. */
async function controlled(page: Page) {
  await page.waitForFunction(
    () => Boolean(navigator.serviceWorker.controller),
    undefined,
    { timeout: 30_000 },
  );
}

test.describe("offline", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearStorage(page);
    await page.goto("/");
    await controlled(page);
  });

  test("the application comes back with the network off", async ({
    page,
    context,
  }) => {
    await page.getByTestId("project-title").fill("Offline");
    await page.getByTestId("create-project").click();
    await expect(page.getByTestId("project-row")).toBeVisible();
    // A second visit, so the shell and its assets are in the cache.
    await page.reload();

    await context.setOffline(true);
    await page.reload();

    // The project is in OPFS and the application is in Cache Storage: nothing
    // about this needs a server.
    await expect(page.getByTestId("projects-panel")).toBeVisible();
    await expect(page.getByTestId("project-row-title")).toHaveText("Offline");
    await context.setOffline(false);
  });

  test("the engine is cached by its version, not by the build", async ({
    page,
  }) => {
    // A deploy renames every asset and empties the application's cache. The
    // engine's cache is keyed by the engine's own version, because 22.7 MB is
    // the wrong thing to re-download over a moved button.
    const names = await page.evaluate(() => caches.keys());
    expect(names.some((name) => name.startsWith("opal-app-"))).toBe(true);
    expect(
      names.every((name) => !name.startsWith("opal-engine-")),
      "nothing of the engine is cached before a compile: a person who only reads should not pay for it",
    ).toBe(true);
  });

  test.describe("with the engine", () => {
    test.skip(
      !hasEngine,
      "engine assets absent: ./scripts/download-texlyre-assets.sh && pnpm spike:texlive-min xelatex --write",
    );
    test.setTimeout(300_000);

    test("a document compiles with the network off", async ({
      page,
      context,
    }) => {
      await page.getByTestId("project-title").fill("Offline compile");
      await page.getByTestId("create-project").click();
      await expect(page.getByTestId("project-row")).toBeVisible();
      await page.getByTestId("open-project").first().click();
      await expect(page.getByTestId("workspace")).toBeVisible();

      // Once online, to fill the cache.
      await page.getByTestId("compile-button").click();
      await expect(page.getByTestId("workspace-status")).toHaveAttribute(
        "data-status",
        "done",
        { timeout: 280_000 },
      );
      await expect(page.getByTestId("workspace-status")).toContainText(
        "Compiled",
      );

      const cached = await page.evaluate(async () => {
        const engine = (await caches.keys()).find((name) =>
          name.startsWith("opal-engine-"),
        );
        if (!engine) return { entries: 0, bytes: 0 };
        const store = await caches.open(engine);
        const keys = await store.keys();
        let bytes = 0;
        for (const key of keys) {
          const response = await store.match(key);
          bytes += (await response?.arrayBuffer())?.byteLength ?? 0;
        }
        return { entries: keys.length, bytes };
      });
      // The engine, its boot set and the TeX files this document asked for.
      expect(cached.entries).toBeGreaterThan(2);
      expect(
        cached.bytes,
        `Cache Storage holds ${(cached.bytes / 1048576).toFixed(1)} MB of engine`,
      ).toBeGreaterThan(20 * 1024 * 1024);

      await context.setOffline(true);
      await page.reload();
      await page.getByTestId("open-project").first().click();
      await expect(page.getByTestId("workspace")).toBeVisible();

      await page.getByTestId("compile-button").click();
      await expect(page.getByTestId("workspace-status")).toHaveAttribute(
        "data-status",
        "done",
        { timeout: 280_000 },
      );
      // The claim, taken literally: TeX ran in this browser with no network.
      await expect(page.getByTestId("workspace-status")).toContainText(
        "Compiled",
      );
      await expect(page.getByTestId("preview")).toHaveAttribute(
        "data-status",
        "ready",
        { timeout: 60_000 },
      );
      await context.setOffline(false);
    });
  });
});
