import { type ProjectPath, projectPath } from "./ids";
import type { ProjectFile } from "./repository";

/**
 * What a new project can start as (investigation.md 14, Phase 3: "templates").
 *
 * A blank `main.tex` is the worst possible starting point for the target user:
 * a researcher who knows what they want to write and not which incantation
 * produces a bibliography. Every template here exists to answer one of those
 * questions by example rather than by documentation.
 *
 * Deliberately five, and deliberately plain. Each one is a *starting point a
 * person will edit*, so anything they would have to delete is worse than
 * absent — no `\usepackage` they did not ask for, no placeholder prose beyond
 * what shows the structure working. The corpus in `tests/fixtures` is the
 * opposite thing: documents chosen to stress the engine, several of which no
 * one would want to start from.
 *
 * They are data, not files on disk, for two reasons: a template has to be
 * creatable while offline, and `tests/unit/project-templates.test.ts` runs the
 * semantic index over every one of them. A template that ships with a dangling
 * `\ref` teaches the mistake.
 */

export interface ProjectTemplate {
  id: string;
  /** Shown in the picker. */
  name: string;
  /** One line on what it is for, shown next to the name. */
  description: string;
  /** The file a compile is pointed at. */
  rootTexPath: ProjectPath;
  files: readonly ProjectFile[];
}

function file(path: string, content: string): ProjectFile {
  return { path: projectPath(path), bytes: new TextEncoder().encode(content) };
}

const BLANK = `\\documentclass{article}

\\begin{document}

Hello from Opal Web.

\\end{document}
`;

const ARTICLE = `\\documentclass[11pt]{article}

\\title{An article}
\\author{Your name}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
  One paragraph saying what this is and why it matters.
\\end{abstract}

\\section{Introduction}
\\label{sec:introduction}

What the problem is, and what this paper does about it.

\\section{Method}

How it was done. Refer back to a section by its label, as in
Section~\\ref{sec:introduction}.

\\section{Results}

What happened.

\\end{document}
`;

const PAPER_MAIN = `\\documentclass[11pt]{article}

\\title{A paper with references}
\\author{Your name}

\\begin{document}
\\maketitle

\\section{Introduction}

Cite a work by the key it has in \\texttt{references.bib}, like
this~\\cite{knuth1984}, or several at once~\\cite{knuth1984,lamport1994}.

Opal Web runs the bibliography pass for you when it sees a citation, so the
list below fills itself in the second time you compile.

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`;

const PAPER_BIB = `@book{knuth1984,
  author    = {Knuth, Donald E.},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}

@book{lamport1994,
  author    = {Lamport, Leslie},
  title     = {{\\LaTeX}: A Document Preparation System},
  publisher = {Addison-Wesley},
  year      = {1994},
  edition   = {2nd}
}
`;

const REPORT_MAIN = `\\documentclass[11pt]{report}

\\title{A report in chapters}
\\author{Your name}

\\begin{document}
\\maketitle
\\tableofcontents

% Each chapter is its own file. Add one by creating it in the file list and
% giving it a line here; the outline follows these in order.
\\input{chapter-one}
\\input{chapter-two}

\\end{document}
`;

const REPORT_ONE = `\\chapter{The first chapter}
\\label{ch:one}

Chapters live in their own files so that a long document stays navigable. This
one is \\texttt{chapter-one.tex}.
`;

const REPORT_TWO = `\\chapter{The second chapter}

A reference to another chapter works across files:
Chapter~\\ref{ch:one}.
`;

const LETTER = `\\documentclass[11pt]{letter}

\\signature{Your name}
\\address{Your street \\\\ Your town \\\\ Your postcode}

\\begin{document}

\\begin{letter}{The recipient \\\\ Their street \\\\ Their town}

\\opening{Dear Sir or Madam,}

What you have to say.

\\closing{Yours faithfully,}

\\end{letter}

\\end{document}
`;

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    description: "One file, one line, nothing to delete.",
    rootTexPath: projectPath("main.tex"),
    files: [file("main.tex", BLANK)],
  },
  {
    id: "article",
    name: "Article",
    description: "Title, abstract, sections, and a cross-reference.",
    rootTexPath: projectPath("main.tex"),
    files: [file("main.tex", ARTICLE)],
  },
  {
    id: "paper",
    name: "Paper with references",
    description: "An article and a .bib file, with the citation already wired.",
    rootTexPath: projectPath("main.tex"),
    files: [file("main.tex", PAPER_MAIN), file("references.bib", PAPER_BIB)],
  },
  {
    id: "report",
    name: "Report in chapters",
    description: "A main file that inputs a chapter per file.",
    rootTexPath: projectPath("main.tex"),
    files: [
      file("main.tex", REPORT_MAIN),
      file("chapter-one.tex", REPORT_ONE),
      file("chapter-two.tex", REPORT_TWO),
    ],
  },
  {
    id: "letter",
    name: "Letter",
    description: "The letter class, with addresses and an opening.",
    rootTexPath: projectPath("main.tex"),
    files: [file("main.tex", LETTER)],
  },
];

export function templateById(id: string): ProjectTemplate {
  const found = PROJECT_TEMPLATES.find((template) => template.id === id);
  // The picker only offers these, so a miss is a caller bug rather than input:
  // falling back silently would create a blank project and look like the
  // template did nothing.
  if (!found) throw new Error(`No project template ${id}`);
  return found;
}
