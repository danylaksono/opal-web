import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave, type SaveStatus } from "@/core/project/autosave";
import { projectPath } from "@/core/project/ids";
import type { ProjectRepository } from "@/core/project/repository";
import { MemoryProjectRepository } from "@/platform/memory/project-repository";

const main = projectPath("main.tex");
const other = projectPath("notes.tex");

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

async function project(repository: ProjectRepository) {
  return repository.create({
    title: "Draft",
    files: [{ path: main, bytes: bytes("initial") }],
  });
}

/**
 * A repository with some methods replaced.
 *
 * Spreading the instance would not work: its methods live on the prototype and
 * its state in private fields, so `{ ...repository }` is an empty object that
 * type-checks as nothing useful.
 */
function withOverrides(
  base: ProjectRepository,
  overrides: Partial<ProjectRepository>,
): ProjectRepository {
  return {
    list: () => base.list(),
    create: (input) => base.create(input),
    get: (id) => base.get(id),
    open: (id) => base.open(id),
    delete: (id) => base.delete(id),
    rename: (id, title) => base.rename(id, title),
    listFiles: (id) => base.listFiles(id),
    readFile: (id, path) => base.readFile(id, path),
    writeFile: (id, path, content, revision) =>
      base.writeFile(id, path, content, revision),
    writeFiles: (id, files, revision) => base.writeFiles(id, files, revision),
    deleteFile: (id, path, revision) => base.deleteFile(id, path, revision),
    ...overrides,
  };
}

describe("createAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a pause before writing", async () => {
    const repository = new MemoryProjectRepository();
    const created = await project(repository);
    const autosave = createAutosave({
      repository,
      projectId: created.id,
      revision: created.revision,
      debounceMs: 100,
    });

    autosave.queue(main, bytes("typed"));
    expect(autosave.status().state).toBe("pending");
    // Nothing written yet: the user is still typing.
    expect(text(await repository.readFile(created.id, main))).toBe("initial");

    await vi.advanceTimersByTimeAsync(150);
    expect(text(await repository.readFile(created.id, main))).toBe("typed");
    expect(autosave.status().state).toBe("saved");
  });

  it("collapses a burst of edits into one revision", async () => {
    // The reason for the debounce: a revision per keystroke would make the
    // number meaningless and the history unreadable.
    const repository = new MemoryProjectRepository();
    const created = await project(repository);
    const autosave = createAutosave({
      repository,
      projectId: created.id,
      revision: created.revision,
      debounceMs: 100,
    });

    for (const value of ["a", "ab", "abc"]) {
      autosave.queue(main, bytes(value));
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(150);

    expect(text(await repository.readFile(created.id, main))).toBe("abc");
    expect((await repository.get(created.id)).revision).toBe(
      created.revision + 1,
    );
  });

  it("writes several files as one revision", async () => {
    const repository = new MemoryProjectRepository();
    const created = await project(repository);
    const autosave = createAutosave({
      repository,
      projectId: created.id,
      revision: created.revision,
      debounceMs: 100,
    });

    autosave.queue(main, bytes("one"));
    autosave.queue(other, bytes("two"));
    await vi.advanceTimersByTimeAsync(150);

    expect((await repository.get(created.id)).revision).toBe(
      created.revision + 1,
    );
    expect(text(await repository.readFile(created.id, other))).toBe("two");
  });

  it("flush writes immediately, for a tab that is closing", async () => {
    const repository = new MemoryProjectRepository();
    const created = await project(repository);
    const autosave = createAutosave({
      repository,
      projectId: created.id,
      revision: created.revision,
      debounceMs: 10_000,
    });

    autosave.queue(main, bytes("unsaved"));
    await autosave.flush();

    expect(text(await repository.readFile(created.id, main))).toBe("unsaved");
  });

  it("flush on an empty queue does nothing and does not fail", async () => {
    const repository = new MemoryProjectRepository();
    const created = await project(repository);
    const autosave = createAutosave({
      repository,
      projectId: created.id,
      revision: created.revision,
    });

    await expect(autosave.flush()).resolves.toBeUndefined();
    expect((await repository.get(created.id)).revision).toBe(created.revision);
  });

  it("keeps edits that arrive while a write is in flight", async () => {
    // A fast typist must not be able to outrun the scheduler and lose the
    // characters typed during the write.
    let release: (() => void) | undefined;
    const repository = new MemoryProjectRepository();
    const created = await project(repository);
    // Only the first write is held. Blocking every one would deadlock the
    // drain loop, which is a bug in the test rather than in the scheduler.
    let held = false;
    const slow = withOverrides(repository, {
      writeFiles: async (id, files, expected) => {
        if (!held) {
          held = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return repository.writeFiles(id, files, expected);
      },
    });

    const autosave = createAutosave({
      repository: slow,
      projectId: created.id,
      revision: created.revision,
      debounceMs: 10,
    });

    autosave.queue(main, bytes("first"));
    await vi.advanceTimersByTimeAsync(20);
    autosave.queue(main, bytes("second"));

    release?.();
    await autosave.flush();

    expect(text(await repository.readFile(created.id, main))).toBe("second");
  });

  it("reports a conflict rather than overwriting another tab", async () => {
    const repository = new MemoryProjectRepository();
    const created = await project(repository);
    const seen: SaveStatus[] = [];
    const autosave = createAutosave({
      repository,
      projectId: created.id,
      revision: created.revision,
      debounceMs: 10,
      onStatus: (status) => seen.push(status),
    });

    // Another tab writes first, so this session's revision is stale.
    await repository.writeFile(created.id, main, bytes("from the other tab"));

    autosave.queue(main, bytes("from this tab"));
    await vi.advanceTimersByTimeAsync(50);

    expect(autosave.status().state).toBe("conflict");
    expect(autosave.status().actualRevision).toBe(created.revision + 1);
    expect(text(await repository.readFile(created.id, main))).toBe(
      "from the other tab",
    );
    expect(seen.map((status) => status.state)).toContain("conflict");
  });

  it("stops autosaving after a conflict rather than retrying", async () => {
    // Retrying would resolve the conflict by discarding the other tab's work,
    // which is the outcome the check exists to prevent.
    const repository = new MemoryProjectRepository();
    const created = await project(repository);
    const autosave = createAutosave({
      repository,
      projectId: created.id,
      revision: created.revision,
      debounceMs: 10,
    });

    await repository.writeFile(created.id, main, bytes("theirs"));
    autosave.queue(main, bytes("mine"));
    await vi.advanceTimersByTimeAsync(50);

    autosave.queue(main, bytes("mine again"));
    await vi.advanceTimersByTimeAsync(200);
    await autosave.flush();

    expect(text(await repository.readFile(created.id, main))).toBe("theirs");
  });

  it("keeps the edit when a write fails, so a retry still has it", async () => {
    const repository = new MemoryProjectRepository();
    const created = await project(repository);
    let failNext = true;
    const flaky = withOverrides(repository, {
      writeFiles: async (id, files, expected) => {
        if (failNext) {
          failNext = false;
          throw new Error("disk is having a moment");
        }
        return repository.writeFiles(id, files, expected);
      },
    });

    const autosave = createAutosave({
      repository: flaky,
      projectId: created.id,
      revision: created.revision,
      debounceMs: 10,
    });

    autosave.queue(main, bytes("important"));
    await vi.advanceTimersByTimeAsync(50);
    expect(autosave.status().state).toBe("failed");

    // The retry finds the edit still queued rather than having to be retyped.
    await autosave.flush();
    expect(text(await repository.readFile(created.id, main))).toBe("important");
  });

  it("prefers a newer edit over a re-queued failed one", async () => {
    const repository = new MemoryProjectRepository();
    const created = await project(repository);
    let failNext = true;
    const flaky = withOverrides(repository, {
      writeFiles: async (id, files, expected) => {
        if (failNext) {
          failNext = false;
          throw new Error("nope");
        }
        return repository.writeFiles(id, files, expected);
      },
    });

    const autosave = createAutosave({
      repository: flaky,
      projectId: created.id,
      revision: created.revision,
      debounceMs: 10,
    });

    autosave.queue(main, bytes("old"));
    await vi.advanceTimersByTimeAsync(50);
    autosave.queue(main, bytes("new"));
    await autosave.flush();

    expect(text(await repository.readFile(created.id, main))).toBe("new");
  });

  it("stop() prevents further scheduling but keeps what was queued", async () => {
    const repository = new MemoryProjectRepository();
    const created = await project(repository);
    const autosave = createAutosave({
      repository,
      projectId: created.id,
      revision: created.revision,
      debounceMs: 10,
    });

    autosave.queue(main, bytes("queued"));
    autosave.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(text(await repository.readFile(created.id, main))).toBe("initial");
  });
});
