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
      const path = match[2] ?? "";
      if (/\.\w+$/.test(path)) {
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
