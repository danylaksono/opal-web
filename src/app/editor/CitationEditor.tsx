import { XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BibEntry,
  type Citation,
  isCitationKey,
  searchBibliography,
} from "@/core/latex/citation";
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
 * Pick what a citation cites (PLAN.md 14, Phase 3: structured editors).
 *
 * Desktop's citation picker, adapted: search by anything remembered — author,
 * a title word, a year, part of the key — and tick entries. Inline and applied
 * explicitly, like the table editor, so the source stays visible and nothing
 * is written until Apply.
 *
 * Keyboard: typing searches, Enter adds the top match (or, with nothing
 * matching, the typed text as a key), Ctrl/Cmd+Enter applies, Escape cancels.
 */

/** Past this many matches the list is not the way to find an entry. */
const SHOWN = 50;

interface CitationEditorProps {
  citation: Citation;
  entries: readonly BibEntry[];
  /** Commands to offer; the citation's own is added if it is not among them. */
  commands: readonly string[];
  /** Whether a prenote means anything: natbib and biblatex, not plain `\cite`. */
  prenotes: boolean;
  onApply: (citation: Citation) => void;
  onCancel: () => void;
}

function describe(entry: BibEntry): string {
  const when = entry.year ? ` (${entry.year})` : "";
  const lead = `${entry.authors}${when}`;
  return lead.trim() ? `${lead}. ${entry.title}` : entry.title;
}

export function CitationEditor({
  citation,
  entries,
  commands,
  prenotes,
  onApply,
  onCancel,
}: CitationEditorProps) {
  const [draft, setDraft] = useState(citation);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const byKey = useMemo(
    () => new Map(entries.map((entry) => [entry.key, entry])),
    [entries],
  );
  const matches = useMemo(
    () => searchBibliography(entries, query),
    [entries, query],
  );
  const offered = commands.includes(draft.command)
    ? commands
    : [draft.command, ...commands];

  useEffect(() => {
    search.current?.focus();
  }, []);

  const toggle = (key: string) =>
    setDraft((previous) => ({
      ...previous,
      keys: previous.keys.includes(key)
        ? previous.keys.filter((existing) => existing !== key)
        : [...previous.keys, key],
    }));

  return (
    <fieldset
      data-testid="citation-editor"
      className="rounded-lg border bg-card p-3 text-card-foreground shadow-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (
          event.key === "Enter" &&
          (event.ctrlKey || event.metaKey) &&
          draft.keys.length > 0
        ) {
          event.preventDefault();
          onApply(draft);
        }
      }}
    >
      <legend className="px-1 font-medium text-sm">
        Citation: {draft.keys.length}{" "}
        {draft.keys.length === 1 ? "work" : "works"}
      </legend>

      <div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <label htmlFor="citation-command">Command</label>
        <Select
          value={draft.command}
          onValueChange={(command) => setDraft({ ...draft, command })}
        >
          <SelectTrigger
            id="citation-command"
            data-testid="citation-command"
            className="h-7 w-40 font-mono text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {offered.map((command) => (
              <SelectItem key={command} value={command} className="font-mono">
                \{command}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/*
          Shown when the document can use it, or when it already has one: a
          prenote the picker hid would still be written back, invisibly.
        */}
        {(prenotes || draft.prenote) && (
          <>
            <label htmlFor="citation-prenote">Before</label>
            <Input
              id="citation-prenote"
              data-testid="citation-prenote"
              value={draft.prenote}
              placeholder="see"
              className="h-7 w-24 font-mono text-xs"
              onChange={(event) =>
                setDraft({ ...draft, prenote: event.target.value })
              }
            />
          </>
        )}

        <label htmlFor="citation-postnote">After</label>
        <Input
          id="citation-postnote"
          data-testid="citation-postnote"
          value={draft.postnote}
          placeholder="p.~4"
          className="h-7 w-24 font-mono text-xs"
          onChange={(event) =>
            setDraft({ ...draft, postnote: event.target.value })
          }
        />
      </div>

      {draft.keys.length > 0 && (
        <ol
          data-testid="citation-selected"
          className="mb-2 space-y-1 rounded border bg-muted/40 p-2"
        >
          {draft.keys.map((key) => {
            const known = byKey.get(key);
            return (
              <li key={key} className="flex items-center gap-2 text-xs">
                <code className="shrink-0 font-mono">{key}</code>
                {known ? (
                  <span className="min-w-0 truncate text-muted-foreground">
                    {describe(known)}
                  </span>
                ) : (
                  // Kept, not dropped: the key may live in a `.bib` outside
                  // this project, which is the index's rule too.
                  <span className="text-amber-600 dark:text-amber-400">
                    not in this project's bibliography
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid="citation-remove"
                  aria-label={`Remove ${key}`}
                  className="ml-auto size-5 shrink-0"
                  onClick={() => toggle(key)}
                >
                  <XIcon className="size-3" />
                </Button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <label htmlFor="citation-search">Find</label>
        <Input
          ref={search}
          id="citation-search"
          data-testid="citation-search"
          type="search"
          value={query}
          placeholder="author, title, year or key"
          aria-describedby="citation-matches"
          spellCheck={false}
          className="h-7 max-w-64 flex-1 text-xs"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            const text = query.trim();
            const top = text ? matches[0] : undefined;
            const key = top?.key ?? (isCitationKey(text) ? text : null);
            if (!key) return;
            if (!draft.keys.includes(key)) toggle(key);
            setQuery("");
          }}
        />
        {/*
          Polite: it changes on every keystroke of a search, and a count read
          over the top of each letter would drown the letters.
        */}
        <span id="citation-matches" role="status" data-testid="citation-count">
          {entries.length === 0
            ? "This project has no bibliography entries; Enter adds what you type as a key."
            : matches.length === 0
              ? isCitationKey(query.trim())
                ? "No matches; Enter adds it as a key."
                : "No matches."
              : `${matches.length} ${matches.length === 1 ? "match" : "matches"}${
                  matches.length > SHOWN ? `, first ${SHOWN} shown` : ""
                }`}
        </span>
      </div>

      {matches.length > 0 && (
        <ul
          data-testid="citation-results"
          className="max-h-56 space-y-0.5 overflow-y-auto rounded border p-1"
        >
          {matches.slice(0, SHOWN).map((entry) => (
            <li key={entry.key}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted">
                <input
                  type="checkbox"
                  data-testid="citation-result"
                  data-key={entry.key}
                  checked={draft.keys.includes(entry.key)}
                  onChange={() => toggle(entry.key)}
                />
                <code className="shrink-0 font-mono">{entry.key}</code>
                <span className="min-w-0 truncate text-muted-foreground">
                  {describe(entry)}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 flex items-center gap-2">
        <span className="flex-1" />
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          data-testid="citation-apply"
          disabled={draft.keys.length === 0}
          onClick={() => onApply(draft)}
        >
          Apply
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          data-testid="citation-cancel"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </p>
    </fieldset>
  );
}
