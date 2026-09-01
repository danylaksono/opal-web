import { describe, expect, it } from "vitest";
import {
  extensionOf,
  InvalidProjectPathError,
  isProjectPath,
  parentPath,
  projectId,
  projectPath,
} from "@/core/project/ids";

describe("projectPath", () => {
  it("normalises separators and redundant segments", () => {
    expect(projectPath("chapters/./intro.tex")).toBe("chapters/intro.tex");
    expect(projectPath("chapters\\intro.tex")).toBe("chapters/intro.tex");
    expect(projectPath("a//b//c.tex")).toBe("a/b/c.tex");
  });

  it("accepts ordinary project files", () => {
    for (const path of [
      "main.tex",
      "references.bib",
      "figures/plot.pdf",
      "styles/custom.sty",
      "review/comments.json",
    ]) {
      expect(projectPath(path)).toBe(path);
    }
  });

  // These are the archive-import cases. A ZIP entry is attacker-controlled and
  // any of these can escape the project root once joined onto a real directory.
  it.each([
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["C:/Windows/system32", "drive letter"],
    ["../outside.tex", "traversal"],
    ["chapters/../../outside.tex", "traversal via subdirectory"],
    ["chapters\\..\\..\\outside.tex", "traversal with backslashes"],
    ["main\0.tex", "NUL byte"],
    ["./", "no usable segments"],
    ["con/main.tex", "Windows reserved device name"],
    ["NUL.tex", "reserved name with extension"],
  ])("rejects %s (%s)", (input) => {
    expect(() => projectPath(input)).toThrow(InvalidProjectPathError);
  });

  it("rejects segments ending in a space or dot", () => {
    expect(() => projectPath("chapters /intro.tex")).toThrow();
    expect(() => projectPath("chapters./intro.tex")).toThrow();
  });

  it("rejects paths longer than the limit", () => {
    expect(() => projectPath(`${"a".repeat(1025)}.tex`)).toThrow(
      InvalidProjectPathError,
    );
  });

  it("reports validity without throwing", () => {
    expect(isProjectPath("main.tex")).toBe(true);
    expect(isProjectPath("../main.tex")).toBe(false);
  });
});

describe("parentPath", () => {
  it("returns null at the project root", () => {
    expect(parentPath(projectPath("main.tex"))).toBeNull();
  });

  it("returns the containing directory", () => {
    expect(parentPath(projectPath("a/b/c.tex"))).toBe("a/b");
  });
});

describe("extensionOf", () => {
  it("lowercases the extension", () => {
    expect(extensionOf(projectPath("Main.TEX"))).toBe("tex");
  });

  it("returns empty for dotfiles and extensionless names", () => {
    expect(extensionOf(projectPath("Makefile"))).toBe("");
    expect(extensionOf(projectPath("dir/.latexmkrc"))).toBe("");
  });
});

describe("projectId", () => {
  it("accepts a uuid", () => {
    expect(projectId("018f3a2b-0000-7000-8000-000000000000")).toBeTruthy();
  });

  it("rejects ids that could appear in a path", () => {
    expect(() => projectId("../other")).toThrow();
    expect(() => projectId("A".repeat(65))).toThrow();
  });
});
