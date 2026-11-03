import { describe, expect, it } from "vitest";
import { projectPath } from "@/core/project/ids";
import {
  addReviewComment,
  applyReviewChange,
  isReviewPath,
  openAnnotationCount,
  readReviewFile,
  serializeReviewState,
} from "@/core/review/session";

const FIXTURES = import.meta.glob("../fixtures/review/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FIXTURE = Object.entries(FIXTURES).find(([key]) =>
  key.endsWith("dany-laksono.json"),
)?.[1];
if (FIXTURE === undefined) throw new Error("fixture dany-laksono.json missing");

const PATH = projectPath("review/dany-laksono.json");
const NOW = "2026-11-03T09:00:00.000Z";

describe("readReviewFile", () => {
  it("reads the desktop fixture as writable, and re-serialises it to the same bytes", () => {
    const state = readReviewFile(PATH, FIXTURE);
    expect(state.writable).toBe(true);
    expect(state.author).toBe("Dany Laksono");
    expect(state.annotations).toHaveLength(3);
    expect(serializeReviewState(state)).toBe(FIXTURE);
  });

  it("refuses to write a file whose annotation this version cannot represent", () => {
    const file = JSON.parse(FIXTURE);
    file.annotations.push({ id: "from-the-future", kind: "sticker" });
    const state = readReviewFile(PATH, JSON.stringify(file));
    // Shown without the entry it cannot read, but never rewritten without it.
    expect(state.annotations).toHaveLength(3);
    expect(state.writable).toBe(false);
  });

  it("refuses a file from another version, one with extra keys, and one that is not JSON", () => {
    const file = JSON.parse(FIXTURE);
    expect(
      readReviewFile(PATH, JSON.stringify({ ...file, version: 3 })).writable,
    ).toBe(false);
    expect(
      readReviewFile(PATH, JSON.stringify({ ...file, reviewedAt: "x" }))
        .writable,
    ).toBe(false);
    expect(readReviewFile(PATH, "not json").writable).toBe(false);
  });
});

describe("applyReviewChange", () => {
  const state = readReviewFile(PATH, FIXTURE);
  const first = state.annotations[0];
  const open = state.annotations.find((a) => a.status === "open");
  if (!first || !open) throw new Error("fixture lost its annotations");

  it("queues nothing for a change that changes nothing", () => {
    const result = applyReviewChange([state], {
      kind: "reopen",
      id: open.id,
      now: NOW,
    });
    expect(result.changed).toEqual([]);
    expect(result.files[0]).toBe(state);
  });

  it("rewrites only the file whose annotation changed", () => {
    const other = readReviewFile(
      projectPath("review/someone-else.json"),
      JSON.stringify({ version: 2, author: "Someone Else", annotations: [] }),
    );
    const result = applyReviewChange([other, state], {
      kind: "resolve",
      id: open.id,
      now: NOW,
    });
    expect(result.changed.map((file) => file.path)).toEqual([PATH]);
    expect(result.files[0]).toBe(other);
    const [rewritten] = result.changed;
    if (!rewritten) throw new Error("nothing was rewritten");
    const resolved = rewritten.annotations.find((a) => a.id === open.id);
    expect(resolved).toMatchObject({ status: "resolved", updatedAt: NOW });
    // Everything else in the file is exactly what it was.
    const reread = readReviewFile(PATH, serializeReviewState(rewritten));
    expect(reread.annotations.filter((a) => a.id !== open.id)).toEqual(
      state.annotations.filter((a) => a.id !== open.id),
    );
  });

  it("replies, edits and deletes", () => {
    const reply = { id: "r1", author: "Me", body: "Done", createdAt: NOW };
    const replied = applyReviewChange([state], {
      kind: "reply",
      id: first.id,
      reply,
      now: NOW,
    });
    expect(replied.changed[0]?.annotations[0]?.replies.at(-1)).toEqual(reply);

    const edited = applyReviewChange([state], {
      kind: "edit",
      id: first.id,
      body: "Rewritten",
      now: NOW,
    });
    expect(edited.changed[0]?.annotations[0]?.body).toBe("Rewritten");

    const deleted = applyReviewChange([state], {
      kind: "delete",
      id: first.id,
    });
    expect(deleted.changed[0]?.annotations).toHaveLength(2);
  });

  it("drops a change aimed at a file it must not write", () => {
    const file = JSON.parse(FIXTURE);
    file.annotations.push({ id: "from-the-future", kind: "sticker" });
    const readOnly = readReviewFile(PATH, JSON.stringify(file));
    const result = applyReviewChange([readOnly], {
      kind: "delete",
      id: first.id,
    });
    expect(result.changed).toEqual([]);
    expect(result.files[0]).toBe(readOnly);
  });
});

describe("helpers", () => {
  it("recognises only a reviewer's own file", () => {
    expect(isReviewPath("review/dany-laksono.json")).toBe(true);
    expect(isReviewPath("review/nested/x.json")).toBe(false);
    expect(isReviewPath("review/notes.txt")).toBe(false);
    expect(isReviewPath("main.json")).toBe(false);
  });

  it("counts open annotations across files", () => {
    const state = readReviewFile(PATH, FIXTURE);
    expect(openAnnotationCount([state, state])).toBe(
      2 * state.annotations.filter((a) => a.status === "open").length,
    );
  });
});

describe("addReviewComment", () => {
  const state = readReviewFile(PATH, FIXTURE);
  const [template] = state.annotations;
  if (!template) throw new Error("fixture lost its annotations");
  const comment = (author: string) => ({
    ...template,
    id: `new-${author}`,
    author,
    replies: [],
  });

  it("creates a reviewer's file the first time they comment", () => {
    const result = addReviewComment([state], comment("New Person"));
    expect(result.changed.map((file) => file.path)).toEqual([
      "review/new-person.json",
    ]);
    expect(result.files).toHaveLength(2);
    expect(result.changed[0]?.writable).toBe(true);
  });

  it("appends to the author's own file and leaves the others alone", () => {
    const result = addReviewComment([state], comment("Dany Laksono"));
    expect(result.files).toHaveLength(1);
    expect(result.changed[0]?.annotations).toHaveLength(4);
  });

  it("refuses a file that merely shares the slug", () => {
    expect(() => addReviewComment([state], comment("dany-laksono"))).toThrow(
      /belongs to Dany Laksono/,
    );
  });

  it("refuses a file it cannot write safely", () => {
    const file = JSON.parse(FIXTURE);
    file.annotations.push({ id: "from-the-future", kind: "sticker" });
    const readOnly = readReviewFile(PATH, JSON.stringify(file));
    expect(() =>
      addReviewComment([readOnly], comment("Dany Laksono")),
    ).toThrow();
  });
});
