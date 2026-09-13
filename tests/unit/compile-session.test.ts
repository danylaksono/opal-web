import { describe, expect, it } from "vitest";
import {
  CompileSession,
  type CompileState,
} from "@/app/workspace/compile-session";
import type {
  CompileRequest,
  CompileResult,
  EngineIdentity,
  LatexCompiler,
} from "@/core/compiler/types";
import { projectPath } from "@/core/project/ids";

const ENGINE: EngineIdentity = {
  id: "fake",
  name: "fake",
  version: "0",
  packageSetVersion: "none",
};

/**
 * A compiler whose timing the test controls.
 *
 * The behaviour under test is entirely about ordering — which result arrives
 * when, and which one is allowed to reach the view — so a real engine would
 * only add three seconds and a source of flakiness per case.
 */
class ScriptedCompiler implements LatexCompiler {
  readonly engine = ENGINE;
  restarts = 0;
  readonly #pending = new Map<
    number,
    { resolve: (result: CompileResult) => void; reject: (e: Error) => void }
  >();

  async init(): Promise<void> {}

  compile(request: CompileRequest): Promise<CompileResult> {
    return new Promise((resolve, reject) => {
      this.#pending.set(request.revision, { resolve, reject });
      request.signal?.addEventListener("abort", () => {
        this.#pending.delete(request.revision);
        resolve(failure(request.revision, "cancelled"));
      });
    });
  }

  finish(revision: number, ok = true): void {
    const entry = this.#pending.get(revision);
    if (!entry) throw new Error(`nothing pending at revision ${revision}`);
    this.#pending.delete(revision);
    entry.resolve(
      ok
        ? {
            ok: true,
            revision,
            pdf: new Uint8Array([1, 2, 3]),
            log: "",
            diagnostics: [],
            engine: ENGINE,
            durationMs: 1,
            passes: 1,
          }
        : failure(revision, "syntax"),
    );
  }

  throwAt(revision: number, message: string): void {
    const entry = this.#pending.get(revision);
    if (!entry) throw new Error(`nothing pending at revision ${revision}`);
    this.#pending.delete(revision);
    entry.reject(new Error(message));
  }

  async restart(): Promise<void> {
    this.restarts += 1;
  }

  async dispose(): Promise<void> {}
}

function failure(
  revision: number,
  category: "cancelled" | "syntax",
): CompileResult {
  return {
    ok: false,
    revision,
    category,
    summary: category,
    log: "",
    diagnostics: [],
    engine: ENGINE,
    durationMs: 1,
  };
}

function session(compiler: LatexCompiler) {
  const states: CompileState[] = [];
  const s = new CompileSession({ compiler, onState: (x) => states.push(x) });
  return { session: s, states };
}

const MAIN = projectPath("main.tex");
const FILES = [{ path: MAIN, content: new Uint8Array() }];

describe("CompileSession", () => {
  it("returns the result when it is still the newest", async () => {
    const compiler = new ScriptedCompiler();
    const { session: s, states } = session(compiler);

    const run = s.compile(MAIN, FILES);
    compiler.finish(1);

    const result = await run;
    expect(result?.ok).toBe(true);
    expect(states.at(-1)).toMatchObject({ status: "done", revision: 1 });
  });

  it("discards a stale result that lands after a newer request", async () => {
    const compiler = new ScriptedCompiler();
    const { session: s, states } = session(compiler);

    // Two compiles in flight, finishing out of order: the first is the one a
    // user sees as the preview reverting to the edit they already replaced.
    const first = s.compile(MAIN, FILES);
    const second = s.compile(MAIN, FILES);
    compiler.finish(2);
    expect(await second).toMatchObject({ ok: true, revision: 2 });

    // Revision 1 was aborted when 2 started, so it resolves as cancelled —
    // and either way it must not reach the view.
    expect(await first).toBeNull();
    expect(states.filter((x) => x.status === "done")).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({ revision: 2 });
  });

  it("cancels without leaving the session stuck compiling", async () => {
    const compiler = new ScriptedCompiler();
    const { session: s, states } = session(compiler);

    const run = s.compile(MAIN, FILES);
    expect(s.isCompiling).toBe(true);
    s.cancel();

    expect(s.isCompiling).toBe(false);
    expect(states.at(-1)).toEqual({ status: "idle" });

    // Null, and `idle` stays the last word.
    //
    // This used to assert the opposite — that the cancelled compile reported
    // its own cancellation — and that made the state machine incoherent:
    // `cancel()` published `idle`, then the abandoned compile resolved a
    // moment later and published `done` over it, so a user who pressed Cancel
    // watched the status turn into "Failed: cancelled" and their diagnostics
    // disappear. Nobody needs telling that the thing they cancelled was
    // cancelled; `cancel()` counts as a revision now, which makes the
    // abandoned run stale by the same rule that governs every other
    // superseded compile.
    expect(await run).toBeNull();
    expect(states.at(-1)).toEqual({ status: "idle" });
  });

  it("rebuilds the engine when a compile throws, and still reports", async () => {
    const compiler = new ScriptedCompiler();
    const { session: s, states } = session(compiler);

    const run = s.compile(MAIN, FILES);
    compiler.throwAt(1, "worker died");

    const result = await run;
    expect(result).toMatchObject({ ok: false, category: "engine" });
    expect(compiler.restarts).toBe(1);
    expect(states.at(-1)).toMatchObject({ status: "done" });
    // A dead worker must not leave the session believing one is running.
    expect(s.isCompiling).toBe(false);
  });

  it("keeps compiling after a failure, so an error is not a dead end", async () => {
    const compiler = new ScriptedCompiler();
    const { session: s } = session(compiler);

    const bad = s.compile(MAIN, FILES);
    compiler.finish(1, false);
    expect(await bad).toMatchObject({ ok: false, category: "syntax" });

    const good = s.compile(MAIN, FILES);
    compiler.finish(2);
    expect(await good).toMatchObject({ ok: true, revision: 2 });
  });
});
