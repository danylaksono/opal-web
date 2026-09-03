/**
 * Run a fidelity comparison in the browser, through the `PdfRenderer` port.
 *
 * The metrics live in `compare.ts` and are pure; this is the part that needs a
 * browser — opening both documents through the same renderer and getting pixels
 * out of the `ImageBitmap` it returns.
 *
 * Both sides go through one renderer deliberately. Comparing MuPDF's reading of
 * our output against some other library's reading of desktop's would measure
 * the two libraries as much as the two PDFs.
 */

import type { PdfDocumentHandle, PdfRenderer } from "@/core/pdf/types";
import {
  type Bitmap,
  compareBitmaps,
  compareWords,
  type DocumentComparison,
  type PageComparison,
  pageWords,
  summarise,
} from "./compare";

/**
 * Rasterisation scale for the pixel comparison, in CSS pixels per PDF point.
 *
 * 1.0 renders US Letter at 612×792, which is enough to see a paragraph move and
 * cheap enough to run over every page of a 16-page thesis.
 */
const RASTER_SCALE = 1;

/**
 * How far two page sizes may differ before they count as different pages.
 *
 * Half a point, because a MediaBox is written as a decimal and two engines
 * rounding A4's 210 mm differently is not a page-size change — but anything a
 * reader would notice is orders of magnitude larger than this.
 */
const SIZE_TOLERANCE_PT = 0.5;

/** Read an `ImageBitmap` back as pixels. */
async function toBitmap(image: ImageBitmap): Promise<Bitmap> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D context unavailable");
  // White first: a PDF page is paper, and drawing onto a transparent canvas
  // would make every unpainted pixel differ from every other unpainted pixel
  // only by alpha, which the ink measure would then read as blank.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height);
  image.close();
  return { width: data.width, height: data.height, data: data.data };
}

async function comparePage(
  reference: PdfDocumentHandle,
  candidate: PdfDocumentHandle,
  pageIndex: number,
): Promise<PageComparison> {
  const [referenceGeometry, candidateGeometry] = await Promise.all([
    reference.getPageGeometry(pageIndex),
    candidate.getPageGeometry(pageIndex),
  ]);
  const [referenceText, candidateText] = await Promise.all([
    reference.getPageText(pageIndex),
    candidate.getPageText(pageIndex),
  ]);
  const request = {
    pageIndex,
    scale: RASTER_SCALE,
    devicePixelRatio: 1,
  };
  const [referencePage, candidatePage] = await Promise.all([
    reference.renderPage(request),
    candidate.renderPage(request),
  ]);
  const [referenceBitmap, candidateBitmap] = await Promise.all([
    toBitmap(referencePage.bitmap),
    toBitmap(candidatePage.bitmap),
  ]);

  return {
    pageIndex,
    words: compareWords(pageWords(referenceText), pageWords(candidateText)),
    raster: compareBitmaps(referenceBitmap, candidateBitmap),
    size: {
      reference: [referenceGeometry.width, referenceGeometry.height],
      candidate: [candidateGeometry.width, candidateGeometry.height],
    },
    sizeMatches:
      Math.abs(referenceGeometry.width - candidateGeometry.width) <=
        SIZE_TOLERANCE_PT &&
      Math.abs(referenceGeometry.height - candidateGeometry.height) <=
        SIZE_TOLERANCE_PT,
  };
}

/**
 * Compare a compiled PDF against desktop Tectonic's reference for the same
 * project.
 *
 * Pages are compared up to the shorter of the two documents; a page-count
 * difference is reported by `summarise` rather than treated as an error, since
 * it is a finding in its own right.
 */
export async function compareDocuments(
  renderer: PdfRenderer,
  referenceBytes: Uint8Array,
  candidateBytes: Uint8Array,
): Promise<DocumentComparison> {
  const reference = await renderer.openDocument(referenceBytes);
  let candidate: PdfDocumentHandle | null = null;
  try {
    candidate = await renderer.openDocument(candidateBytes);
    const pages: PageComparison[] = [];
    const shared = Math.min(reference.pageCount, candidate.pageCount);
    // Sequential: two full-page rasters at a time is already the memory peak,
    // and running every page at once is how a 16-page document exhausts WASM.
    for (let index = 0; index < shared; index++) {
      pages.push(await comparePage(reference, candidate, index));
    }
    return summarise(reference.pageCount, candidate.pageCount, pages);
  } finally {
    await candidate?.close();
    await reference.close();
  }
}
