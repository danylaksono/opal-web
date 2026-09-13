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
 * run still reports every timing and says why memory is missing. It does *not*
 * need Chrome: the isolation headers are the whole requirement.
 *
 * `--soak n` adds n extra compiles on the same engine after the timed ones and
 * samples memory after each, which is the only way to tell a flat engine from
 * one that grows a little per compile. It needs `OPAL_COI=1` to mean anything.
 *
 * Usage: pnpm spike:perf [--only a,b,c] [--no-ctan] [--texlyre] [--soak n]
 */
import { readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { chromiumLaunchOptions } from "./browser";

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
  /** Memory after each extra compile, when `--soak` asked for them. */
  soak: string;
  /** First and last soak breakdowns, so growth can be attributed to a realm. */
  breakdown: string;
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
  const useTexlyre = process.argv.includes("--texlyre");
  const soakIndex = process.argv.indexOf("--soak");
  const soak = soakIndex === -1 ? 0 : Number(process.argv[soakIndex + 1] ?? 0);

  const projects = readdirSync(CORPUS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !only || only.has(name))
    .sort();

  // `measureUserAgentSpecificMemory` is the only API that sees the engine's
  // WASM heap. This once read "real Chrome, not bundled Chromium: Chromium's
  // test build has it present but disabled", and that was the wrong diagnosis:
  // probed directly, Playwright's Chromium exposes it with default flags and
  // returns a breakdown. What it needs is the *page* — the API is gated on
  // cross-origin isolation, so a run against a preview without COOP/COEP loses
  // the column whichever browser it drives. Chrome is still preferred when
  // installed, because it is what a user runs.
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ channel: "chrome" });
  } catch {
    console.log("Chrome not found; using Chromium (memory still measurable)");
    browser = await chromium.launch(chromiumLaunchOptions);
  }
  const outcomes: PerfOutcome[] = [];

  for (const project of projects) {
    // A fresh page per project: "cold" has to mean cold, and a shared page
    // would carry the previous project's engine, caches and IndexedDB.
    const page = await browser.newPage();
    /*
      Keep the memory breakdowns the page logs during a soak.

      The total says memory grew; the breakdown says *which realm* holds it,
      which is the difference between the page retaining every PDF it has been
      handed and the engine's heap not being reclaimed — and those have
      different fixes. It takes the first and the last to attribute *growth*
      rather than volume: one sample showing 4 MB in the Window cannot be told
      apart from a Window that started at 0.4 MB and grew, which is the whole
      question.
    */
    const soakBreakdowns: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("[mem] after soak")) soakBreakdowns.push(text);
    });
    try {
      await page.goto(PREVIEW_URL);
      if (useTexlyre) {
        await page.selectOption(
          '[data-testid="perf-backend-select"]',
          "texlyre",
        );
      } else if (!useCtan) {
        await page.uncheck('[data-testid="perf-ctan-toggle"]');
      }
      if (soak > 0) {
        await page.fill('[data-testid="perf-soak-input"]', String(soak));
      }
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
        soak:
          soak > 0 && (await page.getByTestId("perf-soak").count()) > 0
            ? await text("perf-soak")
            : "—",
        breakdown:
          soakBreakdowns.length > 1
            ? `${soakBreakdowns[0]}\n${" ".repeat(24)}${soakBreakdowns[soakBreakdowns.length - 1]}`
            : (soakBreakdowns[0] ?? ""),
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
        soak: "—",
        breakdown: "",
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
  if (outcomes.some((o) => o.soak !== "—")) {
    console.log("\nSoak, memory after each further compile on one engine:");
    for (const o of outcomes) {
      if (o.soak === "—") continue;
      console.log(`  ${o.project.padEnd(22)} ${o.soak}`);
      if (o.breakdown) console.log(`  ${" ".repeat(22)} ${o.breakdown}`);
    }
  }
  if (outcomes.some((o) => o.memory.startsWith("unavailable"))) {
    console.log(
      "  (rebuild and preview with OPAL_COI=1: the API needs a " +
        "cross-origin-isolated page)",
    );
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
