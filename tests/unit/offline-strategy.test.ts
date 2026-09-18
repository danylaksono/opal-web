import { describe, expect, it } from "vitest";
import {
  cacheNames,
  isCacheable,
  strategyFor,
} from "@/platform/browser/offline/strategy";

/**
 * The offline policy, without a browser.
 *
 * A service worker decides what everyone who visits is served, and gets to be
 * wrong until a cache is cleared — so the decisions live in a pure function
 * and are checked here, leaving the worker itself thin enough to read.
 */

const CACHES = cacheNames("build-7", "1.4.0");
const decide = (url: string) =>
  strategyFor(new URL(url, "https://x.test"), CACHES);

describe("strategyFor", () => {
  it("keeps the engine in a cache of its own, keyed by its version", () => {
    // 22.7 MB of WASM, boot set and TeX files (ADR-011): a deploy must not
    // cost a person that again.
    expect(decide("/engines/texlyre/busytex/busytex.wasm")).toEqual({
      kind: "cache-first",
      cache: "opal-engine-1.4.0",
    });
    expect(decide("/texlive/26/article.cls")).toEqual({
      kind: "cache-first",
      cache: "opal-engine-1.4.0",
    });
  });

  it("keeps the application in a cache keyed by the build", () => {
    // Hashed by the build, so the name is the version.
    expect(decide("/assets/index-abc123.js")).toEqual({
      kind: "cache-first",
      cache: "opal-app-build-7",
    });
  });

  it("asks the network for the document first, so a deploy lands", () => {
    expect(decide("/")).toEqual({
      kind: "network-first",
      cache: "opal-app-build-7",
    });
  });

  it("never caches the harness", () => {
    // Its panels produce the ADR measurements, and a measurement served from
    // a cache is not a measurement.
    expect(decide("/?harness=1")).toEqual({ kind: "network" });
  });

  it("leaves anything else alone", () => {
    expect(decide("/ctan/api/ctan-pkg/geometry")).toEqual({ kind: "network" });
  });
});

describe("isCacheable", () => {
  it("keeps a plain success", () => {
    expect(isCacheable(new Response("x", { status: 200 }))).toBe(true);
  });

  it("refuses a 404, which the engine reads as an answer", () => {
    // The endpoint's 404 means "no such file", and the engine records the miss
    // and stops asking. Cached, that transient answer would become permanent.
    expect(isCacheable(new Response("", { status: 404 }))).toBe(false);
  });

  it("refuses a partial response", () => {
    expect(isCacheable(new Response("x", { status: 206 }))).toBe(false);
  });
});
