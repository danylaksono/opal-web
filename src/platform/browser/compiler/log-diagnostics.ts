import type {
  CompileDiagnostic,
  CompileFailureCategory,
} from "@/core/compiler/types";
import type { ProjectPath } from "@/core/project/ids";

/**
 * Parse a TeX log into structured diagnostics.
 *
 * TeX's log is the only channel the engine gives us, and it is a stream of
 * console output rather than a data format, so this is deliberately
 * conservative: report what can be attributed confidently and leave the raw log
 * available for everything else. Over-parsing produces confident nonsense,
 * which is worse than an unparsed line the user can still read.
 *
 * Two behaviours are worth naming:
 *
 * - **File attribution** follows TeX's parenthesis stack. TeX prints `(./x.tex`
 *   when it opens a file and `)` when it closes one, interleaved with
 *   everything else, so tracking depth is the only way to say which file an
 *   error came from.
 * - **Line numbers** come from the `l.<n>` marker TeX prints *after* the error
 *   text, so a diagnostic is only complete once the following lines are read.
 */

const ERROR_LINE = /^! (?:(.+?) )?Error: (.+)$|^! (.+)$/;
const LINE_MARKER = /^l\.(\d+)/;
const LATEX_WARNING = /^(?:LaTeX|Package|Class)(?: (\S+))? Warning: (.+)$/;
const MISSING_FILE = /File `([^']+)' not found/;
const UNDEFINED_CONTROL = /^! Undefined control sequence/;

/** TeX wraps log lines at 79 characters, which splits paths mid-token. */
const WRAP_WIDTH = 79;

/**
 * Rejoin lines TeX split at its wrap width.
 *
 * Exported because any matcher reading raw engine output needs it: a font
 * error's "not loadable" can land on the next line from the font it names, so
 * a pattern written against the logical message finds nothing in the physical
 * one.
 */
export function unwrap(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      previous.length >= WRAP_WIDTH &&
      line.length > 0 &&
      !line.startsWith("!") &&
      !line.startsWith("l.")
    ) {
      out[out.length - 1] = previous + line;
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Where a filename ends in TeX's log.
 *
 * TeX prints `(` and the path and then keeps going *on the same line with no
 * space*, so the very first line of any log reads
 * `(./main.texLaTeX2e <2024-11-01> patch level 1`. Taking the token up to the
 * next whitespace gives the file as `main.texLaTeX2e`, which matches no file in
 * the project — so every diagnostic in the main file was attributed to a file
 * that does not exist. It showed up the moment something tried to *use* the
 * attribution rather than print it: the gutter had nothing to mark.
 *
 * Ending the name at a known TeX extension is what separates the path from
 * whatever TeX said next.
 */
const TEX_PATH_END =
  /\.(?:tex|ltx|sty|cls|clo|def|cfg|fd|bst|bbl|aux|toc|lof|lot|out|nav|snm|vrb|bib|dfu|enc|cnf|tikz|code)/i;

function fileFromToken(token: string): string | null {
  const match = TEX_PATH_END.exec(token);
  if (match) return token.slice(0, match.index + match[0].length);
  // An extension this does not know about, standing alone: keep the old
  // behaviour rather than lose the file, since a token that *ends* in an
  // extension has nothing appended to it.
  return /\.\w+$/.test(token) ? token : null;
}

/**
 * Track the file TeX is currently reading by following its parenthesis stack.
 *
 * Only `(` immediately followed by a path-like token opens a file; TeX also
 * prints ordinary parentheses in prose, so anything else is ignored rather than
 * pushed, which would desynchronise the stack for the rest of the log.
 */
function updateFileStack(stack: string[], line: string): void {
  const pattern = /([()])([^\s()]*)/g;
  let match: RegExpExecArray | null = pattern.exec(line);
  while (match !== null) {
    if (match[1] === "(") {
      const path = fileFromToken(match[2] ?? "");
      if (path) {
        stack.push(path.replace(/^\.\//, ""));
      } else {
        // A bare "(" in prose. Push a placeholder so the matching ")" pops
        // something harmless instead of closing a real file.
        stack.push("");
      }
    } else if (stack.length > 0) {
      stack.pop();
    }
    match = pattern.exec(line);
  }
}

function currentFile(stack: string[]): ProjectPath | undefined {
  for (let index = stack.length - 1; index >= 0; index--) {
    const entry = stack[index];
    if (entry) return entry as ProjectPath;
  }
  return undefined;
}

function categoriseMessage(message: string): CompileFailureCategory {
  if (UNDEFINED_CONTROL.test(`! ${message}`)) return "undefined-command";
  // Order matters: a missing .sty also matches the generic missing-file
  // pattern, and "install a package" is far more actionable to a user than
  // "a file is missing".
  if (/\.(sty|cls|bst|fd)' not found/.test(message)) return "missing-package";
  if (MISSING_FILE.test(message)) return "missing-file";
  return "syntax";
}

export function parseTexLog(log: string): CompileDiagnostic[] {
  if (!log) return [];

  const lines = unwrap(log.split(/\r?\n/));
  const diagnostics: CompileDiagnostic[] = [];
  const stack: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    updateFileStack(stack, line);

    if (line.startsWith("! ")) {
      const match = ERROR_LINE.exec(line);
      const message = match?.[2] ?? match?.[3] ?? line.slice(2);

      // The l.<n> marker follows the error, usually within a few lines.
      let lineNumber: number | undefined;
      for (
        let look = index + 1;
        look < Math.min(index + 8, lines.length);
        look++
      ) {
        const marker = LINE_MARKER.exec(lines[look] ?? "");
        if (marker?.[1]) {
          lineNumber = Number(marker[1]);
          break;
        }
      }

      const file = currentFile(stack);
      diagnostics.push({
        severity: "error",
        message: message.trim(),
        category: categoriseMessage(message),
        ...(file ? { file } : {}),
        ...(lineNumber !== undefined ? { line: lineNumber } : {}),
      });
      continue;
    }

    const warning = LATEX_WARNING.exec(line);
    if (warning?.[2]) {
      const file = currentFile(stack);
      const onLine = /on input line (\d+)/.exec(warning[2]);
      diagnostics.push({
        severity: "warning",
        message: warning[1]
          ? `${warning[1]}: ${warning[2].trim()}`
          : warning[2].trim(),
        category: "syntax",
        ...(file ? { file } : {}),
        ...(onLine?.[1] ? { line: Number(onLine[1]) } : {}),
      });
    }
  }

  return diagnostics;
}

/** The first error, which is the one worth putting in a failure summary. */
export function firstError(
  diagnostics: readonly CompileDiagnostic[],
): CompileDiagnostic | undefined {
  return diagnostics.find((d) => d.severity === "error");
}

/**
 * The ways LaTeX asks for another pass.
 *
 * Deliberately the same set Siglum matches internally, so the adapter and the
 * engine agree on what a rerun request looks like and differ only on when they
 * are willing to act on one.
 */
const RERUN_REQUEST =
  /Rerun to get|Label\(s\) may have changed|There were undefined references|Rerun LaTeX|Please rerun/i;

/**
 * Whether TeX asked to be run again.
 *
 * TeX resolves forward references through the `.aux` file: a first pass writes
 * what it learned, a second reads it back. Until then a `\ref` prints `??`, a
 * table of contents is empty, and — the case that surfaced this — a TikZ
 * `remember picture` overlay draws nothing at all, because the page node
 * coordinates it needs are written on the pass that has just finished.
 *
 * Siglum decides how many passes to run by pattern-matching the source before
 * compiling: `\ref`, `\cite`, `\label`, `\tableofcontents` and friends. A
 * document that needs a second pass for any other reason gets one pass and a
 * silently incomplete result, because the prediction has already fixed the
 * budget by the time TeX says otherwise. Reading the request from the log
 * instead is the whole fix: TeX knows, and it says so.
 */
export function needsRerun(log: string): boolean {
  return RERUN_REQUEST.test(log);
}

/**
 * Map an engine failure onto the categories the desktop UI already renders.
 *
 * A missing package is called out separately from a generic missing file
 * because on every browser engine measured so far it means the package set is
 * short of the document, not that the user mistyped a filename — a distinction
 * the user can act on. Shared by the adapters: the categories are the port's,
 * not any one engine's, and two engines disagreeing about what counts as a
 * missing package would show up as an engine difference in the corpus results
 * when it was only an adapter difference.
 */
export function categoriseFailure(
  error: string,
  log: string,
  diagnostics: readonly CompileDiagnostic[],
): CompileFailureCategory {
  const haystack = `${error}\n${log}`;
  if (/Undefined control sequence/i.test(haystack)) return "undefined-command";
  if (/shell escape|\\write18/i.test(haystack)) return "shell-escape-refused";
  if (/out of memory|allocation failed/i.test(haystack)) return "out-of-memory";
  if (/File `[^']+\.(sty|cls|bst)' not found|not installed/i.test(haystack)) {
    return "missing-package";
  }
  if (/File `[^']+' not found|cannot find/i.test(haystack))
    return "missing-file";
  if (diagnostics.some((d) => d.severity === "error")) return "syntax";
  return "unknown";
}
