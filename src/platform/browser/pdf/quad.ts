import type { Rect } from "@/core/pdf/types";

/**
 * MuPDF's `Quad` — four corners, `[ulx, uly, urx, ury, llx, lly, lrx, lry]` —
 * as the axis-aligned `Rect` the rest of the port speaks (ADR-010; review
 * re-anchoring's `searchPage`).
 *
 * A quad is not always axis-aligned in principle (rotated text), but `search`
 * only ever returns quads for horizontal runs on an upright page, so the
 * bounding box loses nothing `reanchorAnnotations` needs.
 *
 * Kept out of the worker module so it stays directly testable: importing the
 * worker boots the WASM runtime as a side effect.
 */
export type Quad = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export function quadToRect(quad: Quad): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
