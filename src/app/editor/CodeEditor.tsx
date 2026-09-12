import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
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
interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
}

export function CodeEditor({ value, onChange, label }: CodeEditorProps) {
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

  useEffect(() => {
    if (!host.current) return;
    const instance = new EditorView({
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
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
