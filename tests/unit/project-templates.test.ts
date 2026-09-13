import { describe, expect, it } from "vitest";
import { buildProjectIndex } from "@/core/latex/project-index";
import { PROJECT_TEMPLATES, templateById } from "@/core/project/templates";

/**
 * A template is the first LaTeX a user sees, so it is also the first LaTeX they
 * copy.
 *
 * The semantic index already knows what a broken project looks like — a `\ref`
 * with no `\label`, a `\cite` with no entry, an `\input` naming a file that is
 * not there — so running it over the templates costs nothing and stops us
 * shipping the mistakes we built a checker to catch. This is the same
 * assertion, and the same argument, as the corpus test beside it.
 */

const decoder = new TextDecoder();

describe("project templates", () => {
  it.each(PROJECT_TEMPLATES.map((template) => template.id))(
    "%s has no problems the index can see",
    (id) => {
      const template = templateById(id);
      const index = buildProjectIndex(
        template.files.map((file) => ({
          path: file.path,
          content: decoder.decode(file.bytes),
        })),
        template.rootTexPath,
      );

      expect(
        index.problems.map(
          (problem) => `${problem.file}:${problem.line} ${problem.message}`,
        ),
      ).toEqual([]);
    },
  );

  it("points every template at a file it actually ships", () => {
    // A root path with no file behind it produces a project that cannot
    // compile and a compile button aimed at nothing.
    for (const template of PROJECT_TEMPLATES) {
      expect(template.files.map((file) => file.path)).toContain(
        template.rootTexPath,
      );
    }
  });

  it("refuses an id it does not have rather than inventing a project", () => {
    expect(() => templateById("nonexistent")).toThrow();
  });

  it("shows the cross-file structure it claims to teach", () => {
    // The report is the only template whose point is the file split, so this
    // is the one whose outline has to come from more than one file.
    const report = templateById("report");
    const index = buildProjectIndex(
      report.files.map((file) => ({
        path: file.path,
        content: decoder.decode(file.bytes),
      })),
      report.rootTexPath,
    );

    expect(new Set(index.outline.map((entry) => entry.file)).size).toBe(2);
  });
});
