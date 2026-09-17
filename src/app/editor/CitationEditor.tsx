import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BibEntry,
  type Citation,
  isCitationKey,
  searchBibliography,
} from "@/core/latex/citation";

/**
 * Pick what a citation cites (PLAN.md 14, Phase 3: structured editors).
 *
 * Search by anything remembered — author, a title word, a year, part of the
 * key — and tick entries. Inline and applied explicitly, like the table editor,
 * for the same reasons: the source stays visible, nothing is written until
 * Apply, and there is no modal focus trap to get wrong.
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
  const who = entry.authors ? `${entry.authors}` : "";
  const when = entry.year ? ` (${entry.year})` : "";
  const lead = `${who}${when}`;
  return lead ? `${lead}. ${entry.title}` : entry.title;
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
      className="citation-editor"
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
      <legend>
        Citation: {draft.keys.length}{" "}
        {draft.keys.length === 1 ? "work" : "works"}
      </legend>

      <p className="note">
        <label>
          Command{" "}
          <select
            data-testid="citation-command"
            value={draft.command}
            onChange={(event) =>
              setDraft({ ...draft, command: event.target.value })
            }
          >
            {offered.map((command) => (
              <option key={command} value={command}>
                \{command}
              </option>
            ))}
          </select>
        </label>{" "}
        {/*
          Shown when the document can use it, or when it already has one: a
          prenote the grid hid would still be written back, invisibly.
        */}
        {(prenotes || draft.prenote) && (
          <label>
            Before{" "}
            <input
              data-testid="citation-prenote"
              value={draft.prenote}
              placeholder="see"
              size={8}
              onChange={(event) =>
                setDraft({ ...draft, prenote: event.target.value })
              }
            />
          </label>
        )}{" "}
        <label>
          After{" "}
          <input
            data-testid="citation-postnote"
            value={draft.postnote}
            placeholder="p.~4"
            size={8}
            onChange={(event) =>
              setDraft({ ...draft, postnote: event.target.value })
            }
          />
        </label>
      </p>

      {draft.keys.length > 0 && (
        <ol data-testid="citation-selected" className="citation-selected">
          {draft.keys.map((key) => {
            const known = byKey.get(key);
            return (
              <li key={key}>
                <code>{key}</code>{" "}
                {known ? (
                  <span className="note">{describe(known)}</span>
                ) : (
                  // Kept, not dropped: the key may live in a `.bib` outside
                  // this project, which is the index's rule too.
                  <span className="optional-missing">
                    not in this project's bibliography
                  </span>
                )}{" "}
                <button
                  type="button"
                  data-testid="citation-remove"
                  aria-label={`Remove ${key}`}
                  onClick={() => toggle(key)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <p className="note">
        <label>
          Find{" "}
          <input
            ref={search}
            data-testid="citation-search"
            type="search"
            value={query}
            placeholder="author, title, year or key"
            aria-describedby="citation-matches"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.ctrlKey || event.metaKey) {
                return;
              }
              event.preventDefault();
              const text = query.trim();
              const top = text ? matches[0] : undefined;
              const key = top?.key ?? (isCitationKey(text) ? text : null);
              if (!key) return;
              if (!draft.keys.includes(key)) toggle(key);
              setQuery("");
            }}
          />
        </label>{" "}
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
      </p>

      {matches.length > 0 && (
        <ul data-testid="citation-results" className="citation-results">
          {matches.slice(0, SHOWN).map((entry) => (
            <li key={entry.key}>
              <label>
                <input
                  type="checkbox"
                  data-testid="citation-result"
                  data-key={entry.key}
                  checked={draft.keys.includes(entry.key)}
                  onChange={() => toggle(entry.key)}
                />{" "}
                <code>{entry.key}</code> {describe(entry)}
              </label>
            </li>
          ))}
        </ul>
      )}

      <p className="note">
        <button
          type="button"
          data-testid="citation-apply"
          disabled={draft.keys.length === 0}
          onClick={() => onApply(draft)}
        >
          Apply
        </button>{" "}
        <button type="button" data-testid="citation-cancel" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </fieldset>
  );
}
