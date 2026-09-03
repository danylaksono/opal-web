import { useCallback, useRef, useState } from "react";
import { projectPath } from "@/core/project/ids";
import { SiglumLatexCompiler } from "@/platform/browser/compiler/siglum-compiler";

/**
 * ADR-003 performance surface: what a compile costs, and whether one can be
 * stopped (PLAN.md 13.3).
 *
 * Four numbers the corpus runner cannot produce, because it measures one cold
 * compile per fresh page and reports only what `LatexCompiler` returns:
 *
 * - **Engine init**, which `compile()` deliberately excludes from its own
 *   duration and which nothing else was measuring. For a web product it is the
 *   number a user feels first.
 * - **Cold compile**, the first compile of a session.
 * - **Cached compile**, the identical document again. Siglum keys its PDF cache
 *   on a hash of the source, so this is a cache hit and measures the cache, not
 *   the engine — worth having, but it is not the edit cycle.
 * - **Warm compile**, the document *edited* and recompiled with the engine
 *   already up. This is what every cycle after the first actually costs, and
 *   the only way to measure it is to change the source, because an unchanged
 *   one never reaches the engine.
 * - **Peak memory**, which needs `measureUserAgentSpecificMemory` and therefore
 *   a cross-origin-isolated page: it is the only API that sees the engine's
 *   WASM heap. `performance.memory` counts the JS heap alone, so on a page
 *   without isolation the figure would omit almost all of it — reported as
 *   unavailable rather than as a small number.
 *
 * Cancellation is measured separately, because it is the one behaviour with no
 * engine support at all: a WASM TeX run holds its worker's only thread, so the
 * adapter terminates the worker and the question is how long that takes and
 * whether the next compile still works.
 */

interface Timing {
  initMs: number;
  coldMs: number;
  cachedMs: number;
  warmMs: number;
  coldPasses: number;
  warmPasses: number;
  coldOk: boolean;
  warmOk: boolean;
  /** After init, before any compile: the engine's fixed cost. */
  memoryAfterInitBytes: number | null;
  /** After three compiles: fixed cost plus whatever a document adds. */
  memoryBytes: number | null;
  memorySource: string;
}

interface Cancellation {
  /** How long after starting the compile the abort was signalled. */
  afterMs: number;
  /** How long the abort itself took to return control. */
  abortMs: number;
  category: string;
  /** Whether a compile after the abort still produced a PDF. */
  recovered: boolean;
  /** Wall time for that compile, engine re-initialisation included. */
  recoveryMs: number;
}

interface State {
  status: "idle" | "running" | "done" | "error";
  stage?: string;
  timing?: Timing;
  cancellation?: Cancellation;
  error?: string;
}

/**
 * Abort this far into the compile, as a fraction of the cold compile's measured
 * duration.
 *
 * Fixed delays do not work across a corpus that spans 20 ms and 50 s: a delay
 * long enough to land inside `paper-acm` is several times longer than `blank`
 * takes to finish, and aborting after a compile has completed measures nothing.
 * Halfway through a run this document has already been timed at is inside it by
 * construction.
 */
const ABORT_AT_FRACTION = 0.5;

/** Floor for that delay, so a very fast document still gets a real abort. */
const MIN_ABORT_MS = 30;

interface MemoryBreakdownEntry {
  bytes: number;
  types?: string[];
  attribution?: { url?: string; scope?: string }[];
}

interface MemoryCapableWindow {
  measureUserAgentSpecificMemory?: () => Promise<{
    bytes: number;
    breakdown?: MemoryBreakdownEntry[];
  }>;
}

/**
 * Log a sample and its breakdown to the console.
 *
 * The total alone says memory is large; the breakdown says which realm holds
 * it, which is the difference between a leak in our code and the engine's WASM
 * instance not being reclaimed.
 */
function logMemory(
  stage: string,
  bytes: number | null,
  breakdown?: MemoryBreakdownEntry[],
): void {
  if (bytes === null) return;
  const mb = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;
  const parts = (breakdown ?? [])
    .filter((entry) => entry.bytes > 0)
    .map(
      (entry) =>
        `${entry.types?.join("+") || "?"}:${mb(entry.bytes)}` +
        (entry.attribution?.[0]?.scope
          ? `(${entry.attribution[0].scope})`
          : ""),
    );
  console.log(`[mem] ${stage.padEnd(16)} ${mb(bytes)}  ${parts.join(" ")}`);
}

/**
 * Peak memory across the whole agent cluster, workers and WASM included.
 *
 * Returns null rather than a JS-heap-only figure when the page is not
 * cross-origin isolated: a number that omits the engine would be worse than no
 * number, because it looks like an answer.
 */
async function sampleMemory(stage: string): Promise<{
  bytes: number | null;
  source: string;
}> {
  const measure = (performance as unknown as MemoryCapableWindow)
    .measureUserAgentSpecificMemory;
  if (typeof measure !== "function") {
    return {
      bytes: null,
      source: globalThis.crossOriginIsolated
        ? "measureUserAgentSpecificMemory unavailable in this browser"
        : "needs a cross-origin-isolated page (run with OPAL_COI=1)",
    };
  }
  try {
    const result = await measure.call(performance);
    logMemory(stage, result.bytes, result.breakdown);
    return { bytes: result.bytes, source: "measureUserAgentSpecificMemory" };
  } catch (error) {
    return {
      bytes: null,
      source: error instanceof Error ? error.message : "measurement failed",
    };
  }
}

/**
 * Append a comment line, so an edit changes the hash and nothing else.
 *
 * Siglum serves an unchanged source from its PDF cache, so any measurement that
 * needs the engine to actually run has to change something — and a comment
 * after the document has ended changes nothing TeX typesets and no line number
 * already in use.
 */
function appendComment(content: Uint8Array, tag: string): Uint8Array {
  const suffix = new TextEncoder().encode(`\n% opal measurement: ${tag}\n`);
  const out = new Uint8Array(content.length + suffix.length);
  out.set(content, 0);
  out.set(suffix, content.length);
  return out;
}

export function PerformanceSpike() {
  const [state, setState] = useState<State>({ status: "idle" });
  const [useCtan, setUseCtan] = useState(true);
  const compilerRef = useRef<SiglumLatexCompiler | null>(null);

  const run = useCallback(
    async (fileList: FileList) => {
      setState({ status: "running", stage: "reading files" });
      try {
        const files = await Promise.all(
          Array.from(fileList).map(async (file) => ({
            path: projectPath(file.name),
            content: new Uint8Array(await file.arrayBuffer()),
          })),
        );
        const mainFile =
          files.find((file) => file.path === "main.tex")?.path ??
          files.find((file) => file.path.endsWith(".tex"))?.path;
        if (!mainFile) throw new Error("No .tex file selected");

        const build = () =>
          new SiglumLatexCompiler({
            engine: "xelatex",
            verbose: true,
            ...(useCtan ? { ctanProxyUrl: "/ctan" } : {}),
            onLog: (line) => console.log("[siglum]", line),
          });

        // A fresh compiler for the timing run, so "cold" means cold.
        await compilerRef.current?.dispose();
        const compiler = build();
        compilerRef.current = compiler;

        setState({ status: "running", stage: "initialising engine" });
        const initStart = performance.now();
        await compiler.init();
        const initMs = performance.now() - initStart;
        // Sampled here as well as at the end, because the two answer different
        // questions: whether the *engine* fits in a browser tab, and what a
        // document adds on top. If the fixed cost dominates, no amount of
        // document-level care will help.
        const memoryAfterInit = await sampleMemory("after init");

        setState({ status: "running", stage: "cold compile" });
        const cold = await compiler.compile({ revision: 1, mainFile, files });

        await sampleMemory("after cold");

        setState({ status: "running", stage: "cached compile" });
        const cached = await compiler.compile({ revision: 2, mainFile, files });

        // An edit, so the source hash changes and the compile reaches the
        // engine. A trailing comment adds a line after the document has ended,
        // which changes nothing TeX typesets and no line number already in use.
        setState({ status: "running", stage: "warm compile" });
        const edited = files.map((file) =>
          file.path === mainFile
            ? { ...file, content: appendComment(file.content, "warm") }
            : file,
        );
        const warm = await compiler.compile({
          revision: 3,
          mainFile,
          files: edited,
        });

        const memory = await sampleMemory("after 3 compiles");

        // Then a second compiler, aborted mid-run. Separate from the timing
        // compiler because an abort terminates the worker, and measuring a
        // warm compile after that would be measuring a cold one.
        setState({ status: "running", stage: "cancellation" });
        await compiler.dispose();
        const cancelCompiler = build();
        compilerRef.current = cancelCompiler;
        await cancelCompiler.init();

        // Edited again, and differently, so this compile misses the PDF cache
        // as well. An unchanged source is served from cache in milliseconds and
        // there is nothing left to abort.
        const cancelFiles = files.map((file) =>
          file.path === mainFile
            ? { ...file, content: appendComment(file.content, "cancel") }
            : file,
        );
        // Half of the warm duration, not the cold one: this compiler is new but
        // the page's bundle and package caches are not, so it behaves like the
        // warm run. A fixed delay cannot work across a corpus spanning 20 ms to
        // 50 s — too long and the compile has already finished, which measures
        // nothing.
        const abortAfterMs = Math.max(
          MIN_ABORT_MS,
          Math.round(warm.durationMs * ABORT_AT_FRACTION),
        );
        const controller = new AbortController();
        const abortAt = setTimeout(
          () => controller.abort(),
          abortAfterMs,
        ) as unknown as number;
        const cancelStart = performance.now();
        const cancelled = await cancelCompiler.compile({
          revision: 1,
          mainFile,
          files: cancelFiles,
          signal: controller.signal,
        });
        const abortMs = performance.now() - cancelStart - abortAfterMs;
        clearTimeout(abortAt);

        // The point of an abort is that the next compile still works. Timed on
        // the wall clock, not from `durationMs`: the abort threw the worker
        // away, so this compile pays a full re-init, and `compile()` excludes
        // init from the duration it reports.
        const recoveryStart = performance.now();
        const recovery = await cancelCompiler.compile({
          revision: 2,
          mainFile,
          files: cancelFiles,
        });
        const recoveryMs = performance.now() - recoveryStart;

        setState({
          status: "done",
          timing: {
            initMs,
            coldMs: cold.durationMs,
            cachedMs: cached.durationMs,
            warmMs: warm.durationMs,
            coldPasses: cold.ok ? cold.passes : 0,
            warmPasses: warm.ok ? warm.passes : 0,
            coldOk: cold.ok,
            warmOk: warm.ok,
            memoryAfterInitBytes: memoryAfterInit.bytes,
            memoryBytes: memory.bytes,
            memorySource: memory.source,
          },
          cancellation: {
            afterMs: abortAfterMs,
            abortMs,
            category: cancelled.ok
              ? "completed before abort"
              : cancelled.category,
            recovered: recovery.ok,
            recoveryMs,
          },
        });
      } catch (error) {
        setState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [useCtan],
  );

  const { timing, cancellation } = state;

  return (
    <section>
      <h2>ADR-003: performance and cancellation</h2>
      <p className="lede">
        Select every file of one corpus project. Times engine init, a cold
        compile and a warm one, samples memory, then aborts a compile mid-run to
        see whether it stops and whether the engine survives it.
      </p>

      <label style={{ display: "block", marginBottom: "0.75rem" }}>
        <input
          type="checkbox"
          data-testid="perf-ctan-toggle"
          checked={useCtan}
          onChange={(event) => setUseCtan(event.target.checked)}
        />{" "}
        Fetch missing packages through the <code>/ctan</code> proxy.
      </label>

      <input
        type="file"
        multiple
        data-testid="perf-input"
        onChange={(event) => {
          const files = event.target.files;
          if (files && files.length > 0) void run(files);
        }}
      />

      <div data-testid="perf-status" data-status={state.status}>
        {state.status === "running" && <p>Measuring — {state.stage}…</p>}

        {state.status === "error" && (
          <div className="banner bad">
            <strong>Measurement failed:</strong> {state.error}
          </div>
        )}

        {state.status === "done" && timing && cancellation && (
          <table>
            <tbody>
              <tr>
                <td>Engine init</td>
                <td className="note" data-testid="perf-init">
                  {timing.initMs.toFixed(0)} ms
                </td>
              </tr>
              <tr>
                <td>Cold compile</td>
                <td className="note" data-testid="perf-cold">
                  {timing.coldMs.toFixed(0)} ms
                </td>
              </tr>
              <tr>
                <td>Cached compile</td>
                <td className="note" data-testid="perf-cached">
                  {timing.cachedMs.toFixed(0)} ms
                </td>
              </tr>
              <tr>
                <td>Warm compile (edited)</td>
                <td className="note" data-testid="perf-warm">
                  {timing.warmMs.toFixed(0)} ms
                </td>
              </tr>
              <tr>
                <td>Passes</td>
                <td className="note" data-testid="perf-passes">
                  {timing.coldPasses} cold, {timing.warmPasses} warm
                </td>
              </tr>
              <tr>
                <td>Memory after init</td>
                <td className="note" data-testid="perf-memory-init">
                  {timing.memoryAfterInitBytes === null
                    ? `unavailable — ${timing.memorySource}`
                    : `${(timing.memoryAfterInitBytes / 1024 / 1024).toFixed(1)} MB`}
                </td>
              </tr>
              <tr>
                <td>Peak memory</td>
                <td className="note" data-testid="perf-memory">
                  {timing.memoryBytes === null
                    ? `unavailable — ${timing.memorySource}`
                    : `${(timing.memoryBytes / 1024 / 1024).toFixed(1)} MB`}
                </td>
              </tr>
              <tr>
                <td>Abort outcome</td>
                <td className="note" data-testid="perf-abort">
                  {cancellation.category}
                </td>
              </tr>
              <tr>
                <td>Abort latency</td>
                <td className="note" data-testid="perf-abort-ms">
                  {cancellation.abortMs.toFixed(0)} ms after signalling, which
                  was {cancellation.afterMs} ms in
                </td>
              </tr>
              <tr>
                <td>Recovery</td>
                <td className="note" data-testid="perf-recovery">
                  {cancellation.recovered ? "compiled" : "failed"} in{" "}
                  {cancellation.recoveryMs.toFixed(0)} ms
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
