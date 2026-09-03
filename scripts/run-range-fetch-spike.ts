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
 * logs, so the request pattern is a real one. `--latency` adds per-request
 * round-trip delay through CDP, because on loopback the number that matters is
 * invisible.
 *
 * Requires `pnpm spike:tex-archive` and a running preview.
 *
 * Usage: pnpm spike:range-fetch [--project name] [--latency 50] [--concurrency 6,24]
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const PREVIEW_URL = process.env.OPAL_PREVIEW_URL ?? "http://localhost:4173";
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

  const index = loadIndex();
  const browser = await chromium.launch();
  const results: Measurement[] = [];

  for (const project of projects) {
    const names = openedFiles(project);
    const ranges = names
      .map((name) => index.get(name))
      .filter((r): r is [number, number] => r !== undefined)
      .map(([offset, length]) => [offset, offset + length - 1] as const);
    const bytes = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);

    for (const latencyMs of latencies) {
      for (const concurrency of concurrencies) {
        // A fresh context per measurement: a warm HTTP cache would turn the
        // second run of the same file list into a measurement of the cache.
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
          await page.goto(PREVIEW_URL);
          if (latencyMs > 0) {
            const cdp = await context.newCDPSession(page);
            await cdp.send("Network.enable");
            await cdp.send("Network.emulateNetworkConditions", {
              offline: false,
              latency: latencyMs,
              // Throughput generous on purpose: this measures round trips, and
              // a bandwidth cap would hide them behind transfer time.
              downloadThroughput: (100 * 1_000_000) / 8,
              uploadThroughput: (100 * 1_000_000) / 8,
            });
          }

          const wallMs = await page.evaluate(
            async ({ ranges, concurrency }) => {
              const started = performance.now();
              let next = 0;
              const worker = async (): Promise<void> => {
                for (;;) {
                  const i = next++;
                  const range = ranges[i];
                  if (!range) return;
                  const response = await fetch("/tex/texfiles.bin", {
                    headers: { Range: `bytes=${range[0]}-${range[1]}` },
                  });
                  await response.arrayBuffer();
                }
              };
              await Promise.all(
                Array.from({ length: concurrency }, () => worker()),
              );
              return performance.now() - started;
            },
            { ranges: ranges.map(([a, b]) => [a, b]), concurrency },
          );

          results.push({
            project,
            concurrency,
            latencyMs,
            files: names.length,
            found: ranges.length,
            bytes,
            wallMs: Math.round(wallMs),
          });
        } finally {
          await context.close();
        }
      }
    }

    console.log(
      `${project}: ${ranges.length}/${names.length} files in the archive, ` +
        `${(bytes / 1024 / 1024).toFixed(2)} MB`,
    );
  }

  await browser.close();

  const byProject = new Map<string, Measurement[]>();
  for (const r of results) {
    byProject.set(r.project, [...(byProject.get(r.project) ?? []), r]);
  }
  for (const [project, rows] of byProject) {
    console.log(`\n${project} — wall time in ms, by latency and concurrency`);
    const cs = [...new Set(rows.map((r) => r.concurrency))];
    console.log(
      `  ${"latency".padEnd(9)}${cs.map((c) => `${c} par`.padStart(10)).join("")}`,
    );
    for (const latency of [...new Set(rows.map((r) => r.latencyMs))]) {
      const cells = cs.map((c) => {
        const row = rows.find(
          (r) => r.latencyMs === latency && r.concurrency === c,
        );
        return String(row?.wallMs ?? "—").padStart(10);
      });
      console.log(`  ${`${latency} ms`.padEnd(9)}${cells.join("")}`);
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  const file = resolve(OUT_DIR, "range-fetch.json");
  await writeFile(file, `${JSON.stringify({ results }, null, 2)}\n`, "utf8");
  console.log(`\nWritten to ${file}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
