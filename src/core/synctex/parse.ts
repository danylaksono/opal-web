import type { Rect } from "@/core/pdf/types";

/**
 * SyncTeX text format (version 1), forward search only (ADR-012).
 *
 * There is no desktop JS to port here — desktop shells out to the native
 * `synctex` command. This is a from-scratch parser of the well-documented
 * text format, calibrated against a real compile rather than trusted from
 * memory: `tests/fixtures/synctex-probe/` holds an actual `.synctex.gz`
 * (decompressed) from this engine and the real PDF rect MuPDF's `searchPage`
 * found for the same word, and `tests/unit/synctex-parse.test.ts` checks this
 * parser's output against that ground truth. See the ADR for the numbers.
 *
 * The format nests boxes: `[…` (vbox) and `(…` (hbox) open with their own
 * `tag,line:h,v:width,height,depth`, closed by a bare `]` / `)`. Inside, leaf
 * records — `h`/`v` (void boxes, which carry their own dimensions), `k`
 * (kern, a width only) and `g` (glue, a bare point) — carry the `tag,line` a
 * word was read on. The surprise, found by inspecting a real file rather than
 * assuming the spec's happy path: the *leaf* carries the accurate source
 * line, but the *enclosing box*, closed after TeX has read ahead, is often
 * tagged with the *next* line (including a blank one). A parser that only
 * reads box headers — the "minimal surface" this started from — silently
 * finds nothing for a real paragraph's first line. So every leaf type is
 * parsed, and a leaf match reports its enclosing box (the nearest open one),
 * not the leaf's own point or its own often-degenerate box (an `h` leaf here
 * was a 15pt paragraph-indent marker with zero height — a sliver, not a
 * usable highlight).
 */

export interface SyncTexPreamble {
  /** Tag -> path exactly as TeX read it (often absolute, engine-rooted). */
  inputs: ReadonlyMap<number, string>;
  magnification: number;
  /** sp, added to every `h` before conversion. */
  xOffset: number;
  /** sp, added to every `v` before conversion. */
  yOffset: number;
}

export interface SyncTexBox {
  tag: number;
  line: number;
  /** All in sp (1/65536 TeX pt), before offset or unit conversion. */
  h: number;
  v: number;
  width: number;
  height: number;
  depth: number;
}

interface SyncTexHit {
  tag: number;
  line: number;
  box: SyncTexBox;
}

export interface SyncTexDocument extends SyncTexPreamble {
  /** Page number (1-based) -> every record found on it, in file order. */
  pages: ReadonlyMap<number, readonly SyncTexHit[]>;
}

const RE_INPUT = /^Input:(\d+):(.*)$/;
const RE_MAGNIFICATION = /^Magnification:(-?\d+)$/;
const RE_X_OFFSET = /^X Offset:(-?\d+)$/;
const RE_Y_OFFSET = /^Y Offset:(-?\d+)$/;
const RE_PAGE_BEGIN = /^\{(\d+)$/;
const RE_PAGE_END = /^\}(\d+)$/;
const RE_BOX_BEGIN =
  /^[[(](\d+),(\d+):(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)$/;
const RE_BOX_END = /^[\])]$/;
const RE_SIZED_LEAF =
  /^[hv](\d+),(\d+):(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)$/;
const RE_KERN = /^k(\d+),(\d+):(-?\d+),(-?\d+):(-?\d+)$/;
const RE_GLUE = /^g(\d+),(\d+):(-?\d+),(-?\d+)$/;
const RE_POSTAMBLE = /^Postamble:$/;

function parseBox(match: RegExpMatchArray): SyncTexBox {
  const [, tag, line, h, v, width, height, depth] = match;
  return {
    tag: Number(tag),
    line: Number(line),
    h: Number(h),
    v: Number(v),
    width: Number(width),
    height: Number(height),
    depth: Number(depth),
  };
}

/**
 * Parse a decompressed `.synctex` file. Anything not needed for forward
 * search — `$` math boundaries, the postamble's counts — is ignored, and a
 * line matching nothing recognised is skipped rather than treated as an
 * error: `!<n>` byte-offset markers precede almost every group and are noise
 * for this purpose.
 */
export function parseSyncTex(text: string): SyncTexDocument {
  const inputs = new Map<number, string>();
  let magnification = 1000;
  let xOffset = 0;
  let yOffset = 0;

  const pages = new Map<number, SyncTexHit[]>();
  let currentPage: number | null = null;
  let currentHits: SyncTexHit[] = [];
  const stack: SyncTexBox[] = [];

  for (const line of text.split("\n")) {
    const input = RE_INPUT.exec(line);
    if (input) {
      inputs.set(Number(input[1]), input[2] ?? "");
      continue;
    }
    if (RE_POSTAMBLE.test(line)) break;

    const magMatch = RE_MAGNIFICATION.exec(line);
    if (magMatch) {
      magnification = Number(magMatch[1]);
      continue;
    }
    const xMatch = RE_X_OFFSET.exec(line);
    if (xMatch) {
      xOffset = Number(xMatch[1]);
      continue;
    }
    const yMatch = RE_Y_OFFSET.exec(line);
    if (yMatch) {
      yOffset = Number(yMatch[1]);
      continue;
    }

    const pageBegin = RE_PAGE_BEGIN.exec(line);
    if (pageBegin) {
      currentPage = Number(pageBegin[1]);
      currentHits = [];
      stack.length = 0;
      continue;
    }
    const pageEnd = RE_PAGE_END.exec(line);
    if (pageEnd) {
      if (currentPage !== null) pages.set(currentPage, currentHits);
      currentPage = null;
      continue;
    }
    if (currentPage === null) continue;

    const boxBegin = RE_BOX_BEGIN.exec(line);
    if (boxBegin) {
      const box = parseBox(boxBegin);
      stack.push(box);
      currentHits.push({ tag: box.tag, line: box.line, box });
      continue;
    }
    if (RE_BOX_END.test(line)) {
      stack.pop();
      continue;
    }

    const sizedLeaf = RE_SIZED_LEAF.exec(line);
    const kern = sizedLeaf ? null : RE_KERN.exec(line);
    const glue = sizedLeaf || kern ? null : RE_GLUE.exec(line);
    const leafTagLine = sizedLeaf ?? kern ?? glue;
    if (leafTagLine) {
      const enclosing = stack[stack.length - 1];
      if (enclosing) {
        currentHits.push({
          tag: Number(leafTagLine[1]),
          line: Number(leafTagLine[2]),
          box: enclosing,
        });
      }
    }
  }

  return { inputs, magnification, xOffset, yOffset, pages };
}

/** `/a/b/./main.tex` and `main.tex` name the same file. */
function sameSource(recorded: string, wanted: string): boolean {
  const normalize = (path: string) =>
    path.replace(/\/\.\//g, "/").replace(/^\.\//, "");
  return normalize(recorded).endsWith(normalize(wanted));
}

/**
 * Every box recorded for `(file, line)`, across every page, in reading order.
 * Coarser than a text search by design — PLAN.md calls this route out as
 * resolving a source line, not a span — because it reports the enclosing
 * typeset line rather than a word's own position.
 */
export function forwardSearchSyncTex(
  doc: SyncTexDocument,
  file: string,
  line: number,
): Array<{ page: number; box: SyncTexBox }> {
  const tags = new Set<number>();
  for (const [tag, path] of doc.inputs) {
    if (sameSource(path, file)) tags.add(tag);
  }
  if (tags.size === 0) return [];

  const results: Array<{ page: number; box: SyncTexBox }> = [];
  for (const [page, hits] of doc.pages) {
    for (const hit of hits) {
      if (hit.line === line && tags.has(hit.tag)) {
        results.push({ page, box: hit.box });
      }
    }
  }
  return results;
}

/**
 * 1 TeX pt (1/72.27 in) in PDF points (1/72 in, "big points"). Calibrated
 * against `searchPage` ground truth in `tests/unit/synctex-parse.test.ts` —
 * without it, positions are off by the ~0.4% that distinguishes the two
 * units, which does not fail that test's generous tolerance on its own but
 * is the documented, correct factor rather than an approximation.
 */
const PT_TO_BP = 72 / 72.27;

/**
 * A `SyncTexBox` as a PDF-point `Rect`, top-left origin, y increasing
 * downward — the same convention `src/core/pdf/types.ts` documents.
 *
 * `magnification` is applied uniformly to the box and the offsets, matching
 * every reference SyncTeX client; **unverified here**, because every
 * document this was checked against compiles at the default 1000 (`\mag`
 * scaling and non-100%-magnification `\magnification` are both untested —
 * see ADR-012).
 */
export function synctexBoxToRect(
  preamble: SyncTexPreamble,
  box: SyncTexBox,
): Rect {
  const scale = preamble.magnification / 1000;
  const toBp = (sp: number) => (sp * scale * PT_TO_BP) / 65536;

  const x = toBp(box.h + preamble.xOffset);
  const y = toBp(box.v - box.height + preamble.yOffset);
  return {
    x,
    y,
    width: toBp(box.width),
    height: toBp(box.height + box.depth),
  };
}
