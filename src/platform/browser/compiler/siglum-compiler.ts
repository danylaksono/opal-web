import { SiglumCompiler } from "@siglum/engine/compiler";
import type {
  CompileDiagnostic,
  CompileFailureCategory,
  CompileRequest,
  CompileResult,
  EngineIdentity,
  LatexCompiler,
} from "@/core/compiler/types";
import {
  FORMAT_SHIMS,
  missingFontPackages,
  unresolvableFonts,
} from "./font-resolution";
import { needsRerun, parseTexLog } from "./log-diagnostics";

/**
 * `LatexCompiler` implemented over @siglum/engine (ADR-003 spike).
 *
 * Siglum owns its own worker, so this adapter does not create one; what it owns
 * is the translation between Siglum's shape and the port's, which is where the
 * product contract actually lives:
 *
 * - a project is a main file plus a map of additional files, not a directory;
 * - failures are normalised into the same categories the desktop UI already
 *   renders, so ported error surfaces keep working;
 * - every result names the engine and the TeX Live snapshot that produced it,
 *   which is what makes a compile reproducible.
 */

export interface SiglumCompilerOptions {
  /** Where the unpacked release assets are served from. */
  assetsBaseUrl?: string;
  /**
   * Self-hosted CTAN proxy. Left undefined, Siglum disables CTAN fetching
   * entirely — which ADR-001 makes the right default: on-demand fetching
   * reveals which packages a document uses, so it is opt-in and must point at
   * an origin we control.
   */
  ctanProxyUrl?: string;
  /** 'xelatex' matches desktop Tectonic's XeTeX lineage. */
  engine?: "xelatex" | "pdflatex" | "lualatex";
  onLog?: (line: string) => void;
  onProgress?: (stage: string, detail: string) => void;
  /**
   * Capture TeX stdout. Off by default in Siglum, which leaves `result.log`
   * empty — and an empty log means no diagnostics and nothing to show a user
   * when a compile fails, so the measurement harness always turns it on.
   */
  verbose?: boolean;
  /**
   * Bundles to load beyond the engine's declared baseline.
   *
   * Siglum's xelatex baseline is built for TU (Unicode) encoding: `core` ships
   * `tulmr.fd` but not `t1lmr.fd`. A document using the pdfTeX-oriented
   * `\usepackage[T1]{fontenc}` idiom therefore dies with "Corrupted NFSS
   * tables" — a circular font substitution, not a missing-file error.
   *
   * On-demand resolution cannot save it: NFSS looks up `t1lmr.fd` internally,
   * so no `\usepackage` line names the bundle that holds it. The T1 font
   * definitions live in `tex-latex-misc`, which must be loaded up front.
   * 9 of the 13 corpus projects use this idiom.
   */
  extraBundles?: string[];
  /**
   * Throw the engine away after each compile and start a fresh one.
   *
   * On by default because leaving it off leaks. Siglum's `getOrCreateModule`
   * does not cache despite its name: every TeX pass instantiates a new WASM
   * module, and the old one is not reclaimed even after a forced collection.
   * Measured on `blank`: 40 MB after init, 490 MB after one compile, 907 MB
   * after two — about 418 MB per compile, unbounded.
   *
   * The recycle runs after the result has been returned, so its ~500 ms lands
   * between compiles rather than inside one. Turn it off only to measure the
   * leak.
   */
  recycleAfterCompile?: boolean;
}

/**
 * How many times to reload bundles and retry after a missing-file error.
 *
 * TeX reports only the first missing file before stopping, so a document needs
 * one pass per missing bundle: beamer alone chains utils, pgf-tikz and xcolor.
 * Each pass must load something new to continue, so this only bounds
 * pathological chains, not ordinary resolution.
 */
const MAX_RESOLUTION_RETRIES = 12;

/**
 * Total TeX passes, including the first.
 *
 * LaTeX conventionally settles in three; a fourth covers the documents that
 * oscillate one more time, typically a table of contents whose own page number
 * moved. Past that, a document that still asks is not converging, and running
 * it forever would be worse than showing what it produced.
 */
const MAX_PASSES = 4;

/** Bundles a given engine needs beyond what Siglum declares as its baseline. */
const BASELINE_SUPPLEMENTS: Record<string, string[]> = {
  xelatex: ["tex-latex-misc", "fonts-lm-type1"],
};

const TEXT_EXTENSIONS = new Set([
  "tex",
  "bib",
  "cls",
  "sty",
  "bst",
  "txt",
  "csv",
  "md",
]);

function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > 0 && TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/**
 * Resolve which bundle ships a given TeX file.
 *
 * Siglum's own package-to-bundle index is incomplete in two ways this works
 * around, both of which present as "File `x' not found" for a file that is
 * sitting in a bundle on disk:
 *
 * - It is built from `.sty` files, so `\documentclass{beamer}` maps to nothing
 *   even though `beamerarticle` and every `beamerbase*` file is listed.
 * - Bundle `requires` lists are incomplete: the `beamer` bundle does not
 *   declare `utils`, which holds the `etoolbox.sty` it needs.
 *
 * `file-manifest.json` records every shipped path, so it is the reliable index.
 * Siglum fetches the same file during its own init, so this costs no extra
 * download.
 */
let fileIndexPromise: Promise<Map<string, string>> | null = null;

async function fileBundleIndex(
  bundlesUrl: string,
): Promise<Map<string, string>> {
  fileIndexPromise ??= (async () => {
    const response = await fetch(`${bundlesUrl}/file-manifest.json`);
    const manifest = (await response.json()) as Record<
      string,
      { bundle: string }
    >;
    const index = new Map<string, string>();
    for (const [path, info] of Object.entries(manifest)) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      // First writer wins: plain bundles are listed before their dev variants.
      if (!index.has(name)) index.set(name, info.bundle);
    }
    return index;
  })();
  return fileIndexPromise;
}

const DOCUMENT_CLASS = /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/;
const MISSING_FILE = /File `([^']+)' not found/g;

/**
 * Run one compile pass, giving up as soon as `signal` aborts.
 *
 * A WASM TeX run holds its worker's only thread for its whole duration, and
 * Siglum exposes no cancel, so there is nothing to ask politely — this races
 * the pass against the signal and leaves the caller to throw the worker away.
 * The listener is scoped to the race so a long-lived signal does not
 * accumulate one per pass.
 */
async function racePass<T>(
  pass: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return pass;
  const scope = new AbortController();
  try {
    return await Promise.race([
      pass,
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
          signal: scope.signal,
        });
      }),
    ]);
  } finally {
    scope.abort();
  }
}

/** Files TeX reported missing, in the order it hit them. */
function missingFiles(log: string): string[] {
  const names = new Set<string>();
  for (const match of log.matchAll(MISSING_FILE)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

export class SiglumLatexCompiler implements LatexCompiler {
  #compiler: SiglumCompiler | null = null;
  #options: Required<Pick<SiglumCompilerOptions, "assetsBaseUrl" | "engine">> &
    SiglumCompilerOptions;
  #identity: EngineIdentity;
  #initPromise: Promise<void> | null = null;
  #decoder = new TextDecoder();
  #eagerBundles: string[] = [];
  /**
   * TeX output, captured from the log callback.
   *
   * Siglum leaves `result.log` empty even with `verbose` on — engine output
   * only ever reaches `onLog`. Without capturing it there is no log to show the
   * user, no diagnostics to parse, and nothing to resolve missing files
   * against, so every failure looks like a bare "Compilation failed".
   */
  #texLog: string[] = [];
  /**
   * Font packages already asked for, so a font that stays unloadable after its
   * package arrives fails on the next pass instead of refetching forever.
   */
  #fetchedFontPackages = new Set<string>();
  /** In-flight engine recycle, so overlapping compiles wait for one restart. */
  #recyclePromise: Promise<void> | null = null;

  constructor(options: SiglumCompilerOptions = {}) {
    this.#options = {
      assetsBaseUrl: options.assetsBaseUrl ?? "/engines/siglum",
      engine: options.engine ?? "xelatex",
      ...options,
    };
    this.#eagerBundles = [
      ...(BASELINE_SUPPLEMENTS[this.#options.engine] ?? []),
      ...(options.extraBundles ?? []),
    ];
    this.#identity = {
      id: `siglum-${this.#options.engine}`,
      name: `Siglum ${this.#options.engine}`,
      version: "0.1.4",
      // TeX Live 2025 as shipped by the pinned v0.1.0 asset release. Reported
      // on every result so a stale offline cache cannot silently change what a
      // compile means.
      packageSetVersion: "texlive-2025/siglum-bundles-v0.1.0",
    };
  }

  get engine(): EngineIdentity {
    return this.#identity;
  }

  async init(): Promise<void> {
    // A recycle in flight is a dispose followed by an init; joining it is what
    // keeps a compile from starting against a worker about to be terminated.
    if (this.#recyclePromise) await this.#recyclePromise;
    this.#initPromise ??= this.#start();
    return this.#initPromise;
  }

  async #start(): Promise<void> {
    const base = this.#options.assetsBaseUrl;
    const compiler = new SiglumCompiler({
      bundlesUrl: `${base}/bundles`,
      wasmUrl: `${base}/busytex.wasm`,
      jsUrl: `${base}/busytex.js`,
      // Siglum loads xzwasm through a script tag and defaults to
      // "./src/xzwasm.js", a path that only exists in its own repo layout. Left
      // unset, every CTAN package downloads successfully and then fails to
      // decompress — the packages arrive, but TeX never sees them.
      xzwasmUrl: `${base}/xzwasm.js`,
      ...(this.#options.ctanProxyUrl
        ? { ctanProxyUrl: this.#options.ctanProxyUrl, enableCtan: true }
        : { enableCtan: false }),
      eagerBundles: this.#eagerBundles,
      ...(this.#options.verbose ? { verbose: true } : {}),
      onLog: (line: string) => {
        const tex = /^\[TeX(?: ERR)?\] ?(.*)$/.exec(line);
        if (tex) this.#texLog.push(tex[1] ?? "");
        this.#options.onLog?.(line);
      },
      ...(this.#options.onProgress
        ? { onProgress: this.#options.onProgress }
        : {}),
    });
    await compiler.init();
    this.#compiler = compiler;
  }

  async compile(request: CompileRequest): Promise<CompileResult> {
    await this.init();
    const compiler = this.#compiler;
    if (!compiler) throw new Error("Compiler is not initialised");

    request.signal?.throwIfAborted();
    const started = performance.now();

    const main = request.files.find((file) => file.path === request.mainFile);
    if (!main) {
      return this.#failure(
        request,
        "missing-file",
        `Main file ${request.mainFile} is not among the submitted files`,
        "",
        performance.now() - started,
      );
    }

    // Siglum takes the main document as a string and everything else as a map.
    // Binary assets stay as bytes; text is decoded so TeX sees real characters
    // rather than a byte array it would have to guess at.
    const additionalFiles: Record<string, string | Uint8Array> = {};
    for (const file of request.files) {
      if (file.path === request.mainFile) continue;
      additionalFiles[file.path] = isTextFile(file.path)
        ? this.#decoder.decode(file.content)
        : file.content;
    }

    // Prepended, not inserted, so the user's line numbers are untouched.
    const source = FORMAT_SHIMS + this.#decoder.decode(main.content);
    this.#texLog = [];

    try {
      // Load the document class's bundle up front: on-demand resolution cannot
      // see \documentclass at all.
      const index = await fileBundleIndex(
        `${this.#options.assetsBaseUrl}/bundles`,
      );
      const className = DOCUMENT_CLASS.exec(source)?.[1]?.trim();
      const classBundle = className ? index.get(`${className}.cls`) : undefined;
      if (classBundle) await this.#addBundle(compiler, classBundle);

      // Then compile, and treat "file not found" for a file we do ship as a
      // resolution miss rather than a failure: load the bundle and try again.
      // Bounded, and only ever retries when a retry loaded something new, so a
      // genuinely absent package still fails on the first pass.
      let result = await racePass(
        compiler.compile(source, {
          engine: this.#options.engine,
          additionalFiles,
        }),
        request.signal,
      );

      for (let attempt = 0; attempt < MAX_RESOLUTION_RETRIES; attempt++) {
        if (result.success) break;
        request.signal?.throwIfAborted();
        const failureLog = result.log || this.#texLog.join("\n");
        const loaded = [
          ...(await this.#resolveMissing(compiler, index, failureLog)),
          ...(await this.#resolveFonts(compiler, failureLog)),
        ];
        if (loaded.length === 0) break;
        this.#options.onLog?.(
          `[opal] retrying after loading: ${loaded.join(", ")}`,
        );
        this.#texLog = [];
        result = await racePass(
          compiler.compile(source, {
            engine: this.#options.engine,
            additionalFiles,
          }),
          request.signal,
        );
      }

      // Then run it again for as long as TeX asks. Siglum caches aux files
      // between compiles, keyed on the preamble, so a second call reads back
      // what the first wrote — which is the whole mechanism a rerun needs.
      let passes = 1;
      for (; passes < MAX_PASSES; passes++) {
        if (!result.success) break;
        if (!needsRerun(result.log || this.#texLog.join("\n"))) break;
        this.#options.onLog?.("[opal] rerunning: TeX asked for another pass");
        this.#texLog = [];
        result = await compiler.compile(source, {
          engine: this.#options.engine,
          additionalFiles,
          // Siglum caches a compiled PDF against a hash of the source alone.
          // A rerun has the same source by definition and a different `.aux`,
          // so the cache would hand back the very pass we are trying to
          // replace — and the rerun would be a no-op that still costs a call.
          useCache: false,
        });
      }

      const durationMs = performance.now() - started;
      const log = result.log || this.#texLog.join("\n");
      const diagnostics = parseTexLog(log);

      if (!result.success || !result.pdf) {
        // A font the engine cannot be given is worth naming: it is the one
        // failure a user can act on, by choosing a different font.
        const fonts = unresolvableFonts(log);
        return {
          ok: false,
          revision: request.revision,
          category: categorise(result.error ?? "", log, diagnostics),
          summary:
            fonts.length > 0
              ? `This engine cannot load ${fonts.join(", ")}`
              : (result.error ?? "Compilation failed"),
          log,
          diagnostics,
          engine: this.#identity,
          durationMs,
        };
      }

      return {
        ok: true,
        revision: request.revision,
        // Siglum may hand back a SharedArrayBuffer-backed view when the page is
        // cross-origin isolated. Copying detaches the result from the engine's
        // memory, so a later compile cannot mutate a PDF the viewer still holds.
        pdf: new Uint8Array(result.pdf),
        ...(result.syncTexData
          ? { synctex: new Uint8Array(result.syncTexData) }
          : {}),
        log,
        diagnostics,
        engine: this.#identity,
        durationMs,
        passes,
      };
    } catch (error) {
      if (request.signal?.aborted) {
        // The worker is still inside a TeX run that cannot be interrupted, so
        // it is thrown away rather than waited for. The next compile pays a
        // cold start, which is the price of an abort that actually stops.
        await this.dispose();
        return this.#failure(
          request,
          "cancelled",
          "Compilation cancelled",
          this.#texLog.join("\n"),
          performance.now() - started,
        );
      }
      return this.#failure(
        request,
        "engine",
        error instanceof Error ? error.message : String(error),
        "",
        performance.now() - started,
      );
    } finally {
      // After the result is computed, never awaited: the engine leaks about
      // 418 MB per compile, and the only way to give it back is to throw the
      // worker away. Doing it here rather than at the start of the next
      // compile keeps the cost off whatever the caller does next.
      if (this.#options.recycleAfterCompile !== false) void this.#recycle();
    }
  }

  #failure(
    request: CompileRequest,
    category: CompileFailureCategory,
    summary: string,
    log: string,
    durationMs: number,
  ): CompileResult {
    return {
      ok: false,
      revision: request.revision,
      category,
      summary,
      log,
      diagnostics: [],
      engine: this.#identity,
      durationMs,
    };
  }

  /** Load a bundle once, keeping the eager list in sync for later compiles. */
  async #addBundle(compiler: SiglumCompiler, bundle: string): Promise<void> {
    if (this.#eagerBundles.includes(bundle)) return;
    this.#eagerBundles.push(bundle);
    await compiler.preloadBundles([bundle]);
  }

  /** Load bundles for files TeX reported missing. Returns what was loaded. */
  async #resolveMissing(
    compiler: SiglumCompiler,
    index: Map<string, string>,
    log: string,
  ): Promise<string[]> {
    const loaded: string[] = [];
    for (const name of missingFiles(log)) {
      const bundle = index.get(name);
      if (!bundle || this.#eagerBundles.includes(bundle)) continue;
      await this.#addBundle(compiler, bundle);
      loaded.push(bundle);
    }
    return loaded;
  }

  /**
   * Fetch the TeX Live packages holding font metrics TeX could not load.
   *
   * These go through the CTAN proxy directly, by package name, because the
   * file index Siglum resolves against holds no font files at all. Without a
   * proxy configured there is nowhere to fetch from, so this does nothing —
   * the same policy the rest of the adapter applies to CTAN.
   */
  async #resolveFonts(
    compiler: SiglumCompiler,
    log: string,
  ): Promise<string[]> {
    if (!this.#options.ctanProxyUrl) return [];
    const wanted = missingFontPackages(log).filter(
      (name) => !this.#fetchedFontPackages.has(name),
    );
    const loaded: string[] = [];
    for (const name of wanted) {
      this.#fetchedFontPackages.add(name);
      const result = await compiler.ctanFetcher.fetchPackage(name);
      if (result && !result.notFound) loaded.push(name);
    }
    return loaded;
  }

  /**
   * Replace the engine, off the critical path.
   *
   * Called after a result has been handed back, so the restart overlaps with
   * whatever the caller does next instead of adding to the compile it follows.
   * `init()` awaits the same promise, so a compile issued mid-recycle waits for
   * one restart rather than racing a second engine into existence.
   */
  #recycle(): Promise<void> {
    this.#recyclePromise ??= (async () => {
      try {
        await this.dispose();
        // Deliberately not through `init()`, which joins the recycle promise —
        // and inside the recycle that promise is this one, so going through it
        // would have the restart wait for itself.
        this.#initPromise = this.#start();
        await this.#initPromise;
      } finally {
        this.#recyclePromise = null;
      }
    })();
    return this.#recyclePromise;
  }

  async restart(): Promise<void> {
    await this.dispose();
    await this.init();
  }

  async dispose(): Promise<void> {
    this.#compiler?.terminate();
    this.#compiler = null;
    this.#initPromise = null;
  }
}

/**
 * Map an engine failure onto the categories the desktop UI already renders.
 * A missing package is called out separately from a generic missing file
 * because on Siglum it usually means the CTAN path failed, not that the user
 * mistyped a filename — a distinction the user can act on.
 */
function categorise(
  error: string,
  log: string,
  diagnostics: readonly CompileDiagnostic[],
): CompileFailureCategory {
  const haystack = `${error}\n${log}`;
  if (/Undefined control sequence/i.test(haystack)) return "undefined-command";
  if (/shell escape|\\write18/i.test(haystack)) return "shell-escape-refused";
  if (/out of memory|allocation failed/i.test(haystack)) return "out-of-memory";
  if (/File `[^']+\.(sty|cls|bst)' not found|not installed/i.test(haystack)) {
    return "missing-package";
  }
  if (/File `[^']+' not found|cannot find/i.test(haystack))
    return "missing-file";
  if (diagnostics.some((d) => d.severity === "error")) return "syntax";
  return "unknown";
}
