import { describe, expect, it } from "vitest";
import {
  type Figure,
  figureAt,
  isGraphic,
  newFigure,
  writeFigure,
} from "@/core/latex/figure";
import { buildProjectIndex } from "@/core/latex/project-index";
import { projectPath } from "@/core/project/ids";

/** Read the figure at the `¶` marker, which is removed from the source. */
function figureIn(marked: string): { source: string; figure: Figure } {
  const offset = marked.indexOf("¶");
  const source = marked.slice(0, offset) + marked.slice(offset + 1);
  const found = figureAt(source, offset);
  if (!found?.ok) {
    throw new Error(`no figure: ${found ? found.reason : "not in one"}`);
  }
  return { source, figure: found.figure };
}

/** Apply an edit the way the panel does: write back into the span. */
function applied(source: string, figure: Figure, change: Partial<Figure>) {
  const edited = { ...figure, ...change };
  return (
    source.slice(0, figure.from) + writeFigure(edited) + source.slice(figure.to)
  );
}

const FIGURE = [
  "Before.",
  "\\begin{figure}[htbp]",
  "  \\centering",
  "  \\includegraphics[width=0.8\\linewidth]{figures/plot.png}",
  "  \\caption{A plot}",
  "  \\label{fig:plot}",
  "\\end{figure}",
  "After.",
].join("\n");

describe("figureAt", () => {
  it("reads the five things a person fills in", () => {
    const { figure } = figureIn(FIGURE.replace("A plot", "A pl¶ot"));
    expect(figure).toMatchObject({
      environment: "figure",
      path: "figures/plot.png",
      caption: "A plot",
      label: "fig:plot",
      placement: "htbp",
      widthPercent: 80,
      widthUnit: "\\linewidth",
      centered: true,
      otherOptions: [],
    });
  });

  it("keeps a width unit that is not the one it would have written", () => {
    const { figure } = figureIn(
      "\\begin{figure}\n\\includegraphics[width=0.5\\textwidth,angle=90]{a.pdf}¶\n\\end{figure}",
    );
    expect(figure.widthUnit).toBe("\\textwidth");
    expect(figure.otherOptions).toEqual(["angle=90"]);
    // No `[...]` on the environment is not the same as `[htbp]`.
    expect(figure.placement).toBeNull();
  });

  it("is null outside a figure, and in one that is commented out", () => {
    expect(figureAt(FIGURE, 0)).toBeNull();
    expect(figureAt("% \\begin{figure}\\end{figure}", 20)).toBeNull();
  });

  it("refuses what the form would edit only half of", () => {
    expect(
      figureAt("\\begin{figure}\n  \\caption{Soon}\n\\end{figure}", 20),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no \\includegraphics"),
    });
    expect(
      figureAt(
        "\\begin{figure}\n\\includegraphics{a.png}\n\\includegraphics{b.png}\n\\end{figure}",
        30,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("2 images") });
  });
});

describe("writeFigure", () => {
  it("changes only what was asked for", () => {
    const { source, figure } = figureIn(FIGURE.replace("A plot", "A pl¶ot"));
    expect(applied(source, figure, { caption: "A better plot" })).toBe(
      FIGURE.replace("A plot", "A better plot"),
    );
  });

  it("does not add a placement to a figure that had none", () => {
    const original = [
      "\\begin{figure}",
      "  \\includegraphics{a.png}",
      "\\end{figure}",
    ].join("\n");
    const { source, figure } = figureIn(original.replace("a.png", "a.png¶"));
    // An edit to the caption must not quietly pin the float.
    expect(applied(source, figure, { caption: "Hello" })).toBe(
      [
        "\\begin{figure}",
        "  \\includegraphics{a.png}",
        "  \\caption{Hello}",
        "\\end{figure}",
      ].join("\n"),
    );
  });

  it("keeps what it does not model", () => {
    const original = [
      "\\begin{figure}[t]",
      "  \\centering",
      "  \\vspace{-2pt}",
      "  \\includegraphics[width=0.4\\textwidth,keepaspectratio]{a.pdf}",
      "  \\caption{Old}",
      "  \\label{fig:a}",
      "  \\footnotesize Source: ours.",
      "\\end{figure}",
    ].join("\n");
    const { source, figure } = figureIn(original.replace("Old", "O¶ld"));

    const written = applied(source, figure, {
      caption: "New",
      widthPercent: 60,
    });
    expect(written).toContain("\\vspace{-2pt}");
    expect(written).toContain("\\footnotesize Source: ours.");
    expect(written).toContain("width=0.6\\textwidth,keepaspectratio");
    expect(written).toContain("\\caption{New}");
  });

  it("adds a label after the caption, never before it", () => {
    const original = [
      "\\begin{figure}",
      "  \\includegraphics{a.png}",
      "  \\caption{Some plot}",
      "\\end{figure}",
    ].join("\n");
    const { source, figure } = figureIn(original.replace("Some", "So¶me"));
    const written = applied(source, figure, { label: "fig:a" });

    // A `\label` before its `\caption` numbers the section instead, and the
    // reference then points somewhere else entirely.
    expect(written.indexOf("\\label")).toBeGreaterThan(
      written.indexOf("\\caption"),
    );
  });

  it("removes a caption, a label and the centring when they are cleared", () => {
    const { source, figure } = figureIn(FIGURE.replace("A plot", "A pl¶ot"));
    const written = applied(source, figure, {
      caption: "",
      label: "",
      centered: false,
      widthPercent: null,
    });
    expect(written).toBe(
      [
        "Before.",
        "\\begin{figure}[htbp]",
        "  \\includegraphics{figures/plot.png}",
        "\\end{figure}",
        "After.",
      ].join("\n"),
    );
  });

  it("round-trips: what it writes, it reads back the same", () => {
    const { source, figure } = figureIn(FIGURE.replace("A plot", "A pl¶ot"));
    const written = applied(source, figure, {
      caption: "Changed",
      widthPercent: 55,
      label: "fig:changed",
    });
    const again = figureAt(written, written.indexOf("Changed"));
    expect(again?.ok && again.figure).toMatchObject({
      caption: "Changed",
      widthPercent: 55,
      label: "fig:changed",
      path: "figures/plot.png",
    });
  });
});

describe("a figure the form inserts", () => {
  it("starts on its own line and carries caption before label", () => {
    const source = "See this: ";
    const figure = newFigure(source, source.length);
    const written = writeFigure({
      ...figure,
      path: "figures/plot.png",
      caption: "A plot",
      label: "fig:plot",
    });

    expect(written).toBe(
      [
        "",
        "\\begin{figure}[htbp]",
        "  \\centering",
        "  \\includegraphics[width=0.8\\linewidth]{figures/plot.png}",
        "  \\caption{A plot}",
        "  \\label{fig:plot}",
        "\\end{figure}",
      ].join("\n"),
    );
  });

  /**
   * The path the form writes has to be the path the index resolves.
   *
   * `resolveTarget` checks the project's own file list first: a basename where
   * the project holds `figures/plot.png` still compiles, because TeX searches
   * `\graphicspath`, but project health would report a missing graphic on a
   * document that is fine. Writing what the file list gives makes the two
   * agree by construction.
   */
  it("writes a path the project index resolves", () => {
    const figure = newFigure("", 0);
    const written = writeFigure({
      ...figure,
      path: "figures/plot.png",
      caption: "A plot",
    });
    const index = buildProjectIndex(
      [
        {
          path: projectPath("main.tex"),
          content: `\\documentclass{article}\n\\begin{document}\n${written}\n\\end{document}\n`,
        },
        { path: projectPath("figures/plot.png"), content: "" },
      ],
      projectPath("main.tex"),
    );

    expect(index.problems).toEqual([]);
  });
});

describe("isGraphic", () => {
  it.each(["a.png", "b.JPG", "c.pdf", "d.eps", "e.svg"])("takes %s", (path) => {
    expect(isGraphic(path)).toBe(true);
  });

  it.each(["main.tex", "refs.bib", "notes.txt"])("refuses %s", (path) => {
    expect(isGraphic(path)).toBe(false);
  });
});
