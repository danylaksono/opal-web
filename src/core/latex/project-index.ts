import type { ProjectPath } from "@/core/project/ids";
import { scanBib, scanTex, type TexFacts, type TexSection } from "./scan";

/**
 * A project's cross-file structure, and what is wrong with it
 * (PLAN.md 14, Phase 3: "semantic index and project health").
 *
 * `scan.ts` answers what one file says; this answers the questions that span
 * files, which are the ones a person cannot answer by looking at the screen: is
 * this `\ref` pointing at a label that exists *somewhere*, is this citation in
 * any bibliography, does this `\input` name a file the project has.
 *
 * Everything is recomputed from the files given. An incremental index would be
 * faster and would have to be invalidated correctly, and a wrong index is worse
 * than a slow one — scanning the largest corpus project, a 16-page thesis,
 * costs well under a millisecond, so there is nothing yet to buy.
 */

export type ProblemKind =
  | "undefined-reference"
  | "duplicate-label"
  | "undefined-citation"
  | "missing-input"
  | "missing-graphic";

export interface ProjectProblem {
  kind: ProblemKind;
  file: ProjectPath;
  line: number;
  /** The label key, citation key or filename the problem is about. */
  subject: string;
  message: string;
}

export interface OutlineEntry extends TexSection {
  file: ProjectPath;
}

export interface ProjectIndex {
  /** Per file, so a view can show the open one without filtering. */
  facts: Map<ProjectPath, TexFacts>;
  /** Sections in document order, following `\input` from the main file. */
  outline: OutlineEntry[];
  /** Label key to every place it is defined; more than one is a problem. */
  labels: Map<string, { file: ProjectPath; line: number }[]>;
  /** Every citation key any bibliography defines. */
  bibliographyKeys: Set<string>;
  problems: ProjectProblem[];
}

export interface IndexInput {
  path: ProjectPath;
  content: string;
}

/**
 * Labels that a package defines rather than the document.
 *
 * `letter-formal` puts `\pageref{LastPage}` in its footer and loads
 * `lastpage`, which is correct LaTeX and would otherwise be the corpus's only
 * "undefined reference" — a false positive on the very first real document the
 * index met. Keyed by package, not a blind allowlist, so the same key in a
 * project that has not loaded the package is still reported.
 */
const PACKAGE_LABELS: Record<string, string[]> = {
  lastpage: ["LastPage", "VeryLastPage"],
  totpages: ["TotPages"],
};

/** Extensions TeX will try when a name has none. */
const TEX_EXTENSIONS = [".tex", ".ltx"];
const GRAPHIC_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg"];

function resolveTarget(
  target: string,
  known: Set<string>,
  extensions: string[],
): string | null {
  if (known.has(target)) return target;
  for (const extension of extensions) {
    if (known.has(`${target}${extension}`)) return `${target}${extension}`;
  }
  return null;
}

/**
 * Sections in reading order: a file's own, with each `\input` expanded where it
 * appears.
 *
 * A thesis is a `main.tex` of `\input` lines and nothing else, so an outline
 * that stopped at file boundaries would show a document with no chapters in it.
 * Cycles are possible — `\input` is not checked by anyone — so a file already
 * being visited is skipped rather than followed.
 */
function collectOutline(
  path: ProjectPath,
  index: Map<ProjectPath, TexFacts>,
  known: Set<string>,
  visiting: Set<string>,
  out: OutlineEntry[],
): void {
  const facts = index.get(path);
  if (!facts || visiting.has(path)) return;
  visiting.add(path);

  const events = [
    ...facts.sections.map((section) => ({
      line: section.line,
      section,
      input: null as string | null,
    })),
    ...facts.inputs.map((input) => ({
      line: input.line,
      section: null as TexSection | null,
      input: input.target,
    })),
  ].sort((left, right) => left.line - right.line);

  for (const event of events) {
    if (event.section) {
      out.push({ ...event.section, file: path });
      continue;
    }
    const resolved = event.input
      ? resolveTarget(event.input, known, TEX_EXTENSIONS)
      : null;
    if (resolved) {
      collectOutline(resolved as ProjectPath, index, known, visiting, out);
    }
  }

  visiting.delete(path);
}

export function buildProjectIndex(
  files: readonly IndexInput[],
  mainFile: ProjectPath,
): ProjectIndex {
  const facts = new Map<ProjectPath, TexFacts>();
  const bibliographyKeys = new Set<string>();
  const known = new Set(files.map((file) => file.path as string));

  for (const file of files) {
    if (file.path.endsWith(".bib")) {
      for (const entry of scanBib(file.content))
        bibliographyKeys.add(entry.key);
      continue;
    }
    // Classes and styles are scanned too: a template that defines `\label`s or
    // loads `lastpage` is part of what the document means, and several corpus
    // projects ship one.
    if (!/\.(tex|ltx|cls|sty)$/.test(file.path)) continue;
    facts.set(file.path, scanTex(file.content));
  }

  const labels = new Map<string, { file: ProjectPath; line: number }[]>();
  const packages = new Set<string>();
  for (const [path, fileFacts] of facts) {
    for (const label of fileFacts.labels) {
      const places = labels.get(label.key) ?? [];
      places.push({ file: path, line: label.line });
      labels.set(label.key, places);
    }
    for (const item of fileFacts.bibItems) bibliographyKeys.add(item.key);
    for (const name of fileFacts.packages) packages.add(name);
  }

  const knownLabels = new Set(labels.keys());
  for (const [name, provided] of Object.entries(PACKAGE_LABELS)) {
    if (packages.has(name)) for (const key of provided) knownLabels.add(key);
  }

  const problems: ProjectProblem[] = [];

  for (const [key, places] of labels) {
    if (places.length < 2) continue;
    // Reported at every definition but the first: the first one is not the
    // mistake, and highlighting all of them says "one of these is wrong"
    // without saying which.
    for (const place of places.slice(1)) {
      problems.push({
        kind: "duplicate-label",
        file: place.file,
        line: place.line,
        subject: key,
        message: `Label ${key} is also defined in ${places[0]?.file} line ${places[0]?.line}`,
      });
    }
  }

  for (const [path, fileFacts] of facts) {
    for (const reference of fileFacts.references) {
      if (knownLabels.has(reference.key)) continue;
      problems.push({
        kind: "undefined-reference",
        file: path,
        line: reference.line,
        subject: reference.key,
        message: `No \\label{${reference.key}} in this project`,
      });
    }

    // Citations are only checkable when the project carries its own
    // bibliography. A `\bibliography{refs}` naming a file that is not here is
    // a project whose keys live somewhere this index cannot see, and guessing
    // would report every citation in it as undefined.
    const hasBibliography =
      bibliographyKeys.size > 0 &&
      fileFacts.bibResources.every((resource) =>
        resolveTarget(resource.target, known, [".bib"]),
      );
    if (hasBibliography) {
      for (const citation of fileFacts.citations) {
        if (bibliographyKeys.has(citation.key)) continue;
        problems.push({
          kind: "undefined-citation",
          file: path,
          line: citation.line,
          subject: citation.key,
          message: `No bibliography entry for ${citation.key}`,
        });
      }
    }

    for (const input of fileFacts.inputs) {
      if (resolveTarget(input.target, known, TEX_EXTENSIONS)) continue;
      problems.push({
        kind: "missing-input",
        file: path,
        line: input.line,
        subject: input.target,
        message: `${input.target} is not a file in this project`,
      });
    }

    for (const graphic of fileFacts.graphics) {
      if (resolveTarget(graphic.target, known, GRAPHIC_EXTENSIONS)) continue;
      problems.push({
        kind: "missing-graphic",
        file: path,
        line: graphic.line,
        subject: graphic.target,
        message: `${graphic.target} is not a file in this project`,
      });
    }
  }

  const outline: OutlineEntry[] = [];
  collectOutline(mainFile, facts, known, new Set(), outline);

  problems.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line,
  );

  return { facts, outline, labels, bibliographyKeys, problems };
}
