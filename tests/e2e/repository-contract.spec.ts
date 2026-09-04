import { expect, test } from "@playwright/test";

/**
 * The shared repository contract, against real OPFS and IndexedDB.
 *
 * The unit suite runs the same cases against the in-memory repository, which
 * has no filesystem to disagree with it. Running them here is what stops the
 * two implementations diverging on the only thing callers depend on, and it is
 * where the storage-specific rules — a failed write leaving the old content,
 * a record readable through a second instance — can be asked at all.
 *
 * The page is built only under OPAL_TEST_PAGES, which playwright.config sets.
 */
test("every contract case passes against OPFS", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));

  await page.goto("/tests/browser/contract.html");

  const status = page.getByTestId("contract-status");
  await expect(status).toHaveAttribute("data-state", /passed|failed/, {
    timeout: 60_000,
  });

  // Reported per case rather than as a count, so a failure names itself.
  const cases = await page.getByTestId("contract-case").allTextContents();
  const failed = cases.filter((line) => line.startsWith("FAIL"));
  expect(failed, failed.join("\n")).toEqual([]);

  expect(cases.length).toBeGreaterThan(15);
  await expect(status).toHaveAttribute("data-state", "passed");
  expect(failures).toEqual([]);
});
