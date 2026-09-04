/**
 * `ProjectRepository` over OPFS and IndexedDB (PLAN.md 6.1).
 *
 * The split is the one the plan specifies and it is not arbitrary: file bytes
 * are file-shaped and belong in a filesystem a worker can reach, while metadata
 * needs transactions and migrations and belongs in a database. Keeping them
 * apart means the compiler worker can read a project's files without loading a
 * database, and the picker can list projects without touching the filesystem.
 *
 * What that split costs is atomicity across the two, and this is where the
 * durability promise is actually kept:
 *
 * - **Bytes are written before metadata.** A crash between the two leaves a
 *   file on disk that the record does not mention, which is invisible and
 *   harmless. The reverse order would leave a record promising a file that is
 *   not there, which is a project that opens broken.
 * - **Each file is written to a temporary name and renamed into place.** OPFS
 *   has no atomic multi-file commit, but a rename is atomic, so a torn write
 *   cannot replace good content with half of a new version.
 * - **A write holds a lock named for the project.** Conditional revisions catch
 *   a second tab that started from a stale read; the lock stops two tabs
 *   interleaving the read and the write that make a revision check meaningful
 *   in the first place.
 *
 * Paths are stored flat: a project's files live in one directory, named by the
 * project path with `/` escaped. Directories in OPFS would mean creating and
 * removing them in step with the file set, and the path is already validated
 * (`projectPath`) to be relative, traversal-free and normalised, so the escaped
 * name is a total function of it.
 */

import {
  type ProjectId,
  type ProjectPath,
  projectId,
  projectPath,
} from "@/core/project/ids";
import {
  type CreateProjectInput,
  FileNotFoundError,
  ProjectConflictError,
  type ProjectFile,
  ProjectNotFoundError,
  type ProjectRepository,
  type ProjectSummary,
  StorageQuotaError,
  type StoredProject,
} from "@/core/project/repository";
import { CURRENT_SCHEMA_VERSION, migrateProject } from "@/core/project/schema";

const DATABASE_NAME = "opal-projects";
const DATABASE_VERSION = 1;
const PROJECT_STORE = "projects";
const PROJECTS_DIRECTORY = "projects";

/** Injected so tests can control identity and time. */
export interface OpfsRepositoryOptions {
  now?: () => Date;
  newId?: () => ProjectId;
  /** Defaults to `navigator.storage.getDirectory()`. */
  root?: () => Promise<FileSystemDirectoryHandle>;
  /** Defaults to `indexedDB`. */
  indexedDb?: IDBFactory;
  /** Defaults to `navigator.locks`; absent means the lock is skipped. */
  locks?: LockManager | null;
}

/**
 * A file name for a project-relative path.
 *
 * `/` becomes `%2F` and an existing `%` becomes `%25`, so the mapping is
 * reversible and two different paths cannot collide on one name — `a%2Fb` and
 * `a/b` would otherwise both arrive as `a%2Fb`.
 */
export function encodeFileName(path: ProjectPath): string {
  return path.replace(/%/g, "%25").replace(/\//g, "%2F");
}

export function decodeFileName(name: string): ProjectPath {
  return projectPath(name.replace(/%2F/g, "/").replace(/%25/g, "%"));
}

export class OpfsProjectRepository implements ProjectRepository {
  readonly #now: () => Date;
  readonly #newId: () => ProjectId;
  readonly #root: () => Promise<FileSystemDirectoryHandle>;
  readonly #indexedDb: IDBFactory;
  readonly #locks: LockManager | null;
  #database: Promise<IDBDatabase> | undefined;

  constructor(options: OpfsRepositoryOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#newId =
      options.newId ?? (() => projectId(crypto.randomUUID().toLowerCase()));
    this.#root = options.root ?? (() => navigator.storage.getDirectory());
    this.#indexedDb = options.indexedDb ?? indexedDB;
    this.#locks =
      options.locks === undefined
        ? ((globalThis.navigator?.locks as LockManager | undefined) ?? null)
        : options.locks;
  }

  async list(): Promise<ProjectSummary[]> {
    const records = await this.#allRecords();
    return records
      .map(({ schemaVersion: _schema, ...summary }) => summary)
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async create(input: CreateProjectInput): Promise<StoredProject> {
    const timestamp = this.#now().toISOString();
    const id = this.#newId();
    const files = input.files ?? [];

    // Bytes first: a record that mentions files which are not there is a
    // project that opens broken, while the reverse is invisible.
    const directory = await this.#ensureDirectory(id);
    for (const file of files) {
      await writeAtomically(directory, file);
    }

    const record: StoredProject = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id,
      title: input.title,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
      revision: 1,
      fileCount: files.length,
      byteSize: files.reduce((total, file) => total + file.bytes.length, 0),
      ...(input.rootTexPath ? { rootTexPath: input.rootTexPath } : {}),
    };
    await this.#putRecord(record);
    return record;
  }

  async get(id: ProjectId): Promise<StoredProject> {
    return this.#record(id);
  }

  async open(id: ProjectId): Promise<StoredProject> {
    // Not a write in the revision sense: opening reorders the picker and must
    // not invalidate a conditional write another tab is holding.
    const record = await this.#record(id);
    const opened = { ...record, lastOpenedAt: this.#now().toISOString() };
    await this.#putRecord(opened);
    return opened;
  }

  async delete(id: ProjectId): Promise<void> {
    await this.#withLock(id, async () => {
      const root = await this.#projectsRoot();
      try {
        await root.removeEntry(directoryName(id), { recursive: true });
      } catch {
        // Already gone. Deleting is idempotent: a retry, or two tabs closing
        // the same project, must not become an error a UI has to explain.
      }
      const database = await this.#open();
      await request(
        database
          .transaction(PROJECT_STORE, "readwrite")
          .objectStore(PROJECT_STORE)
          .delete(id),
      );
    });
  }

  async rename(id: ProjectId, title: string): Promise<StoredProject> {
    return this.#withLock(id, async () => {
      const record = await this.#record(id);
      const renamed = {
        ...record,
        title,
        revision: record.revision + 1,
        updatedAt: this.#now().toISOString(),
      };
      await this.#putRecord(renamed);
      return renamed;
    });
  }

  async listFiles(id: ProjectId): Promise<ProjectPath[]> {
    await this.#record(id);
    const directory = await this.#directory(id);
    if (!directory) return [];
    const paths: ProjectPath[] = [];
    for await (const name of directoryNames(directory)) {
      // Temporary files from an interrupted write are not project content.
      if (name.endsWith(TEMPORARY_SUFFIX)) continue;
      paths.push(decodeFileName(name));
    }
    return paths.sort();
  }

  async readFile(id: ProjectId, path: ProjectPath): Promise<Uint8Array> {
    await this.#record(id);
    const directory = await this.#directory(id);
    if (!directory) throw new FileNotFoundError(id, path);
    try {
      const handle = await directory.getFileHandle(encodeFileName(path));
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      throw new FileNotFoundError(id, path);
    }
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
    return this.#withLock(id, async () => {
      const record = await this.#record(id, expectedRevision);
      const directory = await this.#ensureDirectory(id);
      for (const file of files) {
        await writeAtomically(directory, file);
      }
      return this.#publish(record, directory);
    });
  }

  async deleteFile(
    id: ProjectId,
    path: ProjectPath,
    expectedRevision?: number,
  ): Promise<number> {
    return this.#withLock(id, async () => {
      const record = await this.#record(id, expectedRevision);
      const directory = await this.#ensureDirectory(id);
      try {
        await directory.removeEntry(encodeFileName(path));
      } catch {
        throw new FileNotFoundError(id, path);
      }
      return this.#publish(record, directory);
    });
  }

  /** Recount what is on disk and write the new revision. */
  async #publish(
    record: StoredProject,
    directory: FileSystemDirectoryHandle,
  ): Promise<number> {
    // Counted from the directory rather than from the write that just
    // happened, so the record describes what is actually stored even if an
    // earlier write was interrupted.
    let fileCount = 0;
    let byteSize = 0;
    for await (const name of directoryNames(directory)) {
      if (name.endsWith(TEMPORARY_SUFFIX)) continue;
      const handle = await directory.getFileHandle(name);
      byteSize += (await handle.getFile()).size;
      fileCount++;
    }

    const updated: StoredProject = {
      ...record,
      revision: record.revision + 1,
      updatedAt: this.#now().toISOString(),
      fileCount,
      byteSize,
    };
    await this.#putRecord(updated);
    return updated.revision;
  }

  async #record(
    id: ProjectId,
    expectedRevision?: number,
  ): Promise<StoredProject> {
    const database = await this.#open();
    const found = await request<unknown>(
      database
        .transaction(PROJECT_STORE, "readonly")
        .objectStore(PROJECT_STORE)
        .get(id),
    );
    if (!found) throw new ProjectNotFoundError(id);

    // Migration runs before a project is used, never lazily on read of one
    // field: a record half-understood is worse than one refused.
    const record = migrateProject(found as Record<string, unknown>);
    if (
      expectedRevision !== undefined &&
      expectedRevision !== record.revision
    ) {
      throw new ProjectConflictError(id, expectedRevision, record.revision);
    }
    return record;
  }

  async #allRecords(): Promise<StoredProject[]> {
    const database = await this.#open();
    const found = await request<unknown[]>(
      database
        .transaction(PROJECT_STORE, "readonly")
        .objectStore(PROJECT_STORE)
        .getAll(),
    );
    const records: StoredProject[] = [];
    for (const raw of found) {
      try {
        records.push(migrateProject(raw as Record<string, unknown>));
      } catch {
        // One unreadable record must not empty the picker. It stays on disk,
        // and the project it describes stays recoverable by export.
      }
    }
    return records;
  }

  async #putRecord(record: StoredProject): Promise<void> {
    const database = await this.#open();
    await request(
      database
        .transaction(PROJECT_STORE, "readwrite")
        .objectStore(PROJECT_STORE)
        .put(record),
    );
  }

  async #projectsRoot(): Promise<FileSystemDirectoryHandle> {
    const root = await this.#root();
    return root.getDirectoryHandle(PROJECTS_DIRECTORY, { create: true });
  }

  /** The project's directory, creating it if it is not there yet. */
  async #ensureDirectory(id: ProjectId): Promise<FileSystemDirectoryHandle> {
    const root = await this.#projectsRoot();
    return root.getDirectoryHandle(directoryName(id), { create: true });
  }

  /**
   * The project's directory if it exists.
   *
   * A project with no files has no directory, which is not an error: a record
   * without one lists nothing rather than failing to open.
   */
  async #directory(
    id: ProjectId,
  ): Promise<FileSystemDirectoryHandle | undefined> {
    const root = await this.#projectsRoot();
    try {
      return await root.getDirectoryHandle(directoryName(id));
    } catch {
      return undefined;
    }
  }

  /**
   * Serialise writes to one project across tabs.
   *
   * A revision check is a read followed by a write, and two tabs interleaving
   * those can both pass the check. The lock makes the pair indivisible. Where
   * the Web Locks API is missing the repository still works and still refuses
   * stale writes; it only loses the guarantee about perfectly simultaneous ones.
   */
  async #withLock<T>(id: ProjectId, work: () => Promise<T>): Promise<T> {
    if (!this.#locks) return work();
    return this.#locks.request(`opal-project-${id}`, work) as Promise<T>;
  }

  /**
   * Release the IndexedDB connection.
   *
   * An open connection blocks `deleteDatabase` indefinitely, and any later
   * `open` queues behind that delete — so a repository nobody closes can wedge
   * every repository that follows it. The app keeps one for its lifetime and
   * never needs this; anything that creates several does.
   */
  async close(): Promise<void> {
    const database = this.#database;
    this.#database = undefined;
    if (database) (await database).close();
  }

  #open(): Promise<IDBDatabase> {
    this.#database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const opening = this.#indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
      opening.onupgradeneeded = () => {
        const database = opening.result;
        if (!database.objectStoreNames.contains(PROJECT_STORE)) {
          database.createObjectStore(PROJECT_STORE, { keyPath: "id" });
        }
      };
      opening.onsuccess = () => {
        resolve(opening.result);
      };
      opening.onerror = () => {
        reject(opening.error ?? new Error("IndexedDB refused to open"));
      };
    });
    return this.#database;
  }
}

/** Suffix for a file being written, so a torn write is never mistaken for content. */
const TEMPORARY_SUFFIX = ".opal-part";

function directoryName(id: ProjectId): string {
  return id;
}

/**
 * Write to a temporary name, then rename into place.
 *
 * OPFS offers no atomic commit across files, but a rename is atomic, so a write
 * interrupted halfway leaves the previous content intact and a stray temporary
 * file rather than a half-written document.
 */
async function writeAtomically(
  directory: FileSystemDirectoryHandle,
  file: ProjectFile,
): Promise<void> {
  const finalName = encodeFileName(file.path);
  const temporaryName = `${finalName}${TEMPORARY_SUFFIX}`;
  try {
    const handle = await directory.getFileHandle(temporaryName, {
      create: true,
    });
    const writable = await handle.createWritable();
    try {
      await writable.write(file.bytes as unknown as BufferSource);
    } finally {
      await writable.close();
    }
    // `move` is what makes this atomic. Where it is unavailable the fallback
    // rewrites in place, which is the behaviour this exists to avoid — so it is
    // used only because losing the write entirely would be worse.
    const movable = handle as FileSystemFileHandle & {
      move?: (name: string) => Promise<void>;
    };
    if (typeof movable.move === "function") {
      await movable.move(finalName);
    } else {
      await rewriteInPlace(directory, finalName, file.bytes);
      await directory.removeEntry(temporaryName);
    }
  } catch (error) {
    if (isQuotaError(error)) {
      throw new StorageQuotaError(file.bytes.length, error);
    }
    throw error;
  }
}

async function rewriteInPlace(
  directory: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes as unknown as BufferSource);
  } finally {
    await writable.close();
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "NotAllowedError" ||
      // Safari reports a quota failure with this legacy code.
      error.code === 22)
  );
}

/** Entry names in a directory, across the two shapes browsers expose. */
async function* directoryNames(
  directory: FileSystemDirectoryHandle,
): AsyncGenerator<string> {
  const iterable = directory as FileSystemDirectoryHandle & {
    keys?: () => AsyncIterableIterator<string>;
  };
  if (typeof iterable.keys === "function") {
    for await (const name of iterable.keys()) yield name;
    return;
  }
  for await (const [name] of iterable as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    yield name;
  }
}

/** An IndexedDB request as a promise. */
function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    source.onsuccess = () => {
      resolve(source.result);
    };
    source.onerror = () => {
      reject(source.error ?? new Error("IndexedDB request failed"));
    };
  });
}
