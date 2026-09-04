/**
 * `ProjectRepository` held in memory.
 *
 * Not a mock. It is the reference for what the contract means — the conformance
 * suite in `tests/support/repository-contract.ts` runs against this and against
 * the OPFS implementation, and a disagreement between them is a bug in one of
 * the two rather than a fact about storage. It is also what the UI develops
 * against, since a project picker should not need OPFS to render.
 *
 * Nothing here survives a reload, which is the one thing it does not model.
 */

import {
  newProjectId,
  type ProjectId,
  type ProjectPath,
} from "@/core/project/ids";
import {
  type CreateProjectInput,
  FileNotFoundError,
  ProjectConflictError,
  type ProjectFile,
  ProjectNotFoundError,
  type ProjectRepository,
  type ProjectSummary,
  type StoredProject,
} from "@/core/project/repository";
import { CURRENT_SCHEMA_VERSION } from "@/core/project/schema";

interface Entry {
  record: StoredProject;
  files: Map<ProjectPath, Uint8Array>;
}

/** Injectable so tests can produce records with predictable timestamps. */
export interface MemoryRepositoryOptions {
  now?: () => Date;
  newId?: () => ProjectId;
}

export class MemoryProjectRepository implements ProjectRepository {
  readonly #projects = new Map<ProjectId, Entry>();
  readonly #now: () => Date;
  readonly #newId: () => ProjectId;

  constructor(options: MemoryRepositoryOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? newProjectId;
  }

  async list(): Promise<ProjectSummary[]> {
    return [...this.#projects.values()]
      .map((entry) => summarise(entry))
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async create(input: CreateProjectInput): Promise<StoredProject> {
    const timestamp = this.#now().toISOString();
    const files = new Map<ProjectPath, Uint8Array>();
    for (const file of input.files ?? []) {
      files.set(file.path, copy(file.bytes));
    }
    const record: StoredProject = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: this.#newId(),
      title: input.title,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
      // A project starts at revision 1 rather than 0 so that "no revision yet"
      // and "revision zero" cannot be confused by a caller holding a number.
      revision: 1,
      fileCount: files.size,
      byteSize: totalBytes(files),
      ...(input.rootTexPath ? { rootTexPath: input.rootTexPath } : {}),
    };
    this.#projects.set(record.id, { record, files });
    return { ...record };
  }

  async get(id: ProjectId): Promise<StoredProject> {
    return { ...this.#entry(id).record };
  }

  async open(id: ProjectId): Promise<StoredProject> {
    const entry = this.#entry(id);
    // Opening is not an edit: it moves the project up the picker without
    // invalidating anyone's conditional write.
    entry.record.lastOpenedAt = this.#now().toISOString();
    return { ...entry.record };
  }

  async delete(id: ProjectId): Promise<void> {
    this.#projects.delete(id);
  }

  async rename(id: ProjectId, title: string): Promise<StoredProject> {
    const entry = this.#entry(id);
    entry.record.title = title;
    this.#touch(entry);
    return { ...entry.record };
  }

  async listFiles(id: ProjectId): Promise<ProjectPath[]> {
    return [...this.#entry(id).files.keys()].sort();
  }

  async readFile(id: ProjectId, path: ProjectPath): Promise<Uint8Array> {
    const bytes = this.#entry(id).files.get(path);
    if (!bytes) throw new FileNotFoundError(id, path);
    // A copy, so a caller mutating what it read cannot rewrite stored bytes
    // without going through `writeFile` and taking a revision with it.
    return copy(bytes);
  }

  async writeFile(
    id: ProjectId,
    path: ProjectPath,
    bytes: Uint8Array,
    expectedRevision?: number,
  ): Promise<number> {
    return this.writeFiles(id, [{ path, bytes }], expectedRevision);
  }

  async writeFiles(
    id: ProjectId,
    files: readonly ProjectFile[],
    expectedRevision?: number,
  ): Promise<number> {
    const entry = this.#entry(id, expectedRevision);
    for (const file of files) {
      entry.files.set(file.path, copy(file.bytes));
    }
    return this.#touch(entry);
  }

  async deleteFile(
    id: ProjectId,
    path: ProjectPath,
    expectedRevision?: number,
  ): Promise<number> {
    const entry = this.#entry(id, expectedRevision);
    if (!entry.files.delete(path)) throw new FileNotFoundError(id, path);
    return this.#touch(entry);
  }

  /** Look a project up, checking the caller's revision when it gave one. */
  #entry(id: ProjectId, expectedRevision?: number): Entry {
    const entry = this.#projects.get(id);
    if (!entry) throw new ProjectNotFoundError(id);
    if (
      expectedRevision !== undefined &&
      expectedRevision !== entry.record.revision
    ) {
      throw new ProjectConflictError(
        id,
        expectedRevision,
        entry.record.revision,
      );
    }
    return entry;
  }

  /** Publish a new revision, with the counts a picker shows kept in step. */
  #touch(entry: Entry): number {
    entry.record.revision += 1;
    entry.record.updatedAt = this.#now().toISOString();
    entry.record.fileCount = entry.files.size;
    entry.record.byteSize = totalBytes(entry.files);
    return entry.record.revision;
  }
}

function copy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function totalBytes(files: Map<ProjectPath, Uint8Array>): number {
  let total = 0;
  for (const bytes of files.values()) total += bytes.length;
  return total;
}

function summarise(entry: Entry): ProjectSummary {
  const { schemaVersion: _schema, ...summary } = entry.record;
  return summary;
}
