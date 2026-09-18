/**
 * Review annotations, as a file (investigation.md 14; PLAN.md "Next, in
 * order" 2; ADR-010).
 *
 * Ported from the desktop editor's `review-store.ts` (opal-editor@8f95519,
 * `apps/desktop/src/stores/review-store.ts`) rather than designed fresh,
 * because the point of this port is that a project's `review/` folder means
 * the same thing on both products. Everything here is the file shape and the
 * pure read/write of it; the store that holds live state, persists through
 * `ProjectRepository`, and resolves a reviewer's name is application code, not
 * a port.
 *
 * One reviewer, one file: `review/<slug>.json`. Two people's annotations never
 * touch the same file, so two reviewers working on the same project round-trip
 * without a merge — each only ever rewrites the file for authors whose
 * annotations they changed. Desktop calls this out and it is worth repeating:
 * the folder shape is doing real work, not just organising by author.
 *
 * Desktop's v1 file — a single hidden `.tectonic-editor/review-comments.json`
 * predating the per-author folder — is not ported. Opal Web has never written
 * that shape, so there is nothing here to migrate from.
 */

export const REVIEW_FILE_VERSION = 2;
export const REVIEW_DIRECTORY = "review";

export interface ReviewSourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface ReviewAnchor {
  kind: "text" | "point";
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  selectedText?: string;
  source?: ReviewSourceLocation;
}

export interface ReviewReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export type ReviewAnnotationKind = "comment" | "highlight" | "drawing";

export type ReviewDrawingTool =
  | "freehand"
  | "line"
  | "arrow"
  | "box"
  | "ellipse";

export interface ReviewPoint {
  x: number;
  y: number;
}

/** A mark drawn over the page: a scribble, or a shape swept out in one drag.
 *  Points are page-relative PDF coordinates, the same space as `anchor`. */
export interface ReviewDrawing {
  tool: ReviewDrawingTool;
  points: ReviewPoint[];
  /** PDF points. Absent means the default width. */
  strokeWidth?: number;
}

/** How one annotation's anchor fared against a freshly compiled PDF.
 *
 *  "ok" — its text is still under it; "shifted" — its text turned up
 *  elsewhere, so the annotation now points at the wrong place and we know
 *  where the text went; "drifted" — its text is gone, so the position is
 *  suspect and we cannot say where it should be; "unverified" — there was
 *  nothing to search by, which is not evidence either way.
 *
 *  None of these move the annotation: see `reanchor.ts`. */
export type ReviewAnchorStatus = "ok" | "shifted" | "drifted" | "unverified";

/** Where an annotation's text was found, in unscaled PDF page coordinates. */
export interface ReviewFoundLocation {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReviewAnchorUpdate {
  id: string;
  status: ReviewAnchorStatus;
  /** Set only for "shifted": where the text is now. */
  foundAt?: ReviewFoundLocation;
}

export interface ReviewComment {
  id: string;
  kind: ReviewAnnotationKind;
  documentRoot: string;
  author: string;
  body: string;
  status: "open" | "resolved";
  anchor: ReviewAnchor;
  /** Highlight colour token; absent for comments and for highlights saved
   *  before colours existed. */
  color?: string;
  /** Free-form labels, normalised (see `tags.ts`). Absent, not empty, when
   *  untagged — an emitted `"tags": []` is a diff against a desktop file that
   *  never wrote one. */
  tags?: string[];
  /** Set only when `kind` is "drawing". */
  drawing?: ReviewDrawing;
  replies: ReviewReply[];
  createdAt: string;
  updatedAt: string;
}

/** One reviewer's file inside the project's `review/` folder. */
export interface ReviewFile {
  version: number;
  author: string;
  annotations: ReviewComment[];
}

function isReviewSourceLocation(value: unknown): value is ReviewSourceLocation {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<ReviewSourceLocation>;
  return (
    typeof source.file === "string" &&
    typeof source.line === "number" &&
    typeof source.column === "number"
  );
}

function isReviewAnchor(value: unknown): value is ReviewAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as Partial<ReviewAnchor>;
  return (
    (anchor.kind === "text" || anchor.kind === "point") &&
    typeof anchor.page === "number" &&
    typeof anchor.x === "number" &&
    typeof anchor.y === "number" &&
    typeof anchor.width === "number" &&
    typeof anchor.height === "number" &&
    (anchor.source === undefined || isReviewSourceLocation(anchor.source))
  );
}

function isReviewReply(value: unknown): value is ReviewReply {
  if (!value || typeof value !== "object") return false;
  const reply = value as Partial<ReviewReply>;
  return (
    typeof reply.id === "string" &&
    typeof reply.author === "string" &&
    typeof reply.body === "string" &&
    typeof reply.createdAt === "string"
  );
}

const DRAWING_TOOLS: ReviewDrawingTool[] = [
  "freehand",
  "line",
  "arrow",
  "box",
  "ellipse",
];

function isReviewPoint(value: unknown): value is ReviewPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<ReviewPoint>;
  return typeof point.x === "number" && typeof point.y === "number";
}

function isReviewDrawing(value: unknown): value is ReviewDrawing {
  if (!value || typeof value !== "object") return false;
  const drawing = value as Partial<ReviewDrawing>;
  return (
    DRAWING_TOOLS.includes(drawing.tool as ReviewDrawingTool) &&
    Array.isArray(drawing.points) &&
    drawing.points.length > 0 &&
    drawing.points.every(isReviewPoint) &&
    (drawing.strokeWidth === undefined ||
      typeof drawing.strokeWidth === "number")
  );
}

/** Whether `value` is a `ReviewComment` this version understands. Used to drop
 *  entries a newer app wrote that this one cannot represent, rather than
 *  crash on them or silently corrupt them on the next save. */
export function isReviewComment(value: unknown): value is ReviewComment {
  if (!value || typeof value !== "object") return false;
  const comment = value as Partial<ReviewComment>;
  // A drawing with no stroke would be an annotation nobody can see or click.
  if (comment.kind === "drawing" && !isReviewDrawing(comment.drawing)) {
    return false;
  }
  return (
    typeof comment.id === "string" &&
    (comment.kind === "comment" ||
      comment.kind === "highlight" ||
      comment.kind === "drawing") &&
    typeof comment.documentRoot === "string" &&
    typeof comment.author === "string" &&
    typeof comment.body === "string" &&
    (comment.status === "open" || comment.status === "resolved") &&
    (comment.color === undefined || typeof comment.color === "string") &&
    (comment.tags === undefined ||
      (Array.isArray(comment.tags) &&
        comment.tags.every((tag) => typeof tag === "string"))) &&
    typeof comment.createdAt === "string" &&
    typeof comment.updatedAt === "string" &&
    Array.isArray(comment.replies) &&
    comment.replies.every(isReviewReply) &&
    isReviewAnchor(comment.anchor)
  );
}

/** Parse one reviewer's file. A file this version does not recognise — wrong
 *  version, or not the shape at all — reads as no annotations rather than an
 *  error: a folder is read whole, and one damaged or newer file must not stop
 *  every other reviewer's comments from loading. */
export function parseReviewFile(text: string): ReviewComment[] {
  try {
    const parsed = JSON.parse(text) as Partial<ReviewFile>;
    if (
      parsed.version !== REVIEW_FILE_VERSION ||
      !Array.isArray(parsed.annotations)
    ) {
      return [];
    }
    return parsed.annotations.filter(isReviewComment);
  } catch {
    return [];
  }
}

/** Serialise one author's annotations exactly as desktop writes them:
 *  `JSON.stringify(file, null, 2)`. The indent and key order are the
 *  interoperability contract, not a style choice — a round trip that reorders
 *  keys or changes the indent is a diff in someone else's file for no reason
 *  they made. */
export function serializeReviewFile(file: ReviewFile): string {
  return JSON.stringify(file, null, 2);
}

/** File name for one reviewer's annotations, e.g. `review/dany-laksono.json`.
 *
 *  Two author names that fold to the same slug — "Dany Laksono" and
 *  "dany-laksono" — collide on one file, and the second writer's save
 *  overwrites the first's. Desktop has the same collision; this is the same
 *  scheme rather than a fix, because a different scheme would stop two
 *  products opening the same project from agreeing on a reviewer's file. */
export function reviewerFileName(author: string): string {
  const slug = author
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "reviewer"}.json`;
}

/** The project-relative path for one author's review file. */
export function reviewFilePath(author: string): string {
  return `${REVIEW_DIRECTORY}/${reviewerFileName(author)}`;
}
