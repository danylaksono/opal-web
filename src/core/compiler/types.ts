import type { ProjectPath } from "@/core/project/ids";

/**
 * The compiler contract (PLAN.md 3.5, 7.2).
 *
 * This mirrors the *observable* result of the desktop `compile_latex` command
 * rather than its implementation, so ported UI keeps working and so a compile
 * result stays reproducible: every result names the engine and package set that
 * produced it.
 */

export type CompileSeverity = "error" | "warning" | "info";

/** Mirrors `CompileFailure["category"]` in the desktop latex-compiler.ts. */
export type CompileFailureCategory =
  | "undefined-command"
  | "missing-file"
  | "missing-package"
  | "syntax"
  | "busy"
  | "engine"
  | "cancelled"
  | "timeout"
  | "shell-escape-refused"
  | "out-of-memory"
  | "unknown";

export interface CompileDiagnostic {
  severity: CompileSeverity;
  message: string;
  /** Project-relative source file, when the engine reports one. */
  file?: ProjectPath;
  line?: number;
  category: CompileFailureCategory;
}

export interface EngineIdentity {
  /** Stable engine key, e.g. "swiftlatex-pdftex". */
  id: string;
  /** Human-facing name for the status surface. */
  name: string;
  version: string;
  /** Version or content hash of the TeX package set used for this compile. */
  packageSetVersion: string;
}

export interface CompileFileInput {
  path: ProjectPath;
  content: Uint8Array;
}

export interface CompileRequest {
  /**
   * Monotonic per-project revision. Results carrying an older revision than the
   * latest request are discarded rather than rendered (PLAN.md 7.2).
   */
  revision: number;
  mainFile: ProjectPath;
  files: readonly CompileFileInput[];
  /** Number of passes hinted by bibliography and cross-reference needs. */
  maxPasses?: number;
  signal?: AbortSignal;
}

export interface CompileSuccess {
  ok: true;
  revision: number;
  pdf: Uint8Array;
  /** Present only when the engine emits usable SyncTeX (PLAN.md 15). */
  synctex?: Uint8Array;
  log: string;
  diagnostics: readonly CompileDiagnostic[];
  engine: EngineIdentity;
  durationMs: number;
  passes: number;
}

export interface CompileFailureResult {
  ok: false;
  revision: number;
  category: CompileFailureCategory;
  summary: string;
  log: string;
  diagnostics: readonly CompileDiagnostic[];
  engine: EngineIdentity;
  durationMs: number;
}

export type CompileResult = CompileSuccess | CompileFailureResult;

/**
 * A browser LaTeX engine. Implementations own a worker; callers never touch
 * the worker, the virtual filesystem or the WASM module directly.
 */
export interface LatexCompiler {
  readonly engine: EngineIdentity;
  /** Resolve when the engine and its baseline package set are usable. */
  init(): Promise<void>;
  compile(request: CompileRequest): Promise<CompileResult>;
  /** Terminate and rebuild the worker after a crash or a stuck compile. */
  restart(): Promise<void>;
  dispose(): Promise<void>;
}
