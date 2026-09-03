/**
 * Compile the whole corpus through the browser and record the outcome
 * (ADR-003 exit criteria, PLAN.md 7.4).
 *
 * Drives the compiler spike page in a real browser rather than calling the
 * engine from Node: the engine is a browser artifact, and a result obtained any
 * other way would not be evidence about the product.
 *
 * Requires a server already running at PREVIEW_URL — `npx vite build && npx
 * vite preview --port 4173`. Results are written to spike-results/, which is
 * gitignored; the summary is what belongs in the ADR.
 *
 * Usage: pnpm spike:corpus-run [engine] [--ctan] [--only a,b,c]
 *
 * `--only` narrows the run to named projects and is how a failure gets
 * diagnosed: the full engine log for each project is written to
 * spike-results/logs/, because the verdict line names the last TeX error and a
 * font or version failure is only legible with the lines around it.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const PREVIEW_URL = process.env.OPAL_PREVIEW_URL ?? "http://localhost:4173";
const CORPUS_ROOT = resolve("tests/fixtures/compiler-corpus");
const OUT_DIR = resolve("spike-results");
const LOG_DIR = resolve(OUT_DIR, "logs");
const COMPILE_TIMEOUT_MS = 240_000;

interface ProjectOutcome {
  project: string;
  status: string;
  verdict: string;
  engine: string;
  durationMs: number | null;
  pages: number | null;
  syncTex: boolean;
  diagnostics: number;
  /** Page count of desktop Tectonic's output for the same project. */
  referencePages: number | null;
  detail: string;
}

/**
 * Page count of the committed reference PDF, read through the same renderer the
 * compiled output goes through.
 *
 * "It compiled" is not the acceptance test (PLAN.md 7.4). Page count is the
 * cheapest signal that the output resembles what desktop produces, and using
 * one renderer for both sides means a difference is a real difference rather
 * than two parsers disagreeing.
 */
async function referencePageCount(
  page: import("@playwright/test").Page,
  project: string,
): Promise<number | null> {
  const path = resolve(CORPUS_ROOT, project, "main.reference.pdf");
  if (!existsSync(path)) return null;
  try {
    await page.getByTestId("pdf-input").setInputFiles(path);
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="spike-status"]')
          ?.getAttribute("data-status") === "done",
      undefined,
      { timeout: 60_000 },
    );
    const text = await page.getByTestId("spike-status").innerText();
    const match = /(\d+) pages, opened/.exec(text);
    return match?.[1] ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function projectFiles(project: string): string[] {
  const dir = resolve(CORPUS_ROOT, project);
  return readdirSync(dir)
    .filter((name) => !name.endsWith(".reference.pdf"))
    .map((name) => resolve(dir, name));
}

function parseNumber(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
  const engine = process.argv[2]?.startsWith("--")
    ? "xelatex"
    : (process.argv[2] ?? "xelatex");
  const useCtan = flags.includes("--ctan");
  const onlyIndex = process.argv.indexOf("--only");
  const only =
    onlyIndex === -1
      ? null
      : new Set((process.argv[onlyIndex + 1] ?? "").split(",").filter(Boolean));

  if (!existsSync(CORPUS_ROOT)) {
    throw new Error("Corpus missing; run pnpm spike:corpus first");
  }

  const projects = readdirSync(CORPUS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !only || only.has(name))
    .sort();

  if (projects.length === 0) {
    throw new Error(`No corpus project matched --only ${[...(only ?? [])]}`);
  }

  await mkdir(LOG_DIR, { recursive: true });

  const browser = await chromium.launch();
  const outcomes: ProjectOutcome[] = [];

  for (const project of projects) {
    // A fresh page per project so one wedged engine cannot affect the next
    // measurement, and so timings are cold-start comparable.
    const page = await browser.newPage();
    const engineLog: string[] = [];
    page.on("console", (message) => {
      engineLog.push(message.text());
    });
    page.on("pageerror", (error) => {
      engineLog.push(`[pageerror] ${error.message}`);
    });

    try {
      await page.goto(PREVIEW_URL);
      await page.selectOption('[data-testid="engine-select"]', engine);
      if (useCtan) await page.check('[data-testid="ctan-toggle"]');
      await page.setInputFiles(
        '[data-testid="tex-input"]',
        projectFiles(project),
      );

      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="compile-status"]')
            ?.getAttribute("data-status") === "done",
        undefined,
        { timeout: COMPILE_TIMEOUT_MS },
      );

      const text = await page
        .locator('[data-testid="compile-status"]')
        .innerText();
      const verdict =
        (await page.locator('[data-testid="compile-verdict"]').textContent()) ??
        "?";

      // The *last* TeX error, not the first: the adapter retries after loading
      // bundles, so the first error is usually one it went on to resolve.
      const texErrors = engineLog
        .map((line) => /\[TeX\] (! .+)$/.exec(line)?.[1])
        .filter((line): line is string => Boolean(line));
      // "Emergency stop" and "Fatal error" are TeX's terminators, not causes.
      const substantive = texErrors.filter(
        (line) => !/Emergency stop|Fatal error/.test(line),
      );
      const texError = substantive[substantive.length - 1];

      const referencePages = await referencePageCount(page, project);

      outcomes.push({
        project,
        status: "done",
        referencePages,
        verdict: verdict.trim(),
        engine,
        durationMs: parseNumber(text, /(\d+) ms/),
        pages: parseNumber(text, /(\d+) pages/),
        syncTex: /SyncTeX\s+emitted/.test(text),
        diagnostics: parseNumber(text, /(\d+) parsed/) ?? 0,
        detail: texError ?? verdict.trim(),
      });
    } catch (error) {
      outcomes.push({
        project,
        status: "timeout-or-error",
        verdict: "—",
        referencePages: null,
        engine,
        durationMs: null,
        pages: null,
        syncTex: false,
        diagnostics: 0,
        detail: error instanceof Error ? error.message.slice(0, 120) : "failed",
      });
    } finally {
      await page.close();
      await writeFile(
        resolve(LOG_DIR, `${project}-${engine}${useCtan ? "-ctan" : ""}.log`),
        `${engineLog.join("\n")}\n`,
        "utf8",
      );
    }

    const last = outcomes[outcomes.length - 1];
    console.log(
      `${project.padEnd(22)} ${(last?.verdict ?? "").padEnd(24)} ${
        last?.durationMs ? `${last.durationMs} ms` : ""
      } ${last?.pages ? `${last.pages}p` : ""}`,
    );
  }

  await browser.close();

  const compiled = outcomes.filter((o) => o.verdict === "Compiled");
  console.log(
    `\n${compiled.length}/${outcomes.length} compiled with ${engine}, CTAN ${useCtan ? "on" : "off"}`,
  );
  for (const outcome of outcomes.filter((o) => o.verdict !== "Compiled")) {
    console.log(`  ${outcome.project.padEnd(22)} ${outcome.detail}`);
  }

  // Compiling is not the acceptance test. Page count is the cheapest check that
  // the output resembles desktop's, and both sides go through the same renderer
  // so a difference is a real difference rather than two parsers disagreeing.
  const comparable = compiled.filter((o) => o.referencePages !== null);
  const matching = comparable.filter((o) => o.pages === o.referencePages);
  console.log(
    `\n${matching.length}/${comparable.length} match desktop Tectonic's page count`,
  );
  for (const o of comparable.filter((x) => x.pages !== x.referencePages)) {
    console.log(
      `  ${o.project.padEnd(22)} ${o.pages} pages vs reference ${o.referencePages}`,
    );
  }

  await mkdir(OUT_DIR, { recursive: true });
  // A filtered run gets its own file, so diagnosing one project cannot
  // overwrite the whole-corpus record the ADR is written from.
  const file = resolve(
    OUT_DIR,
    `corpus-${engine}${useCtan ? "-ctan" : ""}${only ? "-partial" : ""}.json`,
  );
  await writeFile(
    file,
    `${JSON.stringify({ engine, useCtan, outcomes }, null, 2)}\n`,
    "utf8",
  );
  console.log(`\nWritten to ${file}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
