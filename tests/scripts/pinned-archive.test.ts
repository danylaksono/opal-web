import { describe, expect, it } from "vitest";
import { texmfPath } from "../../scripts/build-pinned-archive";

/**
 * The source bundle is flat, so where a file lands is decided here rather than
 * recovered. kpathsea searches by file type, which makes these placements the
 * difference between a file TeX finds and one it does not.
 */
describe("texmfPath", () => {
  it("puts font metrics where kpathsea looks for metrics", () => {
    expect(texmfPath("lmr10.tfm")).toBe(
      "/texlive/texmf-dist/fonts/tfm/pinned/lmr10.tfm",
    );
    expect(texmfPath("lmr10.vf")).toBe(
      "/texlive/texmf-dist/fonts/vf/pinned/lmr10.vf",
    );
  });

  it("separates outline formats, which are searched separately", () => {
    expect(texmfPath("lmr10.pfb")).toContain("/fonts/type1/");
    expect(texmfPath("lmroman10-regular.otf")).toContain("/fonts/opentype/");
    expect(texmfPath("FontAwesome.ttf")).toContain("/fonts/truetype/");
    expect(texmfPath("ec.enc")).toContain("/fonts/enc/");
    expect(texmfPath("pdftex.map")).toContain("/fonts/map/");
  });

  it("puts a class or package on the latex path", () => {
    expect(texmfPath("article.cls")).toBe(
      "/texlive/texmf-dist/tex/latex/pinned/article.cls",
    );
    expect(texmfPath("booktabs.sty")).toContain("/tex/latex/");
  });

  it("puts plain-TeX inputs on the generic path", () => {
    // `tex/generic` is searched by latex too, and pgf reaches for its `.tex`
    // files through \input rather than \usepackage.
    expect(texmfPath("pgfutil-common.tex")).toBe(
      "/texlive/texmf-dist/tex/generic/pinned/pgfutil-common.tex",
    );
  });

  it("puts bibliography styles where BibTeX looks", () => {
    expect(texmfPath("plainnat.bst")).toContain("/bibtex/bst/");
  });

  it("falls back to the latex path for an unfamiliar extension", () => {
    expect(texmfPath("lipsum.ltd.tex")).toContain("/tex/generic/");
    expect(texmfPath("listings.cfg")).toContain("/tex/latex/");
  });
});
