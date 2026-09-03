/**
 * Font failures Siglum's own resolution cannot see, and what to do about them.
 *
 * The bundle set carries only the Computer Modern lineage — CM, Latin Modern,
 * EC and the AMS faces. Nothing from the URW base-35 set is there, so a
 * document selecting Times, Helvetica or Courier resolves its `.fd` file
 * (those *are* bundled, in `tex-latex-misc`) and then dies for want of a
 * `.tfm`.
 *
 * Neither of the adapter's existing resolution paths can see this:
 *
 * - TeX reports it as a font error, not "File `x' not found", so the
 *   missing-file matcher never fires;
 * - Siglum's `file-to-package.json` indexes only `.sty`, `.cls`, `.fd`,
 *   `.def`, `.cfg`, `.clo`, `.tex` and `.ltx`, so a font filename maps to
 *   nothing even when it is asked.
 *
 * The mapping therefore has to be stated here, and it is stated by NFSS family
 * prefix, which is what the TFM name is built from.
 */

import { unwrap } from "./log-diagnostics";

/** TeX Live packages that ship the font metrics NFSS asks for by name. */
const FONT_FAMILY_PACKAGES: Record<string, string> = {
  bch: "charter",
  pag: "avantgar",
  pbk: "bookman",
  pcr: "courier",
  phv: "helvetic",
  pnc: "ncntrsbk",
  ppl: "palatino",
  psy: "symbol",
  ptm: "times",
  put: "utopia",
  pzc: "zapfchan",
  pzd: "zapfding",
};

/**
 * `! Font T1/ptm/m/n/10=ptmr8t at 10.0pt not loadable: Metric (TFM) file or
 * installed font not found.` — the name after `=` is the TFM TeX wanted.
 */
const FONT_NOT_LOADABLE =
  /Font [^\n=]*=([A-Za-z][A-Za-z0-9-]*)[^\n]*not loadable/g;

/**
 * The same error with a bracketed filename,
 * `=[FontAwesome5Free-Solid-900.otf]`: a file handed to the XeTeX font loader
 * rather than a TFM, and a different problem. See `unresolvableFonts`.
 */
const FONT_FILE_NOT_LOADABLE = /Font [^\n=]*=\[([^\]\n]+)\][^\n]*not loadable/g;

/**
 * TeX wraps at 79 characters, so a font error's name and its "not loadable"
 * routinely land on different physical lines. Both matchers read the unwrapped
 * message rather than the raw log.
 */
function logicalLines(log: string): string {
  return unwrap(log.split(/\r?\n/)).join("\n");
}

/** TeX Live packages for the font metrics TeX reported it could not load. */
export function missingFontPackages(log: string): string[] {
  const packages = new Set<string>();
  for (const match of logicalLines(log).matchAll(FONT_NOT_LOADABLE)) {
    const owner = FONT_FAMILY_PACKAGES[match[1]?.slice(0, 3) ?? ""];
    if (owner) packages.add(owner);
  }
  return [...packages];
}

/**
 * Font files XeTeX was asked to load by filename and could not find.
 *
 * These are reported, never resolved: Siglum's CTAN fetcher keeps only `.pfb`,
 * `.pfm`, `.afm`, `.tfm`, `.vf`, `.map` and `.enc` from a fetched package and
 * discards the rest, so an `.otf` cannot be delivered through it even though
 * the pinned archive ships one. Naming the file in the failure summary is the
 * most the adapter can do until that is fixed upstream.
 */
export function unresolvableFonts(log: string): string[] {
  const names = new Set<string>();
  for (const match of logicalLines(log).matchAll(FONT_FILE_NOT_LOADABLE)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

/**
 * Definitions the precompiled format is missing, prepended to every source.
 *
 * `\languagename` is defined by babel's `hyphen.cfg` when a stock TeX Live
 * builds its formats. Siglum's are not built that way, so the macro does not
 * exist, and `translator` — which beamer loads unconditionally — expands it at
 * `\begin{document}` and stops with "Undefined control sequence". A document
 * that loads babel never meets this; one that does not cannot compile at all.
 *
 * The same omission costs typography everywhere else. `hyphen.cfg` also sets
 * `\lefthyphenmin` and `\righthyphenmin`; without it they keep TeX's primitive
 * default of zero, and the engine breaks words after a single letter —
 * "p-resentations", "S-tandards". The fidelity comparison found this across
 * four corpus documents before anything crashed. Setting the two primitives
 * produces output identical to loading babel, at none of its download cost.
 *
 * 2 and 3 are English's conventional minima, which is what `hyphen.cfg` sets
 * for the default language. They are wrong for some languages and right for
 * none universally — but a document in another language loads babel, which
 * overrides them, and every value is better than zero.
 *
 * Prepended without a newline, so every line of the user's document keeps its
 * number and SyncTeX and diagnostic line mapping stay exact. `\providecommand`
 * yields to babel where a document does load it.
 */
export const FORMAT_SHIMS = String.raw`\providecommand{\languagename}{english}\lefthyphenmin=2 \righthyphenmin=3 `;
