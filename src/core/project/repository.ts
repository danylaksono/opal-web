/**
 * The project storage contract (PLAN.md 6, 14 Phase 1).
 *
 * Projects live on the user's device, which makes this port the product's
 * durability promise rather than a convenience over a database. Three rules
 * follow from that and are expressed in the types rather than left to each
 * implementation:
 *
 * - **A revision changes on every write.** The compiler already keys results by
 *   revision so a stale compile cannot replace newer output; the same number is
 *   what lets a caller detect that someone else moved the project underneath it.
 * - **Writes are conditional.** Passing the revision you believed you were
 *   editing turns "two tabs silently overwrite each other" — a Phase 1 exit
 *   criterion — into a `ProjectConflictError` that a UI can act on. Omitting it
 *   is allowed and means "last writer wins", which is correct for a single tab
 *   restoring an autosave and wrong for anything else.
 * - **Metadata and bytes move together.** `writeFile` returns the revision it
 *   produced, so a caller never has to re-read a project to know what it now
 *   holds.
 *
 * Nothing here touches a browser API. The storage split PLAN.md 6.1 specifies —
 * bytes in OPFS, metadata in IndexedDB — is one implementation of this port,
 * and an in-memory one exists so that the UI and its tests do not need either.
 */

import type { ProjectId, ProjectPath } from "./ids";

/** What a project picker needs, without reading any file bytes. */
export interface ProjectSummary {
  id: ProjectId;
  title: string;
  /** ISO 8601, UTC. Strings rather than Date so records serialise unchanged. */
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  /** Increments on every write. Compare, never interpret as a count of edits. */
  revision: number;
  fileCount: number;
  /** Total bytes of file content, for quota reporting. */
  byteSize: number;
}

/** A project's full record, as stored. */
export interface StoredProject extends ProjectSummary {
  /** The schema this record was written under. See `migrateProject`. */
  schemaVersion: number;
  /** The file a compile starts from, when the project has been told. */
  rootTexPath?: ProjectPath;
  /**
   * A connected local directory, when the browser supports one.
   *
   * The handle itself is stored separately by the adapter, because a
   * `FileSystemDirectoryHandle` is structured-cloneable but not JSON. Losing
   * the directory must never lose the project: PLAN.md 6.3 makes the browser
   * copy canonical, so this is a pointer to a mirror and not to the source.
   */
  directoryMirror?: {
    handleKey: string;
    lastSyncRevision: number;
    lastSyncAt?: string;
  };
}

export interface ProjectFile {
  path: ProjectPath;
  bytes: Uint8Array;
}

export interface CreateProjectInput {
  title: string;
  files?: readonly ProjectFile[];
  rootTexPath?: ProjectPath;
}

export class ProjectNotFoundError extends Error {
  readonly id: ProjectId;

  constructor(id: ProjectId) {
    super(`No project ${id}`);
    this.name = "ProjectNotFoundError";
    this.id = id;
  }
}

export class FileNotFoundError extends Error {
  readonly id: ProjectId;
  readonly path: ProjectPath;

  constructor(id: ProjectId, path: ProjectPath) {
    super(`No file ${path} in project ${id}`);
    this.name = "FileNotFoundError";
    this.id = id;
    this.path = path;
  }
}

/**
 * A conditional write whose project had moved on.
 *
 * Carries both revisions because the useful UI is a comparison, not an
 * apology: the caller knows what it was editing and can now say what it would
 * be overwriting.
 */
export class ProjectConflictError extends Error {
  readonly id: ProjectId;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(id: ProjectId, expected: number, actual: number) {
    super(
      `Project ${id} is at revision ${actual}, not ${expected}: ` +
        "it changed since this edit began",
    );
    this.name = "ProjectConflictError";
    this.id = id;
    this.expectedRevision = expected;
    this.actualRevision = actual;
  }
}

/** Raised when a write would take the project past what storage allows. */
export class StorageQuotaError extends Error {
  readonly requestedBytes: number;

  constructor(requestedBytes: number, cause?: unknown) {
    super(`Storage refused a write of ${requestedBytes} bytes`);
    this.name = "StorageQuotaError";
    this.requestedBytes = requestedBytes;
    this.cause = cause;
  }
}

export interface ProjectRepository {
  /** Every project, most recently opened first. */
  list(): Promise<ProjectSummary[]>;

  /** Create a project, optionally with its initial files. */
  create(input: CreateProjectInput): Promise<StoredProject>;

  /** Read a project's record without touching `lastOpenedAt`. */
  get(id: ProjectId): Promise<StoredProject>;

  /**
   * Read a project's record and mark it opened.
   *
   * Separate from `get` because "most recently opened" drives the picker's
   * order, and a background read — a quota sweep, an export — must not reorder
   * what the user sees.
   */
  open(id: ProjectId): Promise<StoredProject>;

  /** Remove a project and every byte it owns. Idempotent. */
  delete(id: ProjectId): Promise<void>;

  rename(id: ProjectId, title: string): Promise<StoredProject>;

  /** Paths in the project, in a stable order. */
  listFiles(id: ProjectId): Promise<ProjectPath[]>;

  readFile(id: ProjectId, path: ProjectPath): Promise<Uint8Array>;

  /**
   * Write one file, returning the project's new revision.
   *
   * `expectedRevision` makes the write conditional; see the note above on why
   * omitting it is a deliberate choice rather than a default.
   */
  writeFile(
    id: ProjectId,
    path: ProjectPath,
    bytes: Uint8Array,
    expectedRevision?: number,
  ): Promise<number>;

  deleteFile(
    id: ProjectId,
    path: ProjectPath,
    expectedRevision?: number,
  ): Promise<number>;

  /**
   * Apply several file changes as one revision.
   *
   * Import and autosave both touch many files at once, and applying them one
   * at a time would publish revisions for states the project was never
   * meaningfully in — and leave a half-imported project behind if the tab
   * closed midway.
   */
  writeFiles(
    id: ProjectId,
    files: readonly ProjectFile[],
    expectedRevision?: number,
  ): Promise<number>;
}
