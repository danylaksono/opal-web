/**
 * Measure what a compile costs, and whether one can be stopped
 * (ADR-003 exit criteria, PLAN.md 13.3).
 *
 * Drives the performance spike page in a real browser, for the same reason the
 * corpus runner does: the engine is a browser artifact, and a number obtained
 * any other way would not be a number about the product.
 *
 * Requires a server already running at PREVIEW_URL. Peak memory needs
 * `measureUserAgentSpecificMemory`, which needs a cross-origin-isolated page,
 * so build and preview with `OPAL_COI=1` to get that column; without it the
 * run still reports every timing and says why memory is missing.
 *
 * Usage: pnpm spike:perf [--only a,b,c] [--no-ctan]
 */
import { readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const PREVIEW_URL = process.env.OPAL_PREVIEW_URL ?? "http://localhost:4173";
const CORPUS_ROOT = resolve("tests/fixtures/compiler-corpus");
const OUT_DIR = resolve("spike-results");
/** Generous: the run is init plus four compiles of the same document. */
const MEASURE_TIMEOUT_MS = 600_000;

interface PerfOutcome {
  project: string;
  initMs: number | null;
  coldMs: number | null;
  cachedMs: number | null;
  warmMs: number | null;
  passes: string;
  memoryAfterInit: string;
  memory: string;
  abortOutcome: string;
  abortMs: number | null;
  recovery: string;
  error?: string;
}

function projectFiles(project: string): string[] {
  const dir = resolve(CORPUS_ROOT, project);
  return readdirSync(dir)
    .filter((name) => !name.endsWith(".reference.pdf"))
    .map((name) => resolve(dir, name));
}

function parseMs(text: string): number | null {
  const match = /(-?[\d.]+) ms/.exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

async function main(): Promise<void> {
  const onlyIndex = process.argv.indexOf("--only");
  const only =
    onlyIndex === -1
      ? null
      : new Set((process.argv[onlyIndex + 1] ?? "").split(",").filter(Boolean));
  const useCtan = !process.argv.includes("--no-ctan");

  const projects = readdirSync(CORPUS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !only || only.has(name))
    .sort();

  // Real Chrome, not bundled Chromium: `measureUserAgentSpecificMemory` is the
  // only API that sees the engine's WASM heap, and Chromium's test build has it
  // present but disabled. Falls back so the timings still run without Chrome
  // installed; only the memory column is lost.
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let memoryCapable = true;
  try {
    browser = await chromium.launch({ channel: "chrome" });
  } catch {
    console.log(
      "Chrome not found; falling back to Chromium, memory unavailable",
    );
    browser = await chromium.launch();
    memoryCapable = false;
  }
  const outcomes: PerfOutcome[] = [];

  for (const project of projects) {
    // A fresh page per project: "cold" has to mean cold, and a shared page
    // would carry the previous project's engine, caches and IndexedDB.
    const page = await browser.newPage();
    try {
      await page.goto(PREVIEW_URL);
      if (!useCtan) await page.uncheck('[data-testid="perf-ctan-toggle"]');
      await page.setInputFiles(
        '[data-testid="perf-input"]',
        projectFiles(project),
      );
      await page.waitForFunction(
        () => {
          const status = document
            .querySelector('[data-testid="perf-status"]')
            ?.getAttribute("data-status");
          return status === "done" || status === "error";
        },
        undefined,
        { timeout: MEASURE_TIMEOUT_MS },
      );

      const text = async (testId: string): Promise<string> =>
        (await page.getByTestId(testId).innerText()).trim();

      outcomes.push({
        project,
        initMs: parseMs(await text("perf-init")),
        coldMs: parseMs(await text("perf-cold")),
        cachedMs: parseMs(await text("perf-cached")),
        warmMs: parseMs(await text("perf-warm")),
        passes: await text("perf-passes"),
        memoryAfterInit: await text("perf-memory-init"),
        memory: await text("perf-memory"),
        abortOutcome: await text("perf-abort"),
        abortMs: parseMs(await text("perf-abort-ms")),
        recovery: await text("perf-recovery"),
      });
    } catch (error) {
      outcomes.push({
        project,
        initMs: null,
        coldMs: null,
        cachedMs: null,
        warmMs: null,
        passes: "—",
        memoryAfterInit: "—",
        memory: "—",
        abortOutcome: "—",
        abortMs: null,
        recovery: "—",
        error: error instanceof Error ? error.message.slice(0, 120) : "failed",
      });
    } finally {
      await page.close();
    }

    const last = outcomes[outcomes.length - 1];
    console.log(
      `${project.padEnd(22)} init ${String(last?.initMs ?? "—").padEnd(6)} ` +
        `cold ${String(last?.coldMs ?? "—").padEnd(7)} ` +
        `warm ${String(last?.warmMs ?? "—").padEnd(7)} ${last?.recovery ?? ""}`,
    );
  }

  await browser.close();

  const timed = outcomes.filter(
    (o): o is PerfOutcome & { coldMs: number; warmMs: number } =>
      o.coldMs !== null && o.warmMs !== null,
  );

  console.log(
    `\n${"project".padEnd(22)} ${"init".padEnd(9)} ${"cold".padEnd(9)} ` +
      `${"warm".padEnd(9)} ${"cached".padEnd(8)} warm saves`,
  );
  for (const o of [...timed].sort((a, b) => b.coldMs - a.coldMs)) {
    const saved = o.coldMs === 0 ? 0 : 1 - o.warmMs / o.coldMs;
    console.log(
      `${o.project.padEnd(22)} ${`${o.initMs ?? "—"} ms`.padEnd(9)} ` +
        `${`${o.coldMs} ms`.padEnd(9)} ${`${o.warmMs} ms`.padEnd(9)} ` +
        `${`${o.cachedMs ?? "—"} ms`.padEnd(8)} ${(saved * 100).toFixed(0)}%`,
    );
  }

  console.log("\nCancellation:");
  for (const o of outcomes) {
    console.log(
      `  ${o.project.padEnd(22)} ${o.abortOutcome.padEnd(24)} ` +
        `${o.abortMs === null ? "—" : `${o.abortMs} ms`} → ${o.recovery}`,
    );
  }

  console.log("\nMemory, whole agent cluster including the WASM heap:");
  console.log(`  ${"project".padEnd(22)} ${"after init".padEnd(12)} peak`);
  for (const o of outcomes) {
    console.log(
      `  ${o.project.padEnd(22)} ${o.memoryAfterInit.padEnd(12)} ${o.memory}`,
    );
  }
  if (!memoryCapable) {
    console.log("  (Chromium fallback: install Chrome for this column)");
  }

  await mkdir(OUT_DIR, { recursive: true });
  const file = resolve(OUT_DIR, `perf${only ? "-partial" : ""}.json`);
  await writeFile(
    file,
    `${JSON.stringify({ useCtan, outcomes }, null, 2)}\n`,
    "utf8",
  );
  console.log(`\nWritten to ${file}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
