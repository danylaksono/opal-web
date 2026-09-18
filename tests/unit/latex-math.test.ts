import { describe, expect, it } from "vitest";
import {
  delimiterProblem,
  isNumbered,
  type MathBlock,
  mathAt,
  newMath,
  writeMath,
} from "@/core/latex/math";

/** Read the maths at the `¶` marker, which is removed from the source. */
function mathIn(marked: string): { source: string; math: MathBlock } {
  const offset = marked.indexOf("¶");
  const source = marked.slice(0, offset) + marked.slice(offset + 1);
  const found = mathAt(source, offset);
  if (!found?.ok) {
    throw new Error(`no maths: ${found ? found.reason : "not in any"}`);
  }
  return { source, math: found.math };
}

describe("mathAt", () => {
  it("reads an environment, its body and its label", () => {
    const { math } = mathIn(
      [
        "Before.",
        "\\begin{equation}",
        "  E = mc^2¶",
        "  \\label{eq:euler}",
        "\\end{equation}",
      ].join("\n"),
    );

    expect(math).toMatchObject({
      kind: "equation",
      starred: false,
      body: "E = mc^2",
      label: "eq:euler",
    });
  });

  it("knows a starred environment is not numbered", () => {
    const { math } = mathIn("\\begin{align*}\n  a &= b¶\n\\end{align*}");
    expect(math).toMatchObject({ kind: "align", starred: true });
    expect(isNumbered(math)).toBe(false);
  });

  it("reads both display delimiters", () => {
    expect(mathIn("\\[ x + 1¶ \\]").math).toMatchObject({
      kind: "display",
      body: "x + 1",
    });
    expect(mathIn("$$ y - 1¶ $$").math).toMatchObject({
      kind: "display",
      body: "y - 1",
    });
  });

  it("gives the enclosing environment, not the matrix inside it", () => {
    const { math } = mathIn(
      "\\begin{equation}\n\\begin{matrix} a & b¶ \\end{matrix}\n\\end{equation}",
    );
    // The inner one is body, and the body is what the form edits.
    expect(math.kind).toBe("equation");
    expect(math.body).toContain("\\begin{matrix}");
  });

  it("does not answer for inline dollars, or outside maths", () => {
    // Written by the form, never read by it: pairing `$` in a real document
    // means deciding whether one expression's closing dollar opens the next.
    expect(mathAt("Let $x¶$ be", 6)).toBeNull();
    expect(mathAt("Plain text", 4)).toBeNull();
  });

  it("refuses an environment with a comment in it", () => {
    expect(
      mathAt("\\begin{equation}\n  x % later\n\\end{equation}", 20),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("comments") });
  });
});

describe("writeMath", () => {
  it("round-trips an environment", () => {
    const source = [
      "\\begin{equation}",
      "  E = mc^2",
      "  \\label{eq:euler}",
      "\\end{equation}",
    ].join("\n");
    const { math } = mathIn(source.replace("mc^2", "mc^2¶"));
    expect(writeMath(math)).toBe(source);
  });

  it("writes the label only where a number is printed", () => {
    const { math } = mathIn("\\begin{equation}\n  x¶\n\\end{equation}");
    const labelled = { ...math, label: "eq:x" };

    expect(writeMath(labelled)).toContain("\\label{eq:x}");
    // `\label` on an unnumbered environment refers to a number nobody sees.
    expect(writeMath({ ...labelled, starred: true })).not.toContain("\\label");
    expect(writeMath({ ...labelled, kind: "display" })).not.toContain(
      "\\label",
    );
  });

  it("keeps the body exactly as written, matrices and all", () => {
    const { math } = mathIn(
      "\\begin{equation}\n  \\begin{matrix} a & b \\\\ c & d \\end{matrix}¶\n\\end{equation}",
    );
    expect(writeMath({ ...math, starred: true })).toContain(
      "\\begin{matrix} a & b \\\\ c & d \\end{matrix}",
    );
  });

  it("indents a displayed body, and the closing delimiter with it", () => {
    const { math } = mathIn("    \\[ x¶ \\]");
    // The replacement starts at `\[`, so the indentation before it is already
    // in the document; only the lines this writes carry it.
    expect(writeMath(math)).toBe("\\[\n      x\n    \\]");
  });
});

describe("maths the form inserts", () => {
  it("puts displayed maths on its own line, and inline maths in the sentence", () => {
    const sentence = "As shown, ";
    expect(
      writeMath({
        ...newMath(sentence, sentence.length, "equation"),
        body: "x",
      }),
    ).toBe("\n\\begin{equation}\n  x\n\\end{equation}");

    expect(
      writeMath({ ...newMath(sentence, sentence.length, "inline"), body: "x" }),
    ).toBe("$x$");
  });
});

describe("delimiterProblem", () => {
  it("names the first unbalanced delimiter", () => {
    expect(delimiterProblem("\\frac{a}{b}")).toBeNull();
    expect(delimiterProblem("\\frac{a}{b")).toBe("A } is missing");
    expect(delimiterProblem("x)")).toBe("An unmatched )");
  });

  it("ignores delimiters that are escaped or part of a command", () => {
    // `\{` is a brace the reader sees; `\|` is a norm, not a bracket.
    expect(delimiterProblem("\\{ x \\}")).toBeNull();
    expect(delimiterProblem("\\left[ x \\right]")).toBeNull();
  });
});
