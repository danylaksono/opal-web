import { useEffect, useMemo, useState } from "react";
import {
  delimiterProblem,
  isNumbered,
  type MathBlock,
  type MathKind,
  writeMath,
} from "@/core/latex/math";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

/**
 * Mathematics with a picture of it beside the source
 * (PLAN.md 14, Phase 3: structured editors).
 *
 * Desktop's math editor, adapted. What it adds over typing the environment by
 * hand is the preview — TeX reports a mistake in a formula as an error
 * somewhere later, often in another paragraph — and a `\label` that only
 * appears where a number will actually be printed.
 *
 * KaTeX is loaded when this form first opens, not with the application. It is
 * the first dependency here that someone who never writes mathematics would
 * otherwise pay for on a first load, and ADR-011 measures that load.
 */

const KINDS: { value: MathKind; label: string }[] = [
  { value: "inline", label: "Inline, in the sentence" },
  { value: "display", label: "Displayed, unnumbered" },
  { value: "equation", label: "equation" },
  { value: "align", label: "align" },
  { value: "gather", label: "gather" },
  { value: "multline", label: "multline" },
];

/** A few things nobody remembers the spelling of. */
const SNIPPETS: { label: string; source: string }[] = [
  { label: "Fraction", source: "\\frac{a}{b}" },
  { label: "Sum", source: "\\sum_{i=1}^{n} " },
  { label: "Integral", source: "\\int_{a}^{b} f(x)\\,dx" },
  { label: "Matrix", source: "\\begin{matrix} a & b \\\\ c & d \\end{matrix}" },
  {
    label: "Cases",
    source: "\\begin{cases} x & x > 0 \\\\ 0 & x \\leq 0 \\end{cases}",
  },
];

type Renderer = (body: string, display: boolean) => string;

/**
 * KaTeX, fetched once and shared by every later opening of the form.
 *
 * The stylesheet comes with it: the fonts it names are emitted as assets by
 * the build, so a preview works with no network — which is the whole claim of
 * this product.
 */
let loading: Promise<Renderer> | null = null;
function loadRenderer(): Promise<Renderer> {
  loading ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]).then(([katex]) => {
    const render: Renderer = (body, display) =>
      katex.default.renderToString(body, {
        displayMode: display,
        throwOnError: true,
      });
    return render;
  });
  return loading;
}

interface MathEditorProps {
  math: MathBlock;
  onApply: (math: MathBlock) => void;
  onCancel: () => void;
}

export function MathEditor({ math, onApply, onCancel }: MathEditorProps) {
  const [draft, setDraft] = useState(math);
  const [render, setRender] = useState<Renderer | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    void loadRenderer().then(
      (renderer) => live && setRender(() => renderer),
      () => live && setUnavailable(true),
    );
    return () => {
      live = false;
    };
  }, []);

  const preview = useMemo(() => {
    if (!render || !draft.body.trim()) return { html: "", error: null };
    try {
      return {
        html: render(draft.body, draft.kind !== "inline"),
        error: null,
      };
    } catch (cause) {
      return {
        html: "",
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }, [render, draft.body, draft.kind]);

  const delimiters = delimiterProblem(draft.body);
  const numbered = isNumbered(draft);

  return (
    <fieldset
      data-testid="math-editor"
      className="rounded-lg border bg-card p-3 text-card-foreground shadow-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          onApply(draft);
        }
      }}
    >
      <legend className="px-1 font-medium text-sm">Mathematics</legend>

      <div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <label htmlFor="math-kind">Set as</label>
        <Select
          value={draft.kind}
          onValueChange={(kind) =>
            setDraft({ ...draft, kind: kind as MathKind })
          }
        >
          <SelectTrigger
            id="math-kind"
            data-testid="math-kind"
            className="h-7 min-w-52 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((kind) => (
              <SelectItem key={kind.value} value={kind.value}>
                {kind.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {draft.kind !== "inline" && draft.kind !== "display" && (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              data-testid="math-numbered"
              checked={!draft.starred}
              onChange={(event) =>
                setDraft({ ...draft, starred: !event.target.checked })
              }
            />
            Numbered
          </label>
        )}

        {/*
          Only where a number will be printed: a `\label` on an unnumbered
          environment refers to something the reader never sees.
        */}
        {numbered && (
          <>
            <label htmlFor="math-label">Label</label>
            <Input
              id="math-label"
              data-testid="math-label"
              value={draft.label}
              placeholder="eq:euler"
              className="h-7 w-36 font-mono text-xs"
              onChange={(event) =>
                setDraft({ ...draft, label: event.target.value })
              }
            />
          </>
        )}
      </div>

      <div className="mb-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label
            htmlFor="math-body"
            className="mb-1 block text-muted-foreground text-xs"
          >
            Source
          </label>
          <textarea
            id="math-body"
            data-testid="math-body"
            value={draft.body}
            spellCheck={false}
            rows={5}
            placeholder="E = mc^2"
            className="w-full resize-y rounded border bg-background p-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onChange={(event) =>
              setDraft({ ...draft, body: event.target.value })
            }
          />
          <div className="mt-1 flex flex-wrap gap-1">
            {SNIPPETS.map((snippet) => (
              <Button
                key={snippet.label}
                variant="outline"
                size="sm"
                data-testid="math-snippet"
                className="h-6 px-2 text-[11px]"
                onClick={() =>
                  setDraft((previous) => ({
                    ...previous,
                    body: `${previous.body}${previous.body && !previous.body.endsWith(" ") ? " " : ""}${snippet.source}`,
                  }))
                }
              >
                {snippet.label}
              </Button>
            ))}
          </div>
        </div>

        <div>
          <span className="mb-1 block text-muted-foreground text-xs">
            Preview
          </span>
          <div
            data-testid="math-preview"
            className="flex min-h-24 items-center justify-center overflow-x-auto rounded border bg-muted/30 p-2 text-sm"
          >
            {unavailable ? (
              <span className="text-muted-foreground text-xs">
                The preview could not be loaded; the source is still written as
                you typed it.
              </span>
            ) : !render ? (
              <span className="text-muted-foreground text-xs">Loading…</span>
            ) : preview.html ? (
              // KaTeX's own markup, from the body in the field beside it.
              // biome-ignore lint/security/noDangerouslySetInnerHtml: this is KaTeX's rendering of the author's own input, which is the point of a preview
              <span dangerouslySetInnerHTML={{ __html: preview.html }} />
            ) : (
              <span className="text-muted-foreground text-xs">
                Nothing to show yet.
              </span>
            )}
          </div>
          {/*
            Said, never enforced. KaTeX refuses plenty of correct LaTeX — a
            `\eqref`, a macro the preamble defines, anything from a package —
            and a preview that could block Apply would be a preview deciding
            what compiles.
          */}
          {preview.error && (
            <p
              data-testid="math-preview-error"
              className="mt-1 text-amber-600 text-xs dark:text-amber-400"
            >
              The preview cannot draw this: {preview.error.split("\n")[0]}
            </p>
          )}
          {delimiters && (
            <p
              data-testid="math-delimiters"
              className="mt-1 text-amber-600 text-xs dark:text-amber-400"
            >
              {delimiters}. TeX would report this somewhere later.
            </p>
          )}
        </div>
      </div>

      <p className="flex items-center gap-2">
        <span className="flex-1" />
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          data-testid="math-apply"
          disabled={!draft.body.trim()}
          onClick={() => onApply(draft)}
        >
          Apply
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          data-testid="math-cancel"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </p>

      <details className="mt-2">
        <summary className="cursor-pointer text-muted-foreground text-xs">
          Source preview
        </summary>
        <pre
          data-testid="math-source"
          className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2 text-[11px]"
        >
          {writeMath(draft)}
        </pre>
      </details>
    </fieldset>
  );
}
