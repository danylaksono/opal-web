import { type ProjectPath, projectPath } from "@/core/project/ids";
import {
  isReviewComment,
  REVIEW_DIRECTORY,
  REVIEW_FILE_VERSION,
  type ReviewComment,
  type ReviewFile,
  type ReviewReply,
  reviewFilePath,
  serializeReviewFile,
} from "./model";

/**
 * Review state as the UI holds it, and the changes a person can make to it
 * (ADR-010; PLAN.md "Next, in order" 2).
 *
 * Kept grouped by reviewer file rather than flattened, because the write rule
 * depends on it: a change rewrites only the files whose annotations it touched,
 * so two reviewers never produce a diff in each other's file.
 *
 * The thing this module exists to get right is what it must *not* write.
 * `parseReviewFile` reads a file it does not fully understand as fewer
 * annotations — a newer app's entry is dropped, a wrong version reads as empty —
 * which is the right behaviour for display and the wrong one for a save: writing
 * that back deletes another product's data. So a file is only `writable` when
 * reading it lost nothing, and everything here refuses to change one that is not.
 */

const FILE_KEYS = new Set(["version", "author", "annotations"]);

export interface ReviewFileState {
  path: ProjectPath;
  author: string;
  annotations: ReviewComment[];
  /** False when re-serialising would not reproduce what was read. */
  writable: boolean;
}

/** Whether a project path is one reviewer's file. */
export function isReviewPath(path: string): boolean {
  return (
    path.startsWith(`${REVIEW_DIRECTORY}/`) &&
    path.endsWith(".json") &&
    !path.slice(REVIEW_DIRECTORY.length + 1).includes("/")
  );
}

/**
 * Read one reviewer's file, noting whether the read was lossless.
 *
 * Lossless means: the version is ours, the file's keys are the three this
 * version writes, every annotation passed `isReviewComment`, and the author is a
 * string. Any one failing and the file is shown but never rewritten.
 */
export function readReviewFile(
  path: ProjectPath,
  text: string,
): ReviewFileState {
  const unreadable: ReviewFileState = {
    path,
    author: path,
    annotations: [],
    writable: false,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unreadable;
  }
  if (!parsed || typeof parsed !== "object") return unreadable;
  const file = parsed as Partial<ReviewFile> & Record<string, unknown>;
  if (
    file.version !== REVIEW_FILE_VERSION ||
    !Array.isArray(file.annotations)
  ) {
    return unreadable;
  }
  const annotations = file.annotations.filter(isReviewComment);
  return {
    path,
    author: typeof file.author === "string" ? file.author : path,
    annotations,
    writable:
      typeof file.author === "string" &&
      annotations.length === file.annotations.length &&
      Object.keys(file).every((key) => FILE_KEYS.has(key)),
  };
}

export function serializeReviewState(state: ReviewFileState): string {
  return serializeReviewFile({
    version: REVIEW_FILE_VERSION,
    author: state.author,
    annotations: state.annotations,
  });
}

export type ReviewChange =
  | { kind: "resolve"; id: string; now: string }
  | { kind: "reopen"; id: string; now: string }
  | { kind: "reply"; id: string; reply: ReviewReply; now: string }
  | { kind: "edit"; id: string; body: string; now: string }
  | { kind: "delete"; id: string };

/** A change before it is stamped; `Omit` alone would collapse the union. */
export type ReviewIntent = ReviewChange extends infer C
  ? C extends ReviewChange
    ? Omit<C, "now">
    : never
  : never;

export interface ReviewChangeResult {
  files: ReviewFileState[];
  /** Files whose content changed, and so need writing. Empty for a no-op. */
  changed: ReviewFileState[];
}

function applyToComment(
  comment: ReviewComment,
  change: ReviewChange,
): ReviewComment {
  switch (change.kind) {
    case "resolve":
      return comment.status === "resolved"
        ? comment
        : { ...comment, status: "resolved", updatedAt: change.now };
    case "reopen":
      return comment.status === "open"
        ? comment
        : { ...comment, status: "open", updatedAt: change.now };
    case "reply":
      return {
        ...comment,
        replies: [...comment.replies, change.reply],
        updatedAt: change.now,
      };
    case "edit":
      return comment.body === change.body
        ? comment
        : { ...comment, body: change.body, updatedAt: change.now };
    case "delete":
      return comment;
  }
}

/**
 * Apply one change to whichever file holds the annotation.
 *
 * A change to an annotation in a file that is not `writable` is dropped, not
 * applied in memory: showing a resolved comment that the next reload shows open
 * again would be worse than refusing.
 */
export function applyReviewChange(
  files: readonly ReviewFileState[],
  change: ReviewChange,
): ReviewChangeResult {
  const changed: ReviewFileState[] = [];
  const next = files.map((file) => {
    if (!file.writable) return file;
    const at = file.annotations.findIndex(
      (annotation) => annotation.id === change.id,
    );
    if (at === -1) return file;

    const annotations =
      change.kind === "delete"
        ? file.annotations.filter((_, index) => index !== at)
        : file.annotations.map((annotation, index) =>
            index === at ? applyToComment(annotation, change) : annotation,
          );
    // Reference equality is the no-op test: `applyToComment` hands back the
    // same object when nothing about it would change.
    if (
      annotations.length === file.annotations.length &&
      annotations.every(
        (annotation, index) => annotation === file.annotations[index],
      )
    ) {
      return file;
    }
    const updated = { ...file, annotations };
    changed.push(updated);
    return updated;
  });
  return { files: next, changed };
}

/**
 * Add a comment to its author's own file, creating the file if there is none.
 *
 * Throws rather than writing into a file that is not the author's to extend: one
 * this version cannot read in full (see the module note), or one whose path
 * matches by slug but whose author is someone else — "Dany Laksono" and
 * "dany-laksono" share a file name, and adding to it would put one person's
 * words in the other's file.
 */
export function addReviewComment(
  files: readonly ReviewFileState[],
  comment: ReviewComment,
): ReviewChangeResult {
  const path = projectPath(reviewFilePath(comment.author));
  const existing = files.find((file) => file.path === path);
  if (existing && (!existing.writable || existing.author !== comment.author)) {
    throw new Error(
      `${path} belongs to ${existing.author} or cannot be written safely; use a different reviewer name`,
    );
  }
  const updated: ReviewFileState = existing
    ? { ...existing, annotations: [...existing.annotations, comment] }
    : {
        path,
        author: comment.author,
        annotations: [comment],
        writable: true,
      };
  return {
    files: existing
      ? files.map((file) => (file === existing ? updated : file))
      : [...files, updated],
    changed: [updated],
  };
}

export function openAnnotationCount(files: readonly ReviewFileState[]): number {
  return files.reduce(
    (total, file) =>
      total +
      file.annotations.filter((annotation) => annotation.status === "open")
        .length,
    0,
  );
}
