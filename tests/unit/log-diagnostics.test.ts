import { describe, expect, it } from "vitest";
import { parseTexLog } from "@/platform/browser/compiler/log-diagnostics";

/**
 * Fixtures are trimmed from real Siglum/BusyTeX output captured during the
 * ADR-003 corpus runs, so the shapes here are the ones the product will meet.
 */

const MISSING_PACKAGE_LOG = [
  "(./main.tex",
  "LaTeX2e <2024-06-01>",
  "(/texlive/texmf-dist/tex/latex/base/article.cls",
  "Document Class: article 2024/06/29 v1.4n Standard LaTeX document class",
  "(/texlive/texmf-dist/tex/latex/base/size12.clo))",
  "! LaTeX Error: File `booktabs.sty' not found.",
  "",
  "Type X to quit or <RETURN> to proceed,",
  "l.7 \\usepackage{booktabs}",
  "",
  "! Emergency stop.",
].join("\n");

const NFSS_LOG = [
  "(./main.tex",
  "(/texlive/texmf-dist/tex/latex/base/fontenc.sty",
  "LaTeX Font Warning: Font shape `T1/lmr/m/n' undefined",
  "(Font)              using `T1/lmr/m/n' instead on input line 116.",
  "! Corrupted NFSS tables.",
  "l.116 ...\\familydefault\\seriesdefault\\shapedefault",
].join("\n");

describe("parseTexLog", () => {
  it("returns nothing for an empty log", () => {
    expect(parseTexLog("")).toEqual([]);
  });

  it("extracts a missing package as an error with its line", () => {
    const diagnostics = parseTexLog(MISSING_PACKAGE_LOG);
    const error = diagnostics.find((d) => d.severity === "error");
    expect(error?.message).toBe("File `booktabs.sty' not found.");
    expect(error?.line).toBe(7);
  });

  it("distinguishes a missing package from a missing plain file", () => {
    const [pkg] = parseTexLog("! LaTeX Error: File `booktabs.sty' not found.");
    expect(pkg?.category).toBe("missing-package");

    const [asset] = parseTexLog("! LaTeX Error: File `diagram.png' not found.");
    expect(asset?.category).toBe("missing-file");
  });

  it("categorises an undefined control sequence", () => {
    const [error] = parseTexLog("! Undefined control sequence.");
    expect(error?.category).toBe("undefined-command");
  });

  it("attributes an error to the file TeX was reading", () => {
    const diagnostics = parseTexLog(MISSING_PACKAGE_LOG);
    // size12.clo opened and closed on the same line, so main.tex is current.
    expect(diagnostics[0]?.file).toBe("main.tex");
  });

  it("does not desynchronise on parentheses in prose", () => {
    const log = [
      "(./main.tex",
      "Package foo Warning: something (this is prose) continues",
      "! LaTeX Error: File `bar.sty' not found.",
    ].join("\n");
    const error = parseTexLog(log).find((d) => d.severity === "error");
    expect(error?.file).toBe("main.tex");
  });

  it("captures LaTeX warnings with their input line", () => {
    const [warning] = parseTexLog(
      "LaTeX Warning: Reference `fig:one' on page 1 undefined on input line 42.",
    );
    expect(warning?.severity).toBe("warning");
    expect(warning?.line).toBe(42);
  });

  it("labels package and class warnings with their source", () => {
    const [warning] = parseTexLog(
      "Package inputenc Warning: inputenc package ignored with utf8 based engines.",
    );
    expect(warning?.message).toContain("inputenc");
    expect(warning?.severity).toBe("warning");
  });

  it("reports the NFSS failure that the T1 font gap produces", () => {
    const diagnostics = parseTexLog(NFSS_LOG);
    const error = diagnostics.find((d) => d.severity === "error");
    expect(error?.message).toBe("Corrupted NFSS tables.");
    expect(error?.line).toBe(116);
    // Not a missing-file error, which is exactly why on-demand package
    // resolution cannot recover from it.
    expect(error?.category).toBe("syntax");
  });

  it("finds both the warning and the error in the same log", () => {
    const diagnostics = parseTexLog(NFSS_LOG);
    expect(diagnostics.filter((d) => d.severity === "warning")).toHaveLength(1);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(1);
  });

  it("rejoins lines TeX wrapped at 79 characters", () => {
    const long = `! LaTeX Error: File \`${"a".repeat(70)}`;
    expect(long.length).toBeGreaterThanOrEqual(79);
    const [error] = parseTexLog(`${long}\nlongtail.sty' not found.`);
    expect(error?.message).toContain("longtail.sty");
  });
});
