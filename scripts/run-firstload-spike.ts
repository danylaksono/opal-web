/**
 * What a first compile actually costs to download (PLAN.md 11, 13.3).
 *
 * Every other measurement in this repo has been taken on localhost with a warm
 * disk, which says nothing about the number a user meets first. This opens a
 * cold browser context per project — empty HTTP cache, empty IndexedDB —
 * compiles once, and records every byte that crossed the wire, grouped by what
 * asked for it.
 *
 * `--throttle <mbps>` applies download throttling through CDP, so the wall
 * clock reflects a network rather than a loopback. Roughly: 1.5 for slow 3G,
 * 9 for a good 4G connection, 30 for home broadband.
 *
 * Requires a server already running at PREVIEW_URL.
 *
 * `--archive` resolves missing files from the indexed TeX archive instead of
 * fetching whole bundles (ADR-011), which is the comparison the whole ADR turns
 * on: same documents, same harness, files delivered a different way.
 *
 * Usage: pnpm spike:firstload [--only a,b] [--throttle 9] [--no-ctan] [--archive]
 */
import { readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const PREVIEW_URL = process.env.OPAL_PREVIEW_URL ?? "http://localhost:4173";
const CORPUS_ROOT = resolve("tests/fixtures/compiler-corpus");
const OUT_DIR = resolve("spike-results");
const COMPILE_TIMEOUT_MS = 900_000;

/**
 * Which subsystem a request belongs to.
 *
 * Ordered, because the patterns overlap: a bundle is under `/engines/` too, and
 * attributing it to the engine would hide the thing most worth knowing — how
 * much of the payload is TeX packages rather than the engine itself.
 */
const CATEGORIES: [string, (url: string) => boolean][] = [
  ["tex bundles", (url) => url.includes("/engines/siglum/bundles/")],
  ["tex engine", (url) => url.includes("/engines/siglum/")],
  ["ctan packages", (url) => url.includes("/ctan/")],
  ["tex archive", (url) => url.includes("texfiles")],
  ["pdf renderer", (url) => /mupdf.*\.wasm$|mupdf/.test(url)],
  ["app", () => true],
];

function categorise(url: string): string {
  for (const [name, matches] of CATEGORIES) {
    if (matches(url)) return name;
  }
  return "app";
}

interface FirstLoad {
  project: string;
  /** Wall time from navigation to a compiled PDF. */
  totalMs: number | null;
  bytesByCategory: Record<string, number>;
  totalBytes: number;
  requests: number;
  /** The single largest response, which is usually the whole story. */
  largest: { url: string; bytes: number } | null;
  /**
   * Whether the compile succeeded, and why not.
   *
   * The harness waits for the spike to reach "done", which it reports for a
   * failure as much as a success — so without this a document that failed early
   * reads as a document with a cheap first load, which is the opposite of true.
   */
  ok: boolean;
  verdict?: string;
  error?: string;
}

function projectFiles(project: string): string[] {
  const dir = resolve(CORPUS_ROOT, project);
  return readdirSync(dir)
    .filter((name) => !name.endsWith(".reference.pdf"))
    .map((name) => resolve(dir, name));
}

/**
 * The archive root, as a site-relative path.
 *
 * Pass it without a leading slash — `--archive-url tex-pinned`. Git Bash on
 * Windows rewrites a leading-slash argument into a Windows path, so
 * `--archive-url /tex-pinned` arrives here as `C:/Program Files/Git/tex-pinned`,
 * the page then fetches an index that does not exist, and the run reports a
 * compile failure that is really a mangled flag. A value that still looks like
 * a filesystem path is reduced to its last segment rather than used as-is.
 */
function normaliseArchiveUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bare = /^[A-Za-z]:/.test(value)
    ? value.slice(value.lastIndexOf("/") + 1)
    : value;
  return bare.startsWith("/") || bare.startsWith("http") ? bare : `/${bare}`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const arg = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const only = arg("--only")
    ? new Set((arg("--only") ?? "").split(",").filter(Boolean))
    : null;
  const throttleMbps = arg("--throttle")
    ? Number(arg("--throttle"))
    : undefined;
  const useCtan = !process.argv.includes("--no-ctan");
  const useArchive = process.argv.includes("--archive");
  // Which archive the page resolves from; the spike surface reads it from the
  // query string so one build can measure either.
  const archiveUrl = normaliseArchiveUrl(arg("--archive-url"));

  const projects = readdirSync(CORPUS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !only || only.has(name))
    .sort();

  const browser = await chromium.launch();
  const outcomes: FirstLoad[] = [];

  for (const project of projects) {
    // A fresh context, not just a fresh page: a page reuses the browser's HTTP
    // cache and storage, and this measurement is entirely about not having
    // those.
    const context = await browser.newContext();
    const page = await context.newPage();
    const bytesByCategory: Record<string, number> = {};
    let totalBytes = 0;
    let requests = 0;
    let largest: { url: string; bytes: number } | null = null;

    page.on("response", (response) => {
      void (async () => {
        try {
          const sizes = await response.request().sizes();
          // Encoded body plus headers: what the network actually carried, not
          // what the payload expands to.
          const bytes = sizes.responseBodySize + sizes.responseHeadersSize;
          const category = categorise(response.url());
          bytesByCategory[category] = (bytesByCategory[category] ?? 0) + bytes;
          totalBytes += bytes;
          requests++;
          if (!largest || bytes > largest.bytes) {
            largest = { url: response.url(), bytes };
          }
        } catch {
          // A response whose sizes cannot be read is one that never completed;
          // counting it as zero is closer than guessing.
        }
      })();
    });

    try {
      if (throttleMbps !== undefined) {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 50,
          downloadThroughput: (throttleMbps * 1_000_000) / 8,
          uploadThroughput: (throttleMbps * 1_000_000) / 8,
        });
      }

      const started = Date.now();
      await page.goto(
        archiveUrl
          ? `${PREVIEW_URL}/?archive=${encodeURIComponent(archiveUrl)}`
          : PREVIEW_URL,
      );
      if (useCtan) await page.check('[data-testid="ctan-toggle"]');
      if (useArchive) await page.check('[data-testid="archive-toggle"]');
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
      const totalMs = Date.now() - started;
      const verdict =
        (await page.locator('[data-testid="compile-verdict"]').textContent()) ??
        "";
      // Responses are recorded asynchronously; give the last few a moment to
      // land before reading the totals.
      await page.waitForTimeout(500);

      outcomes.push({
        project,
        totalMs,
        bytesByCategory,
        totalBytes,
        requests,
        largest,
        ok: verdict.startsWith("Compiled"),
        verdict,
      });
    } catch (error) {
      outcomes.push({
        project,
        totalMs: null,
        bytesByCategory,
        totalBytes,
        requests,
        largest,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 120) : "failed",
      });
    } finally {
      await context.close();
    }

    const last = outcomes[outcomes.length - 1];
    console.log(
      `${project.padEnd(22)} ${mb(last?.totalBytes ?? 0).padStart(9)} ` +
        `${String(last?.requests ?? 0).padStart(4)} reqs ` +
        `${last?.totalMs === null || last?.totalMs === undefined ? "—" : `${(last.totalMs / 1000).toFixed(1)} s`}` +
        // A failure that is not said out loud reads as a cheap first load.
        `${last?.ok ? "" : `  ${last?.verdict || last?.error || "failed"}`}`,
    );
  }

  await browser.close();

  const names = [
    ...new Set(outcomes.flatMap((o) => Object.keys(o.bytesByCategory))),
  ];
  console.log(
    `\n${"project".padEnd(22)} ${names.map((n) => n.padStart(14)).join("")} ${"total".padStart(10)} ${"time".padStart(8)}`,
  );
  for (const o of outcomes) {
    console.log(
      `${o.project.padEnd(22)} ` +
        names.map((n) => mb(o.bytesByCategory[n] ?? 0).padStart(14)).join("") +
        ` ${mb(o.totalBytes).padStart(10)} ` +
        `${(o.totalMs === null ? "—" : `${(o.totalMs / 1000).toFixed(1)} s`).padStart(8)}`,
    );
  }

  const smallest = [...outcomes].sort((a, b) => a.totalBytes - b.totalBytes)[0];
  if (smallest) {
    console.log(
      `\nFloor, from the cheapest project (${smallest.project}): ${mb(smallest.totalBytes)}`,
    );
    console.log(
      `Largest single response: ${mb(smallest.largest?.bytes ?? 0)} ${smallest.largest?.url ?? ""}`,
    );
  }
  if (throttleMbps !== undefined) {
    console.log(`\nThrottled to ${throttleMbps} Mbps down, 50 ms latency.`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const file = resolve(
    OUT_DIR,
    `firstload${useArchive ? (archiveUrl ? "-pinned" : "-archive") : ""}${throttleMbps === undefined ? "" : `-${throttleMbps}mbps`}${only ? "-partial" : ""}.json`,
  );
  await writeFile(
    file,
    `${JSON.stringify({ throttleMbps, useCtan, outcomes }, null, 2)}\n`,
    "utf8",
  );
  console.log(`\nWritten to ${file}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
