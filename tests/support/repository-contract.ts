/**
 * What every `ProjectRepository` must do, regardless of where it stores things.
 *
 * Written once and run against each implementation. The in-memory repository
 * and the OPFS one differ in everything except behaviour, and behaviour is
 * exactly what a caller depends on — so a rule proved for one and merely
 * assumed for the other is a rule that will diverge the first time storage gets
 * interesting.
 *
 * The cases carry their own assertions and import no test framework, because
 * they run in two places: under vitest against the in-memory repository, and
 * inside a real browser against OPFS and IndexedDB, where vitest does not
 * exist. Keeping this module framework-free is what lets the browser page load
 * it; the vitest wiring lives in the test that uses it.
 */

import { projectPath } from "@/core/project/ids";
import {
  FileNotFoundError,
  ProjectConflictError,
  ProjectNotFoundError,
  type ProjectRepository,
} from "@/core/project/repository";

const main = projectPath("main.tex");
const chapter = projectPath("chapters/one.tex");

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

export class ContractFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractFailure";
  }
}

function ok(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ContractFailure(message);
}

function equal(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new ContractFailure(`${what}: expected ${b}, got ${a}`);
}

/** Run `work` and return the error it threw, failing if it threw none. */
async function throws(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new ContractFailure("expected this to throw, and it did not");
}

export interface RepositoryCase {
  name: string;
  run: (repository: ProjectRepository) => Promise<void>;
}

/**
 * Every rule the port promises.
 *
 * Each case is handed a repository holding no projects and creates whatever it
 * needs.
 */
export const repositoryContract: RepositoryCase[] = [
  {
    name: "creates a project with its initial files",
    run: async (repository) => {
      const project = await repository.create({
        title: "Thesis",
        files: [{ path: main, bytes: bytes("\\documentclass{article}") }],
      });
      equal(project.title, "Thesis", "title");
      equal(project.fileCount, 1, "fileCount");
      equal(await repository.listFiles(project.id), [main], "listFiles");
      equal(
        text(await repository.readFile(project.id, main)),
        "\\documentclass{article}",
        "content",
      );
    },
  },
  {
    name: "gives each project a distinct id",
    run: async (repository) => {
      const first = await repository.create({ title: "One" });
      const second = await repository.create({ title: "One" });
      ok(first.id !== second.id, "two projects share an id");
    },
  },
  {
    name: "raises rather than inventing a project that is not there",
    run: async (repository) => {
      const project = await repository.create({ title: "Gone" });
      await repository.delete(project.id);
      const error = await throws(() => repository.get(project.id));
      ok(
        error instanceof ProjectNotFoundError,
        `expected ProjectNotFoundError, got ${String(error)}`,
      );
    },
  },
  {
    name: "treats deleting a project as idempotent",
    run: async (repository) => {
      // A retried delete, or two tabs closing the same project, must not turn
      // into an error the UI has to explain.
      const project = await repository.create({ title: "Gone" });
      await repository.delete(project.id);
      await repository.delete(project.id);
    },
  },
  {
    name: "raises for a file the project does not have",
    run: async (repository) => {
      const project = await repository.create({ title: "Empty" });
      const error = await throws(() => repository.readFile(project.id, main));
      ok(
        error instanceof FileNotFoundError,
        `expected FileNotFoundError, got ${String(error)}`,
      );
    },
  },
  {
    name: "advances the revision on every write",
    run: async (repository) => {
      const project = await repository.create({ title: "Draft" });
      const first = await repository.writeFile(project.id, main, bytes("a"));
      const second = await repository.writeFile(project.id, main, bytes("b"));
      ok(first > project.revision, "first write did not advance the revision");
      ok(second > first, "second write did not advance the revision");
    },
  },
  {
    name: "counts a multi-file write as one revision",
    run: async (repository) => {
      // Import and autosave both touch many files, and publishing a revision
      // per file would announce states the project was never really in.
      const project = await repository.create({ title: "Import" });
      const revision = await repository.writeFiles(project.id, [
        { path: main, bytes: bytes("a") },
        { path: chapter, bytes: bytes("b") },
      ]);
      equal(revision, project.revision + 1, "revision after a batch");
      equal((await repository.listFiles(project.id)).length, 2, "file count");
    },
  },
  {
    name: "accepts a conditional write at the revision it expects",
    run: async (repository) => {
      const project = await repository.create({ title: "Draft" });
      const revision = await repository.writeFile(
        project.id,
        main,
        bytes("a"),
        project.revision,
      );
      ok(revision > project.revision, "conditional write did not advance");
    },
  },
  {
    name: "refuses a conditional write whose project moved on",
    run: async (repository) => {
      // The Phase 1 exit criterion: two tabs cannot silently overwrite each
      // other. The second write fails loudly instead of winning.
      const project = await repository.create({ title: "Shared" });
      const stale = project.revision;
      await repository.writeFile(project.id, main, bytes("from tab one"));

      const error = await throws(() =>
        repository.writeFile(project.id, main, bytes("from tab two"), stale),
      );
      ok(
        error instanceof ProjectConflictError,
        `expected ProjectConflictError, got ${String(error)}`,
      );
      equal(
        text(await repository.readFile(project.id, main)),
        "from tab one",
        "the first writer's content",
      );
    },
  },
  {
    name: "reports both revisions on a conflict",
    run: async (repository) => {
      const project = await repository.create({ title: "Shared" });
      const stale = project.revision;
      const current = await repository.writeFile(project.id, main, bytes("a"));

      const error = (await throws(() =>
        repository.writeFile(project.id, main, bytes("b"), stale),
      )) as ProjectConflictError;
      equal(error.expectedRevision, stale, "expectedRevision");
      equal(error.actualRevision, current, "actualRevision");
    },
  },
  {
    name: "lets an unconditional write through, which is last-writer-wins",
    run: async (repository) => {
      const project = await repository.create({ title: "Shared" });
      await repository.writeFile(project.id, main, bytes("first"));
      await repository.writeFile(project.id, main, bytes("second"));
      equal(
        text(await repository.readFile(project.id, main)),
        "second",
        "content",
      );
    },
  },
  {
    name: "deletes a file and takes a revision with it",
    run: async (repository) => {
      const project = await repository.create({
        title: "Draft",
        files: [{ path: main, bytes: bytes("a") }],
      });
      const revision = await repository.deleteFile(project.id, main);
      ok(revision > project.revision, "delete did not advance the revision");
      equal(await repository.listFiles(project.id), [], "remaining files");
    },
  },
  {
    name: "keeps file counts and byte totals in step with the files",
    run: async (repository) => {
      // The picker shows these without opening a project, so they are part of
      // the record rather than something a caller recomputes.
      const project = await repository.create({ title: "Draft" });
      await repository.writeFiles(project.id, [
        { path: main, bytes: bytes("12345") },
        { path: chapter, bytes: bytes("123") },
      ]);
      const stored = await repository.get(project.id);
      equal(stored.fileCount, 2, "fileCount");
      equal(stored.byteSize, 8, "byteSize");
    },
  },
  {
    name: "does not let a caller mutate stored bytes through what it read",
    run: async (repository) => {
      const project = await repository.create({
        title: "Draft",
        files: [{ path: main, bytes: bytes("original") }],
      });
      const read = await repository.readFile(project.id, main);
      read.fill(0);
      equal(
        text(await repository.readFile(project.id, main)),
        "original",
        "content after mutating what was read",
      );
    },
  },
  {
    name: "lists projects most recently opened first",
    run: async (repository) => {
      const older = await repository.create({ title: "Older" });
      const newer = await repository.create({ title: "Newer" });
      equal(
        (await repository.list()).map((project) => project.id),
        [newer.id, older.id],
        "order by creation",
      );

      // Opening the older one moves it to the front, which is what makes the
      // picker's order a record of use rather than of creation.
      await repository.open(older.id);
      equal(
        (await repository.list()).map((project) => project.id),
        [older.id, newer.id],
        "order after opening the older one",
      );
    },
  },
  {
    name: "does not change the revision when a project is opened",
    run: async (repository) => {
      // Opening reorders the picker; it is not an edit, and must not
      // invalidate a conditional write held by another tab.
      const project = await repository.create({ title: "Draft" });
      const opened = await repository.open(project.id);
      equal(opened.revision, project.revision, "revision after open");
    },
  },
  {
    name: "renames without disturbing the files",
    run: async (repository) => {
      const project = await repository.create({
        title: "Untitled",
        files: [{ path: main, bytes: bytes("a") }],
      });
      const renamed = await repository.rename(project.id, "Thesis");
      equal(renamed.title, "Thesis", "title");
      equal(text(await repository.readFile(project.id, main)), "a", "content");
    },
  },
];
