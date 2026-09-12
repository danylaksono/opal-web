import { BusyTexRunner, LuaLatex, PdfLatex, XeLatex } from "texlyre-busytex";
import type {
  CompileFailureCategory,
  CompileRequest,
  CompileResult,
  EngineIdentity,
  LatexCompiler,
} from "@/core/compiler/types";
import { categoriseFailure, firstError, parseTexLog } from "./log-diagnostics";

/**
 * `texlyre-busytex` behind the `LatexCompiler` port (ADR-003).
 *
 * The reason this adapter exists is not that the engine is different — it is
 * the same BusyTeX TeX Live→WASM build Siglum wraps — but that its *package
 * set* is one TeX Live vintage instead of five. ADR-003 records the skew inside
 * Siglum's bundles (a 2020 `geometry` against a 2024 kernel) as structural, and
 * the largest single item between that engine and a product. This one is built
 * from the TeX Live 2026 tree in a single pass, so `packageSetVersion` means
 * something.
 *
 * Two differences shape the code below.
 *
 * **Tiers, not per-package bundles.** Siglum fetches bundles named after
 * packages and resolves the rest from CTAN. Here there are three cumulative
 * data packages — basic, recommended, extra — and whichever are preloaded are
 * simply present in the filesystem before TeX starts. There is no resolution
 * step to go wrong, and no package name leaves the machine, which is what
 * ADR-001 asks for. The cost is bytes: the three total roughly 636 MB.
 *
 * **`remoteEndpoint` is first-class.** The engine reads
 * `TEXLIVE_REMOTE_ENDPOINT` inside kpathsea and registers files by name and
 * format, so per-file resolution is native rather than an adapter bolted onto
 * a bundle path it has to fight. ADR-011's finding — that Siglum's own
 * resolution fetches 77.1 MB of font bundles at init whatever the document
 * uses, so its file path can only supplement and never replace — does not
 * apply. The endpoint must be an origin we control; it is left unset by
 * default so that an unconfigured compile is offline by construction.
 */

export type TexlyreEngineName = "xelatex" | "pdflatex" | "lualatex";

/**
 * A data package to mount before compiling.
 *
 * The three the assets ship are cumulative and named; anything else is a
 * package we built, and `spike:texlive-min` builds one — a boot set of 29
 * files rather than a tier of 7,185 (ADR-011).
 */
export type TexlyreTier = "basic" | "recommended" | "extra" | (string & {});

export const TEXLYRE_TIERS: readonly TexlyreTier[] = [
  "basic",
  "recommended",
  "extra",
];

/**
 * The boot set: what cannot come from the endpoint because it is read before
 * kpathsea exists or named by absolute path. Built by `pnpm spike:texlive-min`.
 */
export const TEXLYRE_BOOT_TIER = "min-xelatex";

export interface TexlyreCompilerOptions {
  engine?: TexlyreEngineName;
  /** Where the BusyTeX assets are served from. */
  basePath?: string;
  /**
   * Which tiers to load before compiling. Cumulative and ordered: `extra`
   * without `recommended` is not a configuration the assets support.
   */
  tiers?: readonly TexlyreTier[];
  /**
   * A self-hosted TeX Live endpoint for names no tier ships. Unset means a
   * compile resolves from the preloaded tiers alone.
   */
  remoteEndpoint?: string;
  verbose?: boolean;
  onLog?: (line: string) => void;
  onProgress?: (stage: string, detail?: string) => void;
}

/**
 * Drivers, keyed by engine.
 *
 * The `_bibtex8` and `_dvipdfmx` suffixes are the pipeline, not a choice: the
 * driver names the whole chain of binaries a run uses, and bibtex is skipped at
 * run time when the document has no bibliography rather than by picking a
 * different driver.
 */
const DRIVERS = {
  xelatex: "xetex_bibtex8_dvipdfmx",
  pdflatex: "pdftex_bibtex8",
  lualatex: "luahbtex_bibtex8",
} as const;

const TOOLS = {
  xelatex: XeLatex,
  pdflatex: PdfLatex,
  lualatex: LuaLatex,
} as const;

const DECODER = new TextDecoder();

/** TeX Live 2026, the vintage the shipped assets were built from. */
const TEXLIVE_VINTAGE = "texlive-2026";

/**
 * Whether a document asks for a bibliography.
 *
 * The engine resolves this itself when told nothing, but it does so from the
 * file set; saying so explicitly keeps a corpus run's pass count a property of
 * the document rather than of how the adapter happened to pass files through.
 */
const BIBLIOGRAPHY = /\\(bibliography|addbibresource|printbibliography)\b/;

export class TexlyreLatexCompiler implements LatexCompiler {
  readonly #options: Required<
    Pick<TexlyreCompilerOptions, "engine" | "basePath" | "tiers">
  > &
    TexlyreCompilerOptions;
  #runner: BusyTexRunner | null = null;
  #initPromise: Promise<void> | null = null;
  #identity: EngineIdentity;

  constructor(options: TexlyreCompilerOptions = {}) {
    const engine = options.engine ?? "xelatex";
    const tiers = options.tiers ?? TEXLYRE_TIERS;
    this.#options = {
      ...options,
      engine,
      basePath: options.basePath ?? "/engines/texlyre/busytex",
      tiers,
    };
    this.#identity = {
      id: `texlyre-busytex-${engine}`,
      name: `texlyre-busytex ${engine}`,
      version: "1.4.0",
      // The tiers are part of the package set: the same tree truncated at
      // `recommended` resolves a different set of names than at `extra`, and a
      // result that did not say so could not be compared with one that did.
      packageSetVersion: `${TEXLIVE_VINTAGE}/texlyre-1.4.0/${
        tiers.length > 0 ? tiers.join("+") : "none"
      }`,
    };
  }

  get engine(): EngineIdentity {
    return this.#identity;
  }

  #dataPackage(tier: TexlyreTier): string {
    return `${this.#options.basePath}/texlive-${tier}.js`;
  }

  async init(): Promise<void> {
    this.#initPromise ??= this.#doInit();
    return this.#initPromise;
  }

  async #doInit(): Promise<void> {
    const { basePath, tiers, verbose, onProgress, onLog } = this.#options;
    onProgress?.("initialising", tiers.join("+"));

    const runner = new BusyTexRunner({
      busytexBasePath: basePath,
      verbose: verbose ?? false,
      preloadDataPackages: tiers.map((tier) => this.#dataPackage(tier)),
      onDownloadProgress: ({ percent }) =>
        onProgress?.("downloading", `${percent}%`),
    });

    // A worker, not the direct path: `remoteEndpoint` is only honoured in the
    // worker, and a compile on the main thread would freeze the page for the
    // length of a TeX run anyway.
    await runner.initialize(true);
    this.#runner = runner;
    onLog?.(`initialised ${this.#identity.packageSetVersion}`);
    onProgress?.("ready");
  }

  async compile(request: CompileRequest): Promise<CompileResult> {
    const started = performance.now();
    await this.init();
    const runner = this.#runner;
    if (!runner) throw new Error("texlyre: runner missing after init");

    const { engine, remoteEndpoint, onLog, onProgress } = this.#options;
    const main = request.mainFile as string;

    // The engine takes the main document as text and everything else as files,
    // so the main file is split out of the set rather than sent twice.
    const mainInput = request.files.find((file) => file.path === main);
    if (!mainInput) {
      return this.#failure(
        request,
        "engine",
        `main file ${main} not among the submitted files`,
        "",
        started,
      );
    }

    const additionalFiles = request.files
      .filter((file) => file.path !== main)
      .map((file) => ({ path: file.path as string, content: file.content }));

    const source = DECODER.decode(mainInput.content);
    const tool = new TOOLS[engine](runner, this.#options.verbose ?? false);

    if (request.signal?.aborted) {
      return this.#failure(request, "cancelled", "cancelled", "", started);
    }
    /**
     * Cancellation is a terminate, and it has to be raced rather than awaited.
     *
     * The API exposes no way to interrupt a run, so stopping one means killing
     * the worker; a TeX pass that has started otherwise runs to completion
     * inside it whatever the caller does with the promise. But killing the
     * worker does not settle the promise the caller is already awaiting —
     * measured, `compile()` returned control **180 s** after the abort, which
     * is indistinguishable from a hang to anything with a cancel button.
     *
     * So the abort resolves a race instead. The engine is torn down so the
     * work actually stops, and the next `compile()` rebuilds it through
     * `init()` — lazily, because rebuilding eagerly here competes with the
     * caller that is about to ask for one.
     */
    let markAborted: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      markAborted = () => resolve("aborted");
    });
    const onAbort = () => {
      this.#runner?.terminate();
      this.#runner = null;
      this.#initPromise = null;
      markAborted?.();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    onProgress?.("compiling", engine);
    try {
      const outcome = await Promise.race([
        tool
          .compile({
            input: source,
            mainTexPath: main,
            additionalFiles,
            bibtex: BIBLIOGRAPHY.test(source),
            // TeX decides how many passes it needs and says so in the log; letting
            // the engine rerun is what makes cross-references and a table of
            // contents resolve. ADR-003's defect 9 is the opposite arrangement.
            rerun: true,
            driver: DRIVERS[engine],
            verbose: this.#options.verbose ? "info" : "silent",
            ...(remoteEndpoint ? { remoteEndpoint } : {}),
          })
          .then((value) => ({ kind: "result" as const, value })),
        aborted.then(() => ({ kind: "aborted" as const })),
      ]);

      if (outcome.kind === "aborted") {
        return this.#failure(request, "cancelled", "cancelled", "", started);
      }
      const result = outcome.value;

      const log = result.log ?? "";
      for (const line of log.split("\n")) if (line) onLog?.(`[TeX] ${line}`);
      const diagnostics = parseTexLog(log);
      const durationMs = performance.now() - started;

      if (request.signal?.aborted) {
        return this.#failure(request, "cancelled", "cancelled", log, started);
      }

      if (!result.success || !result.pdf || result.pdf.byteLength === 0) {
        const error = firstError(diagnostics)?.message ?? "";
        /**
         * When TeX itself did not complain, the failure is a later stage.
         *
         * The driver runs a chain — xelatex, then xelatex again, then
         * xdvipdfmx — and reports one entry per binary. A chain that ends in
         * `exit code 1` with no TeX error in the log failed *after* TeX, and
         * saying only "exit code 1" hides which stage and why. This finds the
         * entry that actually failed and quotes it.
         */
        const failed = result.logs?.find((entry) => entry.exit_code !== 0);
        const stage = failed
          ? `${failed.cmd.split(" ")[0] ?? "engine"}: ${
              (failed.stderr || failed.stdout || failed.log || "")
                .trim()
                .split("\n")
                .filter(Boolean)
                .slice(-2)
                .join(" ") || `exit code ${failed.exit_code}`
            }`
          : `exit code ${result.exitCode}`;
        return {
          ok: false,
          revision: request.revision,
          category: categoriseFailure(error, log, diagnostics),
          summary: error || stage,
          log,
          diagnostics,
          engine: this.#identity,
          durationMs,
        };
      }

      return {
        ok: true,
        revision: request.revision,
        pdf: result.pdf,
        ...(result.synctex ? { synctex: result.synctex } : {}),
        log,
        diagnostics,
        engine: this.#identity,
        durationMs,
        // The driver runs the passes internally and reports one log per
        // binary invoked, so this counts what actually ran rather than a
        // budget decided in advance.
        passes: result.logs?.length ?? 1,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const category: CompileFailureCategory = request.signal?.aborted
        ? "cancelled"
        : "engine";
      return this.#failure(request, category, message, "", started);
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  #failure(
    request: CompileRequest,
    category: CompileFailureCategory,
    summary: string,
    log: string,
    started: number,
  ): CompileResult {
    return {
      ok: false,
      revision: request.revision,
      category,
      summary,
      log,
      diagnostics: parseTexLog(log),
      engine: this.#identity,
      durationMs: performance.now() - started,
    };
  }

  async restart(): Promise<void> {
    await this.dispose();
    await this.init();
  }

  async dispose(): Promise<void> {
    this.#runner?.terminate();
    this.#runner = null;
    this.#initPromise = null;
  }
}
