/**
 * What every `ProjectRepository` must do, regardless of where it stores things.
 *
 * Written once and run against each implementation. The in-memory repository
 * and the OPFS one differ in everything except behaviour, and behaviour is
 * exactly what a caller depends on — so a rule proved for one and merely
 * assumed for the other is a rule that will diverge the first time storage gets
 * interesting.
 *
 * Pass a factory that returns a repository with no projects in it.
 */

import { describe, expect, it } from "vitest";
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

export function describeProjectRepository(
  name: string,
  create: () => Promise<ProjectRepository> | ProjectRepository,
): void {
  describe(`${name} (ProjectRepository contract)`, () => {
    it("creates a project with its initial files", async () => {
      const repository = await create();
      const project = await repository.create({
        title: "Thesis",
        files: [{ path: main, bytes: bytes("\\documentclass{article}") }],
      });

      expect(project.title).toBe("Thesis");
      expect(project.fileCount).toBe(1);
      expect(await repository.listFiles(project.id)).toEqual([main]);
      expect(text(await repository.readFile(project.id, main))).toBe(
        "\\documentclass{article}",
      );
    });

    it("gives each project a distinct id", async () => {
      const repository = await create();
      const first = await repository.create({ title: "One" });
      const second = await repository.create({ title: "One" });
      expect(first.id).not.toBe(second.id);
    });

    it("raises rather than inventing a project that is not there", async () => {
      const repository = await create();
      const project = await repository.create({ title: "Gone" });
      await repository.delete(project.id);
      await expect(repository.get(project.id)).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
    });

    it("treats deleting a project as idempotent", async () => {
      // A retried delete, or two tabs closing the same project, must not turn
      // into an error the UI has to explain.
      const repository = await create();
      const project = await repository.create({ title: "Gone" });
      await repository.delete(project.id);
      await expect(repository.delete(project.id)).resolves.toBeUndefined();
    });

    it("raises for a file the project does not have", async () => {
      const repository = await create();
      const project = await repository.create({ title: "Empty" });
      await expect(
        repository.readFile(project.id, main),
      ).rejects.toBeInstanceOf(FileNotFoundError);
    });

    it("advances the revision on every write", async () => {
      const repository = await create();
      const project = await repository.create({ title: "Draft" });
      const first = await repository.writeFile(project.id, main, bytes("a"));
      const second = await repository.writeFile(project.id, main, bytes("b"));

      expect(first).toBeGreaterThan(project.revision);
      expect(second).toBeGreaterThan(first);
    });

    it("counts a multi-file write as one revision", async () => {
      // Import and autosave both touch many files, and publishing a revision
      // per file would announce states the project was never really in.
      const repository = await create();
      const project = await repository.create({ title: "Import" });
      const revision = await repository.writeFiles(project.id, [
        { path: main, bytes: bytes("a") },
        { path: chapter, bytes: bytes("b") },
      ]);

      expect(revision).toBe(project.revision + 1);
      expect((await repository.listFiles(project.id)).length).toBe(2);
    });

    it("accepts a conditional write at the revision it expects", async () => {
      const repository = await create();
      const project = await repository.create({ title: "Draft" });
      await expect(
        repository.writeFile(project.id, main, bytes("a"), project.revision),
      ).resolves.toBeGreaterThan(project.revision);
    });

    it("refuses a conditional write whose project moved on", async () => {
      // The Phase 1 exit criterion: two tabs cannot silently overwrite each
      // other. The second write fails loudly instead of winning.
      const repository = await create();
      const project = await repository.create({ title: "Shared" });
      const stale = project.revision;
      await repository.writeFile(project.id, main, bytes("from tab one"));

      await expect(
        repository.writeFile(project.id, main, bytes("from tab two"), stale),
      ).rejects.toBeInstanceOf(ProjectConflictError);
      expect(text(await repository.readFile(project.id, main))).toBe(
        "from tab one",
      );
    });

    it("reports both revisions on a conflict", async () => {
      const repository = await create();
      const project = await repository.create({ title: "Shared" });
      const stale = project.revision;
      const current = await repository.writeFile(project.id, main, bytes("a"));

      await expect(
        repository.writeFile(project.id, main, bytes("b"), stale),
      ).rejects.toMatchObject({
        expectedRevision: stale,
        actualRevision: current,
      });
    });

    it("lets an unconditional write through, which is last-writer-wins", async () => {
      const repository = await create();
      const project = await repository.create({ title: "Shared" });
      await repository.writeFile(project.id, main, bytes("first"));
      await repository.writeFile(project.id, main, bytes("second"));
      expect(text(await repository.readFile(project.id, main))).toBe("second");
    });

    it("deletes a file and takes a revision with it", async () => {
      const repository = await create();
      const project = await repository.create({
        title: "Draft",
        files: [{ path: main, bytes: bytes("a") }],
      });
      const revision = await repository.deleteFile(project.id, main);

      expect(revision).toBeGreaterThan(project.revision);
      expect(await repository.listFiles(project.id)).toEqual([]);
    });

    it("keeps file counts and byte totals in step with the files", async () => {
      // The picker shows these without opening a project, so they are part of
      // the record rather than something a caller recomputes.
      const repository = await create();
      const project = await repository.create({ title: "Draft" });
      await repository.writeFiles(project.id, [
        { path: main, bytes: bytes("12345") },
        { path: chapter, bytes: bytes("123") },
      ]);

      const stored = await repository.get(project.id);
      expect(stored.fileCount).toBe(2);
      expect(stored.byteSize).toBe(8);
    });

    it("does not let a caller mutate stored bytes through what it read", async () => {
      const repository = await create();
      const project = await repository.create({
        title: "Draft",
        files: [{ path: main, bytes: bytes("original") }],
      });
      const read = await repository.readFile(project.id, main);
      read.fill(0);

      expect(text(await repository.readFile(project.id, main))).toBe(
        "original",
      );
    });

    it("lists projects most recently opened first", async () => {
      const repository = await create();
      const older = await repository.create({ title: "Older" });
      const newer = await repository.create({ title: "Newer" });

      expect((await repository.list()).map((p) => p.id)).toEqual([
        newer.id,
        older.id,
      ]);

      // Opening the older one moves it to the front, which is what makes the
      // picker's order a record of use rather than of creation.
      await repository.open(older.id);
      expect((await repository.list()).map((p) => p.id)).toEqual([
        older.id,
        newer.id,
      ]);
    });

    it("does not change the revision when a project is opened", async () => {
      // Opening reorders the picker; it is not an edit, and must not invalidate
      // a conditional write held by another tab.
      const repository = await create();
      const project = await repository.create({ title: "Draft" });
      const opened = await repository.open(project.id);
      expect(opened.revision).toBe(project.revision);
    });

    it("renames without disturbing the files", async () => {
      const repository = await create();
      const project = await repository.create({
        title: "Untitled",
        files: [{ path: main, bytes: bytes("a") }],
      });
      const renamed = await repository.rename(project.id, "Thesis");

      expect(renamed.title).toBe("Thesis");
      expect(text(await repository.readFile(project.id, main))).toBe("a");
    });
  });
}
