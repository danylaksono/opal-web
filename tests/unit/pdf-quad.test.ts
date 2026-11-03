import { describe, expect, it } from "vitest";
import { quadToRect } from "@/platform/browser/pdf/quad";

describe("quadToRect", () => {
  it("bounds an upright quad", () => {
    // ul, ur, ll, lr — an ordinary horizontal run 100pt wide, 12pt tall.
    expect(quadToRect([10, 20, 110, 20, 10, 32, 110, 32])).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 12,
    });
  });

  it("does not assume the corners arrive in any particular order", () => {
    // Same box, corners shuffled — a defensive check, since a bounding box
    // computed from min/max should not care.
    expect(quadToRect([110, 32, 10, 20, 110, 20, 10, 32])).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 12,
    });
  });

  it("collapses a degenerate quad to a zero-size rect rather than throwing", () => {
    expect(quadToRect([5, 5, 5, 5, 5, 5, 5, 5])).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 0,
    });
  });
});
