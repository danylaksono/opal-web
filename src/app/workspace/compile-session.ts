import type {
  CompileFileInput,
  CompileResult,
  LatexCompiler,
} from "@/core/compiler/types";
import type { ProjectPath } from "@/core/project/ids";

/**
 * The edit-compile-preview loop's control logic, kept out of React
 * (PLAN.md 14, Phase 2).
 *
 * Three of Phase 2's exit criteria are decided here rather than in the view —
 * stale compiles never replacing newer output, cancellation returning control,
 * and a failed worker recovering without losing edits — and none of them is
 * comfortable to test through a rendered component. So this owns the sequencing
 * and the view owns the pixels.
 *
 * It deliberately does not own the *policy* of when to compile. Warm compiles
 * measure 0.9–3.2 s on the corpus, which is fast enough to recompile on a
 * debounce rather than on a button, but that is a product decision and it
 * belongs to whatever calls `compile`.
 */

export type CompileState =
  | { status: "idle" }
  | { status: "compiling"; revision: number }
  | { status: "done"; revision: number; result: CompileResult };

export interface CompileSessionOptions {
  compiler: LatexCompiler;
  onState: (state: CompileState) => void;
}

export class CompileSession {
  readonly #compiler: LatexCompiler;
  readonly #onState: (state: CompileState) => void;
  /**
   * The highest revision requested so far, not the one in flight.
   *
   * A result is rendered only if it still carries this number. That is the
   * whole stale-output guard: an older compile that finishes after a newer one
   * was requested is discarded rather than drawn, which is the failure a user
   * sees as the preview flickering back to what they just changed.
   */
  #latest = 0;
  #controller: AbortController | null = null;

  constructor(options: CompileSessionOptions) {
    this.#compiler = options.compiler;
    this.#onState = options.onState;
  }

  get isCompiling(): boolean {
    return this.#controller !== null;
  }

  /**
   * Compile, superseding anything already running.
   *
   * Resolves with the result when this call is still the newest, and with null
   * when a later `compile` overtook it — so a caller can tell "no output" from
   * "output you should ignore" without inspecting revisions itself.
   */
  async compile(
    mainFile: ProjectPath,
    files: readonly CompileFileInput[],
  ): Promise<CompileResult | null> {
    const revision = ++this.#latest;

    // Abort in-flight work before starting more. The adapter tears the engine
    // down on abort and rebuilds it lazily, so this costs an init on the next
    // compile rather than leaving two engines racing for the same preview.
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;

    this.#onState({ status: "compiling", revision });

    let result: CompileResult;
    try {
      result = await this.#compiler.compile({
        revision,
        mainFile,
        files,
        signal: controller.signal,
      });
    } catch (error) {
      // An engine that throws rather than returning a failure has broken in a
      // way the adapter did not model. Rebuild it, so the next keystroke is
      // not compiling against a dead worker, and report it as a failure the
      // view can render like any other.
      if (this.#controller === controller) this.#controller = null;
      await this.#compiler.restart().catch(() => {});
      if (revision !== this.#latest) return null;
      const message = error instanceof Error ? error.message : String(error);
      const failure: CompileResult = {
        ok: false,
        revision,
        category: "engine",
        summary: message,
        log: "",
        diagnostics: [],
        engine: this.#compiler.engine,
        durationMs: 0,
      };
      this.#onState({ status: "done", revision, result: failure });
      return failure;
    }

    if (this.#controller === controller) this.#controller = null;
    if (revision !== this.#latest) return null;

    this.#onState({ status: "done", revision, result });
    return result;
  }

  /** Stop the current compile. The view returns to whatever it last drew. */
  cancel(): void {
    this.#controller?.abort();
    this.#controller = null;
    this.#onState({ status: "idle" });
  }

  async dispose(): Promise<void> {
    this.#controller?.abort();
    this.#controller = null;
    await this.#compiler.dispose();
  }
}
