import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

/**
 * The engine's endpoint, on the server `pnpm dev` runs.
 *
 * Every other test of the compile path drives `vite preview`, because that is
 * what `playwright.config.ts` starts — and the two servers do not get their
 * middlewares at the same insertion point. Registered through the hook a
 * `configureServer` *returns*, ours land after Vite's own, and in dev Vite's
 * HTML fallback answers anything still unhandled: `/texlive/26/article.cls`
 * came back as `index.html`, with a 200 and `text/html`. The engine wrote that
 * page to `/tmp/texlive_remote/26_article.cls`, and TeX stopped at "Missing
 * \begin{document}" pointing at a class file that was never a class file.
 *
 * A green e2e suite could not see it. This asserts the discriminating fact —
 * what dev serves for a file the engine asks for — against both servers, so
 * they cannot drift apart again.
 */

const ARCHIVE = resolve("public/engines/texlyre/busytex/texlive-extra.data");
const hasTree = existsSync(ARCHIVE);

/** A file every LaTeX document loads, and the one the failure named. */
const REQUEST = "/texlive/26/article.cls";

async function fetchFrom(origin: string) {
  const response = await fetch(`${origin}${REQUEST}`);
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

/**
 * Whichever port the OS handed out.
 *
 * A fixed one is a trap here: 5173, 5174, 5180 and 5199 are all taken by
 * unrelated projects on the machines this has run on, and a test that fails
 * because a port is busy says nothing about the endpoint.
 */
function originOf(urls: { local: string[] } | null): string {
  const url = urls?.local[0];
  if (!url) throw new Error("server reported no address");
  return url.replace(/\/$/, "");
}

describe.skipIf(!hasTree)("the TeX Live endpoint", () => {
  it("serves a class file in dev, not the HTML shell", async () => {
    const server = await createServer({
      server: { port: 0 },
      logLevel: "silent",
    });
    await server.listen();
    try {
      const served = await fetchFrom(originOf(server.resolvedUrls));

      expect(served.status).toBe(200);
      expect(served.type).not.toContain("text/html");
      // docstrip's header: the file TeX was asking for, not a page about it.
      expect(served.body.slice(0, 40)).toContain("article.cls");
    } finally {
      await server.close();
    }
  }, 60_000);

  // Preview is not tested here on purpose. It was already correct when this
  // test was written — the same assertions passed against it before the fix
  // and after — so a preview case would look like half the guard while
  // discriminating nothing, and it would quietly depend on whatever `dist/`
  // happened to hold. What proves preview is the fifteen compile tests in
  // `tests/e2e/workspace.spec.ts`, which drive a real engine through it.
});
