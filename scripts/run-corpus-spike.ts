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
 *
 * Every project that compiles is then compared against desktop Tectonic's
 * reference PDF on words, ink and pixels — page count only says the document
 * did not fall apart.
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
  /** Null when the compile failed, so there was nothing to compare. */
  fidelity: Fidelity | null;
  detail: string;
}

/**
 * How closely the compiled PDF matches desktop's, beyond page count.
 *
 * Each figure is the worst page of the document, not the average: an average
 * hides the one page that fell apart, which is the page worth knowing about.
 */
interface Fidelity {
  /** Word-sequence similarity, 0..1. 1 is the same words in the same order. */
  meanWordSimilarity: number;
  worstWordSimilarity: number;
  /** Difference in the fraction of inked pixels. Survives sub-pixel shifts. */
  worstInkDelta: number;
  /** Fraction of pixels differing. Strictest of the three, and the noisiest. */
  worstDifferingRatio: number;
  /** Pages matching the reference word for word, and pages compared. */
  exactPages: number;
  comparedPages: number;
  /**
   * Where the worst page first parts company with the reference.
   *
   * Worth reading before treating a score below 1 as a defect: several corpus
   * documents put `	oday` on their title page, and the reference PDFs were
   * built on a different day from the run comparing against them.
   */
  divergence: string;
}

type Page = import("@playwright/test").Page;

function referencePath(project: string): string | null {
  const path = resolve(CORPUS_ROOT, project, "main.reference.pdf");
  return existsSync(path) ? path : null;
}

/**
 * Page count of the committed reference PDF, read through the same renderer the
 * compiled output goes through.
 *
 * Used only when a compile failed and there is nothing to compare it against.
 * A successful compile takes the fidelity path below, which reports the same
 * number alongside everything else.
 */
async function referencePageCount(
  page: Page,
  project: string,
): Promise<number | null> {
  const path = referencePath(project);
  if (!path) return null;
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

/**
 * Compare the compiled PDF against desktop's, beyond page count (PLAN.md 7.4).
 *
 * Driven through the spike page rather than computed here, for the same reason
 * the compile is: the renderer is a browser artifact, and both sides must go
 * through the same one for a difference to mean anything.
 */
async function fidelity(
  page: Page,
  project: string,
): Promise<{ fidelity: Fidelity | null; referencePages: number | null }> {
  const path = referencePath(project);
  if (!path) return { fidelity: null, referencePages: null };
  try {
    await page.getByTestId("reference-input").setInputFiles(path);
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="fidelity-status"]')
          ?.getAttribute("data-status") === "done",
      undefined,
      { timeout: 180_000 },
    );
    const number = async (testId: string): Promise<number | null> => {
      const text = await page.getByTestId(testId).innerText();
      const value = Number(text.trim());
      return Number.isFinite(value) ? value : null;
    };
    const pages = await page.getByTestId("fidelity-pages").innerText();
    const exact = await page.getByTestId("fidelity-exact").innerText();
    return {
      referencePages: parseNumber(pages, /reference (\d+)/),
      fidelity: {
        meanWordSimilarity: (await number("fidelity-mean")) ?? 0,
        worstWordSimilarity: (await number("fidelity-words")) ?? 0,
        worstInkDelta: (await number("fidelity-ink")) ?? 1,
        worstDifferingRatio: (await number("fidelity-pixels")) ?? 1,
        exactPages: parseNumber(exact, /^(\d+)/) ?? 0,
        comparedPages: parseNumber(exact, /\/\s*(\d+)/) ?? 0,
        divergence: (
          await page.getByTestId("fidelity-divergence").innerText()
        ).trim(),
      },
    };
  } catch {
    return { fidelity: null, referencePages: null };
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

      // A compile that produced a PDF gets the full comparison, which reports
      // the reference page count too. One that failed has nothing to compare,
      // so the reference is only opened for its page count.
      const compiled = verdict.trim() === "Compiled";
      const measured = compiled
        ? await fidelity(page, project)
        : {
            fidelity: null,
            referencePages: await referencePageCount(page, project),
          };

      outcomes.push({
        project,
        status: "done",
        referencePages: measured.referencePages,
        fidelity: measured.fidelity,
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
        fidelity: null,
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
      } ${last?.pages ? `${last.pages}p` : ""}${
        last?.fidelity
          ? ` words ${last.fidelity.worstWordSimilarity.toFixed(3)}`
          : ""
      }`,
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

  // Page count only says the document did not fall apart. These say whether the
  // same words landed in the same places.
  const measured = compiled.filter(
    (o): o is typeof o & { fidelity: Fidelity } => o.fidelity !== null,
  );
  if (measured.length > 0) {
    console.log(`
Fidelity, worst page of each document (${measured.length}):`);
    console.log(
      `  ${"project".padEnd(22)} ${"exact".padEnd(7)} ${"mean".padEnd(8)} ${"worst".padEnd(8)} ${"ink".padEnd(8)} ${"pixels".padEnd(8)} first divergence`,
    );
    for (const o of [...measured].sort(
      (a, b) => a.fidelity.meanWordSimilarity - b.fidelity.meanWordSimilarity,
    )) {
      console.log(
        `  ${o.project.padEnd(22)} ${`${o.fidelity.exactPages}/${o.fidelity.comparedPages}`.padEnd(7)} ${o.fidelity.meanWordSimilarity
          .toFixed(4)
          .padEnd(8)} ${o.fidelity.worstWordSimilarity
          .toFixed(4)
          .padEnd(8)} ${o.fidelity.worstInkDelta
          .toFixed(4)
          .padEnd(8)} ${o.fidelity.worstDifferingRatio
          .toFixed(4)
          .padEnd(8)} ${o.fidelity.divergence}`,
      );
    }
    const whole = measured.filter(
      (o) => o.fidelity.worstWordSimilarity === 1,
    ).length;
    const exactPages = measured.reduce((n, o) => n + o.fidelity.exactPages, 0);
    const comparedPages = measured.reduce(
      (n, o) => n + o.fidelity.comparedPages,
      0,
    );
    console.log(
      `
${whole}/${measured.length} documents and ${exactPages}/${comparedPages} pages` +
        " reproduce desktop's text word for word",
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
