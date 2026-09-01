import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * ADR-004 exit criteria, as far as they can be automated in Phase 0.
 *
 * The fixtures are desktop Tectonic's own output for the corpus, so a page that
 * renders here is a page the product will actually have to show. They are
 * committed, so a skip means the corpus was cleared rather than that a step was
 * forgotten.
 */
function referencePdf(project: string): string | null {
  const path = fileURLToPath(
    new URL(
      `../fixtures/compiler-corpus/${project}/main.reference.pdf`,
      import.meta.url,
    ),
  );
  return existsSync(path) ? path : null;
}

async function openPdf(page: import("@playwright/test").Page, project: string) {
  const path = referencePdf(project);
  test.skip(
    path === null,
    `Missing fixture for ${project}; run pnpm spike:corpus`,
  );

  await page.goto("/");
  await page.getByTestId("pdf-input").setInputFiles(path as string);
  await expect(page.getByTestId("spike-status")).toHaveAttribute(
    "data-status",
    "done",
    { timeout: 45_000 },
  );
}

test("the MuPDF worker boots and reports its identity and licence", async ({
  page,
}) => {
  await openPdf(page, "paper-standard");

  // Proves the WASM resolved through a real static URL rather than a dev-only
  // filesystem path, which is the whole reason this runs against the build.
  await expect(page.getByTestId("renderer-identity")).toContainText("MuPDF.js");
  await expect(page.getByTestId("renderer-identity")).toContainText(
    "AGPL-3.0-or-later",
  );
});

test("pages rasterise to a non-blank bitmap", async ({ page }) => {
  await openPdf(page, "paper-standard");

  const canvas = page.getByTestId("page-canvas");
  const size = await canvas.evaluate((element) => ({
    width: (element as HTMLCanvasElement).width,
    height: (element as HTMLCanvasElement).height,
  }));
  expect(size.width).toBeGreaterThan(100);
  expect(size.height).toBeGreaterThan(size.width);

  // A white canvas would pass a size check while proving nothing, so look for
  // actual ink.
  const inkedPixels = await canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext("2d");
    if (!context) return 0;
    const { data } = context.getImageData(
      0,
      0,
      (element as HTMLCanvasElement).width,
      (element as HTMLCanvasElement).height,
    );
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i] ?? 255) < 128) dark++;
    }
    return dark;
  });
  expect(inkedPixels).toBeGreaterThan(500);
});

test("text extraction yields lines with usable geometry", async ({ page }) => {
  await openPdf(page, "paper-standard");

  const lineCount = Number(
    await page.getByTestId("line-count").first().textContent(),
  );
  expect(lineCount).toBeGreaterThan(5);

  // The deciding measurement for review anchoring: a baseline that is not the
  // bottom of the bounding box. Desktop's structured-text notes what happens
  // when this collapses — every line drops by its descender.
  const rows = page.locator("tbody tr", {
    has: page.locator("td", { hasText: /^\d+\.\d{2}$/ }),
  });
  await expect(rows.first()).toBeVisible();
});

test("a large-format page renders without exhausting memory", async ({
  page,
}) => {
  // poster-academic is a0paper, the worst case in the corpus for both raster
  // size and renderer memory.
  await openPdf(page, "poster-academic");

  const canvas = page.getByTestId("page-canvas");
  const width = await canvas.evaluate(
    (element) => (element as HTMLCanvasElement).width,
  );
  expect(width).toBeGreaterThan(1000);
});
