import { describe, expect, it } from "vitest";
import { buildProjectIndex } from "@/core/latex/project-index";
import { projectPath } from "@/core/project/ids";

/**
 * The index against documents nobody wrote to test it.
 *
 * The other unit tests say it is right about cases chosen to exercise it; this
 * says it is right about the fourteen projects in the corpus, which were
 * written to be compiled. Every one of them compiles, so **a problem reported
 * here is a defect in the index, not in the document** — which makes "no
 * problems" the assertion.
 *
 * It has already earned its place twice. Run before these were handled, the
 * corpus reported eighteen undefined citations across `paper-acm`, `paper-ieee`
 * and `thesis-standard` — all three define their keys with `\bibitem` and ship
 * no `.bib` at all — and one undefined reference in `letter-formal`, whose
 * footer refers to `LastPage` from the `lastpage` package. Neither is visible
 * from a test written by the person writing the scanner.
 *
 * A new check that fires on fourteen known-good documents fails this test,
 * which is the point: it is easier to add a plausible diagnostic than a correct
 * one.
 */

/**
 * The corpus, loaded through Vite rather than through `node:fs`.
 *
 * Unit tests here run in the app's TypeScript project, which is typed for a
 * browser and has no filesystem — deliberately, so that domain code cannot
 * quietly acquire a Node dependency. `import.meta.glob` reads the same files at
 * build time and keeps this test on the right side of that line.
 */
const RAW = import.meta.glob("../fixtures/compiler-corpus/*/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** `../fixtures/compiler-corpus/thesis-standard/main.tex` -> the two parts. */
function split(key: string): { project: string; file: string } {
  const parts = key.split("/");
  return {
    project: parts[parts.length - 2] ?? "",
    file: parts[parts.length - 1] ?? "",
  };
}

const sources = Object.entries(RAW)
  .map(([key, content]) => ({ ...split(key), content }))
  .filter((entry) => !entry.file.endsWith(".reference.pdf"));

const projects = [...new Set(sources.map((entry) => entry.project))].sort();

function filesOf(project: string) {
  return sources
    .filter((entry) => entry.project === project)
    .map((entry) => ({
      path: projectPath(entry.file),
      content: entry.content,
    }));
}

describe("the semantic index over the corpus", () => {
  it("finds all fourteen projects", () => {
    expect(projects.length).toBe(14);
  });

  it.each(projects)("reports no problems in %s", (project) => {
    const index = buildProjectIndex(filesOf(project), projectPath("main.tex"));

    expect(
      index.problems.map(
        (problem) => `${problem.file}:${problem.line} ${problem.message}`,
      ),
    ).toEqual([]);
  });

  it("reads an outline out of every project that has sections", () => {
    // `blank` and `letter-formal` genuinely have none; everything else does,
    // and an outline that silently came back empty would look like success.
    const withOutlines = projects.filter(
      (project) =>
        buildProjectIndex(filesOf(project), projectPath("main.tex")).outline
          .length > 0,
    );

    expect(withOutlines).toHaveLength(12);
  });
});
