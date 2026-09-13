import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { type Diagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";

/**
 * The editing surface (PLAN.md 14, Phase 3).
 *
 * Replaces a six-row textarea, which was honest scaffolding for Phase 1 —
 * storage was the thing being proved — and stopped being honest the moment a
 * compile could produce a sixteen-page document from it.
 *
 * CodeMirror 6, and only the parts a LaTeX source needs today: line numbers,
 * undo, LaTeX highlighting, wrapping. No completion, no diagnostics in the
 * gutter, no outline. Those are the rest of Phase 3 and each wants the semantic
 * index that does not exist yet; adding their extensions now would be
 * configuring behaviour with nothing behind it.
 *
 * `stex` is CodeMirror's legacy stream mode rather than a Lezer grammar.
 * A Lezer LaTeX grammar would give a parse tree — which is what folding,
 * structural selection and a reliable outline eventually need — and there is no
 * maintained one on npm. The stream mode colours a document correctly and knows
 * nothing about its structure, which is exactly the trade for the features
 * listed above being absent.
 */

/**
 * One instance per document, which the caller declares with React's `key`.
 *
 * Switching files has to replace the document *and* its undo history — undo
 * following a user from one file into another is a data-loss bug wearing a
 * keyboard shortcut — and a remount is how that is said in React. A prop the
 * effect watched would do the same thing less honestly, by listing something it
 * never reads.
 */
/**
 * What the editor can offer to complete, from the project's semantic index.
 *
 * Keys rather than a completion source, so this component knows nothing about
 * where they came from — and so that the day completion has to include commands
 * or packages, that is a change to what is passed in rather than to the editor.
 */
export interface Completions {
  labels: readonly string[];
  citations: readonly string[];
}

/**
 * What is being typed, and which set of keys answers it.
 *
 * `\ref{sec:` completes against labels and `\cite{knu` against bibliography
 * keys, including after a comma — `\cite{a,b` is one command with two keys, and
 * a user typing the second one is asking the same question as the first.
 */
const REFERENCE_PREFIX =
  /\\(?:auto|page|name|c|C|eq|v)?ref(?:range)?\{([^}]*)$/;
const CITATION_PREFIX =
  /\\(?:no|paren|text|auto|foot|full)?cite[a-zA-Z]*\{([^}]*)$/;

/**
 * A problem to mark in the gutter, already narrowed to this file.
 *
 * Line-only, because that is all either source has: TeX reports a line and the
 * index records one, and inventing a column from either would put a squiggle
 * under an arbitrary character.
 */
export interface EditorProblem {
  line: number;
  message: string;
  severity: "error" | "warning";
}

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** Read at completion time, so typing does not rebuild the view. */
  completions?: Completions;
  /** Marked in the gutter and under the line. */
  problems?: readonly EditorProblem[];
  /**
   * Ctrl/Cmd+Enter, which is the compile the writer actually wants.
   *
   * Tabbing out of a text editor to reach the button means leaving the
   * document, passing the outline and the problem list, pressing it, and
   * finding the way back. Reachable is not the same as usable, and both are
   * part of the keyboard criterion.
   */
  onSubmit?: () => void;
  /**
   * A line to put the cursor on and scroll into view.
   *
   * Carries a nonce because the request is an event, not a state: clicking the
   * same outline entry twice, having scrolled away in between, must move the
   * view both times, and a bare line number would compare equal and do nothing
   * the second time.
   */
  reveal?: { line: number; nonce: number } | null;
}

export function CodeEditor({
  value,
  onChange,
  label,
  completions,
  problems,
  onSubmit,
  reveal,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /**
   * The current callback, read at dispatch time.
   *
   * The view is built once per document and the callback is rebuilt on every
   * render, so capturing it in the extension would compile against whichever
   * `content` was in scope when the file was opened — the stale-closure shape
   * that has already cost this repository a defect in the compile loop.
   */
  const notify = useRef(onChange);
  notify.current = onChange;
  /**
   * The content as of this render, for the view that is about to be built.
   *
   * A ref rather than the prop, so that "the document this view starts with" is
   * a value read once at build time instead of a dependency that would rebuild
   * the view — destroying it under the cursor — on every keystroke.
   */
  const initial = useRef(value);
  initial.current = value;
  const available = useRef(completions);
  available.current = completions;
  /** What is currently on the document, so identical sets are not re-dispatched. */
  const marked = useRef<string | null>(null);
  const submit = useRef(onSubmit);
  submit.current = onSubmit;

  /**
   * Offer the project's own keys, and only where one is being written.
   *
   * There is no fuzzy matching over the whole document and no word completion:
   * what a LaTeX writer cannot hold in their head is which labels and citation
   * keys exist, and both of those are exact strings that fail silently when
   * mistyped — a `\ref` to a label that does not exist renders as `??`.
   */
  const complete = useRef(
    (context: CompletionContext): CompletionResult | null => {
      const before = context.state.sliceDoc(
        context.state.doc.lineAt(context.pos).from,
        context.pos,
      );
      const reference = REFERENCE_PREFIX.exec(before);
      const citation = reference ? null : CITATION_PREFIX.exec(before);
      const match = reference ?? citation;
      if (!match) return null;

      // The part after the last comma: the key being typed, not the list.
      const typed = (match[1] ?? "").split(",").at(-1) ?? "";
      const keys = reference
        ? (available.current?.labels ?? [])
        : (available.current?.citations ?? []);
      if (keys.length === 0) return null;

      return {
        from: context.pos - typed.length,
        options: keys.map((key) => ({
          label: key,
          type: reference ? "variable" : "constant",
        })),
        // Without this the list closes as soon as a key contains a character the
        // default word pattern does not, and label keys are full of colons.
        validFor: /^[^},]*$/,
      };
    },
  );

  useEffect(() => {
    if (!host.current) return;
    const instance = new EditorView({
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          lineNumbers(),
          lintGutter(),
          history(),
          autocompletion({
            override: [(context) => complete.current(context)],
          }),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                submit.current?.();
                // Handled either way: falling through would insert a newline
                // as well as compiling.
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
          ]),
          StreamLanguage.define(stex),
          EditorView.lineWrapping,
          // On the content element rather than the host: a test — and a screen
          // reader — wants the thing that actually holds the text and takes the
          // typing, not the box around it.
          EditorView.contentAttributes.of({
            "data-testid": "editor-content",
            "aria-label": label,
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) notify.current(update.state.doc.toString());
          }),
        ],
      }),
      parent: host.current,
    });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
  }, [label]);

  /**
   * Adopt a change made to this file from outside the editor.
   *
   * Rare but real: a conflict resolved by re-reading, an import landing on the
   * open path. Guarded on inequality, because dispatching the document a user
   * is already looking at would move their cursor to the end of it on every
   * render.
   */
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const current = instance.state.doc.toString();
    if (current === value) return;
    instance.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  /**
   * Put the current problems on the document.
   *
   * Pushed in rather than computed by a `linter()`: nothing here can decide
   * whether a document is wrong. One source is the engine, which has to be run,
   * and the other is the project index, which spans files — both live above
   * this component and both arrive when they arrive.
   */
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    // The array is rebuilt on every keystroke — the index behind it is — so the
    // content decides whether to dispatch, not the identity. A transaction per
    // character would be noise on the editor's own state for no visible change.
    const signature = (problems ?? [])
      .map(
        (problem) => `${problem.line}:${problem.severity}:${problem.message}`,
      )
      .join("\n");
    if (signature === marked.current) return;
    marked.current = signature;

    const total = instance.state.doc.lines;
    const marks: Diagnostic[] = (problems ?? [])
      // A stale problem can outlive the line it was about — an edit after a
      // failed compile is the ordinary case — and a diagnostic past the end of
      // the document throws inside the dispatch.
      .filter((problem) => problem.line >= 1 && problem.line <= total)
      .map((problem) => {
        const line = instance.state.doc.line(problem.line);
        return {
          from: line.from,
          to: line.to,
          severity: problem.severity,
          message: problem.message,
        };
      });
    instance.dispatch(setDiagnostics(instance.state, marks));
  }, [problems]);

  useEffect(() => {
    const instance = view.current;
    if (!instance || !reveal) return;
    // Clamped: an outline entry is only as fresh as the last index, and a line
    // that has since been deleted must not throw inside a dispatch.
    const line = Math.min(Math.max(reveal.line, 1), instance.state.doc.lines);
    const found = instance.state.doc.line(line);
    instance.dispatch({
      selection: { anchor: found.from },
      effects: EditorView.scrollIntoView(found.from, { y: "center" }),
    });
    instance.focus();
  }, [reveal]);

  return (
    <div
      ref={host}
      data-testid="editor-host"
      style={{
        border: "1px solid var(--line, #ccc)",
        maxHeight: "24rem",
        overflow: "auto",
        fontSize: "0.9rem",
      }}
    />
  );
}
