import { describe, expect, it } from "vitest";
import {
  FORMAT_SHIMS,
  missingFontPackages,
  unresolvableFonts,
} from "@/platform/browser/compiler/font-resolution";

/**
 * Fixtures are trimmed from the ADR-003 corpus runs that first hit these,
 * `paper-ieee` and `cv-modern`, so the shapes here are the ones the product
 * will meet.
 */

const MISSING_TFM_LOG = [
  "kpathsea: Running mktextfm ptmr8t",
  "(/texlive/texmf-dist/tex/latex/psnfss/t1ptm.fd)",
  "! Font T1/ptm/m/n/10=ptmr8t at 10.0pt not loadable: Metric (TFM) file or instal",
  "led font not found.",
  "<to be read again>",
  "l.116 ...\\familydefault\\seriesdefault\\shapedefault",
].join("\n");

const MISSING_OTF_LOG = [
  "(/texlive/texmf-dist/tex/tufontawesomefree.fd)",
  "! Font TU/fontawesomefree/solid/n/10.95=[FontAwesome5Free-Solid-900.otf]:script",
  "=latn; at 10.95pt not loadable: Metric (TFM) file or installed font not found.",
].join("\n");

describe("missingFontPackages", () => {
  it("returns nothing for a log with no font failure", () => {
    expect(missingFontPackages("(./main.tex) [1] Output written")).toEqual([]);
  });

  it("names the TeX Live package for a missing Times metric", () => {
    expect(missingFontPackages(MISSING_TFM_LOG)).toEqual(["times"]);
  });

  it("maps by NFSS family prefix, not by exact TFM name", () => {
    // ptmb8t, ptmri8t and ptmr7t are all Times; all come from one package.
    const log = [
      "! Font T1/ptm/b/n/10=ptmb8t at 10.0pt not loadable: Metric (TFM) file",
      "! Font T1/ptm/m/it/10=ptmri8t at 10.0pt not loadable: Metric (TFM) file",
      "! Font OT1/phv/m/n/10=phvr7t at 10.0pt not loadable: Metric (TFM) file",
    ].join("\n");
    expect(missingFontPackages(log)).toEqual(["times", "helvetic"]);
  });

  it("ignores a family it has no package for, rather than guessing", () => {
    const log = "! Font T1/zzz/m/n/10=zzzr8t at 10.0pt not loadable: Metric";
    expect(missingFontPackages(log)).toEqual([]);
  });

  it("ignores a bracketed font file, which is a different failure", () => {
    expect(missingFontPackages(MISSING_OTF_LOG)).toEqual([]);
  });
});

describe("unresolvableFonts", () => {
  it("returns nothing for a log with no font failure", () => {
    expect(unresolvableFonts("(./main.tex) [1] Output written")).toEqual([]);
  });

  it("names the font file XeTeX could not load", () => {
    expect(unresolvableFonts(MISSING_OTF_LOG)).toEqual([
      "FontAwesome5Free-Solid-900.otf",
    ]);
  });

  it("reports each missing file once", () => {
    const log = [MISSING_OTF_LOG, MISSING_OTF_LOG].join("\n");
    expect(unresolvableFonts(log)).toHaveLength(1);
  });

  it("ignores a missing TFM, which the adapter can resolve", () => {
    expect(unresolvableFonts(MISSING_TFM_LOG)).toEqual([]);
  });
});

describe("FORMAT_SHIMS", () => {
  it("adds no line, so the user's line numbers survive", () => {
    expect(FORMAT_SHIMS).not.toContain("\n");
  });

  it("defers to a document that defines the macro itself", () => {
    expect(FORMAT_SHIMS).toContain("\\providecommand");
  });

  it("sets hyphenation minima, which the format leaves at zero", () => {
    expect(FORMAT_SHIMS).toContain("\\lefthyphenmin=2");
    expect(FORMAT_SHIMS).toContain("\\righthyphenmin=3");
  });

  it("terminates its last number, so the document cannot extend it", () => {
    // TeX reads digits until something that is not one. A document whose first
    // character is a digit would otherwise be absorbed into `3`.
    expect(FORMAT_SHIMS.endsWith(" ")).toBe(true);
  });
});
