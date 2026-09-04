/**
 * What it costs to fetch a document's TeX files one range request at a time
 * (ADR-011's open risk).
 *
 * The delivery model trades bandwidth for round trips: `presentation-beamer`
 * reads 2.1 MB of TeX files where bundles transfer 118.9 MB, but it reads them
 * as 145 separate files. Whether that is a win depends on per-request cost,
 * which is why this measures it rather than assuming it.
 *
 * The file list is not invented: it is what TeX recorded opening in the corpus
 * logs, so the request pattern is a real one.
 *
 * Both variables that decide the answer come from the rig in
 * `serve-tex-archive.ts` rather than from this side. `--latency` is a delay the
 * rig adds to each response, because Chrome's own throttling queues requests
 * before delaying them and so hides the parallelism under test. Protocol is
 * whichever the rig was started with — `--protocol h1` is the control — and
 * every row records what the browser actually negotiated rather than what the
 * URL scheme implies. Pointing this at `vite preview` would measure HTTP/1.1's
 * six-connection cap and report it as a plateau.
 *
 * Requires `pnpm spike:tex-archive` and `pnpm serve:tex-archive`.
 *
 * Usage: pnpm spike:range-fetch [--url https://localhost:4443] [--project name]
 *        [--latency 50] [--concurrency 6,24]
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const DEFAULT_URL = process.env.OPAL_TEX_URL ?? "https://localhost:4443";
const INDEX = resolve("public/tex/texfiles.index");
const LOG_DIR = resolve("spike-results/logs");
const OUT_DIR = resolve("spike-results");

interface Measurement {
  project: string;
  concurrency: number;
  latencyMs: number;
  files: number;
  found: number;
  bytes: number;
  wallMs: number;
  /** What the browser negotiated: `h2`, `http/1.1`. Reported, never assumed. */
  protocol: string;
  /** The `RequestCache` the fetches used. See the note on the cache lock. */
  cacheMode: string;
}

/** Files TeX recorded opening, from a corpus run's engine log. */
function openedFiles(project: string): string[] {
  const path = resolve(LOG_DIR, `${project}-xelatex-ctan.log`);
  if (!existsSync(path)) {
    throw new Error(
      `No log for ${project}; run pnpm spike:corpus-run --only ${project} first`,
    );
  }
  const text = readFileSync(path, "utf8");
  const names = new Set<string>();
  for (const match of text.matchAll(/\((\/texlive\/[^\s()]+)/g)) {
    const path = match[1];
    if (path) names.add(path.slice(path.lastIndexOf("/") + 1));
  }
  return [...names];
}

function loadIndex(): Map<string, [number, number]> {
  if (!existsSync(INDEX)) {
    throw new Error("No archive index; run pnpm spike:tex-archive first");
  }
  const index = new Map<string, [number, number]>();
  for (const line of readFileSync(INDEX, "utf8").split("\n")) {
    if (!line) continue;
    const parts = line.split(" ");
    if (parts.length !== 3) continue;
    const [name, offset, length] = parts;
    if (name) index.set(name, [Number(offset), Number(length)]);
  }
  return index;
}

async function main(): Promise<void> {
  const arg = (flag: string): string | undefined => {
    const at = process.argv.indexOf(flag);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const projects = (
    arg("--project") ?? "blank,thesis-standard,presentation-beamer"
  )
    .split(",")
    .filter(Boolean);
  const concurrencies = (arg("--concurrency") ?? "1,6,24,64")
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  const latencies = (arg("--latency") ?? "0,20,50,150")
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  const origin = arg("--url") ?? DEFAULT_URL;
  // Every file in a document is a range of one URL, and Chrome takes a lock on
  // the cache entry for that URL: concurrent requests for it queue behind the
  // first, whatever the protocol allows. `no-store` declines the cache entry
  // and the lock with it, which is the difference between a document's files
  // arriving in one round trip and arriving in as many as it has files. Both
  // are measured because the wrong one is the obvious way to write this.
  const cacheModes = (arg("--cache") ?? "default,no-store")
    .split(",")
    .filter(Boolean) as RequestCache[];

  const index = loadIndex();
  const browser = await chromium.launch();
  const results: Measurement[] = [];

  // The browser must close on every path. An open browser keeps node's event
  // loop alive, so a thrown error here does not fail the script: it hangs it.
  try {
    for (const project of projects) {
      const names = openedFiles(project);
      const ranges = names
        .map((name) => index.get(name))
        .filter((r): r is [number, number] => r !== undefined)
        .map(([offset, length]) => [offset, offset + length - 1] as const);
      const bytes = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);

      for (const cacheMode of cacheModes) {
        for (const latencyMs of latencies) {
          for (const concurrency of concurrencies) {
            // A fresh context per measurement: a warm HTTP cache would turn the
            // second run of the same file list into a measurement of the cache.
            // The HTTP/2 rig serves a self-signed certificate, and a context that
            // rejects it would measure nothing at all.
            const context = await browser.newContext({
              ignoreHTTPSErrors: true,
            });
            // tsx compiles this file with esbuild's `keepNames`, which wraps every
            // named function in a `__name()` helper. That helper lives in this
            // module, not in the page, so a function handed to `page.evaluate`
            // arrives referencing an identifier the browser has never heard of.
            // Defining it as identity is what the helper does anyway.
            await context.addInitScript(
              "globalThis.__name = globalThis.__name || ((f) => f);",
            );
            const page = await context.newPage();
            try {
              await page.goto(origin);

              const measured = await page.evaluate(
                async ({ ranges, concurrency, latencyMs, cacheMode }) => {
                  performance.clearResourceTimings();
                  const started = performance.now();
                  let next = 0;
                  const worker = async (): Promise<void> => {
                    for (;;) {
                      const i = next++;
                      const range = ranges[i];
                      if (!range) return;
                      // The rig delays each response by this much. Doing it
                      // there rather than through CDP keeps concurrent requests
                      // overlapping instead of queueing behind the throttler.
                      const headers: Record<string, string> = {
                        Range: `bytes=${range[0]}-${range[1]}`,
                      };
                      if (latencyMs > 0)
                        headers["x-delay-ms"] = String(latencyMs);
                      const response = await fetch("/tex/texfiles.bin", {
                        headers,
                        cache: cacheMode,
                      });
                      await response.arrayBuffer();
                    }
                  };
                  await Promise.all(
                    Array.from({ length: concurrency }, () => worker()),
                  );
                  const wallMs = performance.now() - started;
                  // Same-origin, so `nextHopProtocol` is populated: the row says
                  // which protocol produced it instead of trusting the URL scheme.
                  const entry = performance
                    .getEntriesByType("resource")
                    .find((e) => e.name.includes("texfiles.bin"));
                  const protocol =
                    (entry as PerformanceResourceTiming | undefined)
                      ?.nextHopProtocol || "unknown";
                  return { wallMs, protocol };
                },
                {
                  ranges: ranges.map(([a, b]) => [a, b]),
                  concurrency,
                  latencyMs,
                  cacheMode,
                },
              );

              results.push({
                project,
                concurrency,
                latencyMs,
                files: names.length,
                found: ranges.length,
                bytes,
                wallMs: Math.round(measured.wallMs),
                protocol: measured.protocol,
                cacheMode,
              });
            } finally {
              await context.close();
            }
          }
        }
      }

      console.log(
        `${project}: ${ranges.length}/${names.length} files in the archive, ` +
          `${(bytes / 1024 / 1024).toFixed(2)} MB`,
      );
    }
  } finally {
    await browser.close();
  }

  const byProject = new Map<string, Measurement[]>();
  for (const r of results) {
    byProject.set(r.project, [...(byProject.get(r.project) ?? []), r]);
  }
  for (const [project, rows] of byProject) {
    const protocols = [...new Set(rows.map((r) => r.protocol))].join(", ");
    for (const cacheMode of [...new Set(rows.map((r) => r.cacheMode))]) {
      const modeRows = rows.filter((r) => r.cacheMode === cacheMode);
      console.log(
        `\n${project} over ${protocols}, cache: ${cacheMode} — wall time in ` +
          "ms, by latency and concurrency",
      );
      const cs = [...new Set(modeRows.map((r) => r.concurrency))];
      console.log(
        `  ${"latency".padEnd(9)}${cs.map((c) => `${c} par`.padStart(10)).join("")}`,
      );
      for (const latency of [...new Set(modeRows.map((r) => r.latencyMs))]) {
        const cells = cs.map((c) => {
          const row = modeRows.find(
            (r) => r.latencyMs === latency && r.concurrency === c,
          );
          return String(row?.wallMs ?? "—").padStart(10);
        });
        console.log(`  ${`${latency} ms`.padEnd(9)}${cells.join("")}`);
      }
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  // Named for the protocol measured, so an HTTP/1.1 run does not overwrite the
  // HTTP/2 one it exists to be compared against.
  const measuredProtocol = results[0]?.protocol ?? "unknown";
  const slug = measuredProtocol === "h2" ? "h2" : "h1";
  const file = resolve(OUT_DIR, `range-fetch-${slug}.json`);
  await writeFile(file, `${JSON.stringify({ results }, null, 2)}\n`, "utf8");
  console.log(`\nWritten to ${file}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
