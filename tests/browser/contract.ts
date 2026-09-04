/**
 * Runs the shared repository contract against real OPFS and IndexedDB.
 *
 * The unit suite proves the contract against an in-memory repository, which
 * cannot fail the way storage fails. This page runs the same cases where the
 * implementation actually has to work — a browser with a filesystem, a
 * database, quota, and a `move` that may or may not exist. A rule that holds in
 * memory and not here is exactly the divergence the shared contract exists to
 * catch.
 *
 * It also covers what only a real filesystem can be asked: that a write which
 * fails part-way leaves the previous content intact, which is the Phase 1 exit
 * criterion about a simulated failed write.
 *
 * Built only when `OPAL_TEST_PAGES=1`, so it is not part of the app.
 */

import { projectPath } from "@/core/project/ids";
import { StorageQuotaError } from "@/core/project/repository";
import { OpfsProjectRepository } from "@/platform/browser/storage/opfs-project-repository";
import {
  ContractFailure,
  type RepositoryCase,
  repositoryContract,
} from "../support/repository-contract";

/** Everything this origin holds, removed, so each case starts empty. */
async function resetStorage(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for await (const [name] of root as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    await root.removeEntry(name, { recursive: true });
  }
  // The store is emptied rather than the database deleted. `deleteDatabase`
  // stays pending while any connection is open, and every later `open` queues
  // behind it — one repository left open would wedge every case after it.
  await new Promise<void>((resolve) => {
    const opening = indexedDB.open("opal-projects", 1);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains("projects")) {
        database.createObjectStore("projects", { keyPath: "id" });
      }
    };
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction("projects", "readwrite");
      transaction.objectStore("projects").clear();
      const done = () => {
        database.close();
        resolve();
      };
      transaction.oncomplete = done;
      transaction.onerror = done;
    };
    opening.onerror = () => {
      resolve();
    };
  });
}

/**
 * A directory tree whose writes fail once, part-way through.
 *
 * Wraps the real OPFS handles so everything else behaves normally: the point is
 * a write that begins and then cannot finish, which is what a full disk or a
 * revoked grant looks like from here. A handle that refused to open at all
 * would test a different and easier failure.
 */
function failingRoot(
  real: FileSystemDirectoryHandle,
  shouldFail: () => boolean,
): FileSystemDirectoryHandle {
  const wrapDirectory = (
    directory: FileSystemDirectoryHandle,
  ): FileSystemDirectoryHandle =>
    new Proxy(directory, {
      get(target, property, receiver) {
        if (property === "getDirectoryHandle") {
          return async (
            name: string,
            options?: FileSystemGetDirectoryOptions,
          ) => wrapDirectory(await target.getDirectoryHandle(name, options));
        }
        if (property === "getFileHandle") {
          return async (name: string, options?: FileSystemGetFileOptions) => {
            const handle = await target.getFileHandle(name, options);
            return new Proxy(handle, {
              get(fileTarget, fileProperty, fileReceiver) {
                if (fileProperty === "createWritable") {
                  return async (options?: FileSystemCreateWritableOptions) => {
                    const writable = await fileTarget.createWritable(options);
                    return new Proxy(writable, {
                      get(streamTarget, streamProperty) {
                        if (streamProperty === "write" && shouldFail()) {
                          // Thrown without closing: the repository closes the
                          // stream in its own `finally`, and closing here too
                          // would fail the test on a double close rather than
                          // on the thing being tested.
                          return async () => {
                            throw new DOMException(
                              "simulated write failure",
                              "QuotaExceededError",
                            );
                          };
                        }
                        const value = Reflect.get(streamTarget, streamProperty);
                        return typeof value === "function"
                          ? value.bind(streamTarget)
                          : value;
                      },
                    });
                  };
                }
                const value = Reflect.get(
                  fileTarget,
                  fileProperty,
                  fileReceiver,
                );
                return typeof value === "function"
                  ? value.bind(fileTarget)
                  : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return wrapDirectory(real);
}

/** Cases that only mean something against a real filesystem. */
const storageCases: RepositoryCase[] = [
  {
    name: "a failed write leaves the previous content intact",
    run: async () => {
      // The Phase 1 exit criterion. The write is interrupted after it opens,
      // which is where the temporary-file-and-rename design has to pay off:
      // the file the reader sees must be the old one, not a truncated new one.
      const main = projectPath("main.tex");
      let failing = false;
      const repository = new OpfsProjectRepository({
        root: async () =>
          failingRoot(await navigator.storage.getDirectory(), () => failing),
      });

      const project = await repository.create({
        title: "Durable",
        files: [{ path: main, bytes: new TextEncoder().encode("original") }],
      });

      failing = true;
      let refused: unknown;
      try {
        await repository.writeFile(
          project.id,
          main,
          new TextEncoder().encode("replacement that never lands"),
        );
      } catch (error) {
        refused = error;
      }
      failing = false;

      if (!refused) {
        throw new ContractFailure("the failing write reported success");
      }
      if (!(refused instanceof StorageQuotaError)) {
        throw new ContractFailure(
          `expected StorageQuotaError, got ${String(refused)}`,
        );
      }

      const after = new TextDecoder().decode(
        await repository.readFile(project.id, main),
      );
      if (after !== "original") {
        throw new ContractFailure(
          `content after a failed write: expected "original", got ${JSON.stringify(after)}`,
        );
      }
    },
  },
  {
    name: "a record from a newer build is refused, not discarded",
    run: async (repository) => {
      // What an app update looks like from the older side: a tab that has been
      // open for a week meets a record the new build wrote. Downgrading would
      // be guesswork against someone's only copy, so it is refused — and the
      // record has to survive being refused, or the update destroys the work
      // it could not read.
      const mine = await repository.create({ title: "Mine" });
      await new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open("opal-projects", 1);
        opening.onsuccess = () => {
          const database = opening.result;
          const transaction = database.transaction("projects", "readwrite");
          transaction.objectStore("projects").put({
            schemaVersion: 99,
            id: "from-the-future",
            title: "Written by a newer build",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastOpenedAt: new Date().toISOString(),
            revision: 7,
            fileCount: 0,
            byteSize: 0,
          });
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => {
            database.close();
            reject(transaction.error);
          };
        };
        opening.onerror = () => reject(opening.error);
      });

      // One unreadable record must not empty the picker.
      const listed = await repository.list();
      if (!listed.some((project) => project.id === mine.id)) {
        throw new ContractFailure("a readable project vanished from the list");
      }
      if (listed.some((project) => project.id === "from-the-future")) {
        throw new ContractFailure(
          "a record from the future was listed as usable",
        );
      }

      // And it is still on disk, waiting for a build that understands it.
      const survived = await new Promise<boolean>((resolve) => {
        const opening = indexedDB.open("opal-projects", 1);
        opening.onsuccess = () => {
          const database = opening.result;
          const request = database
            .transaction("projects", "readonly")
            .objectStore("projects")
            .get("from-the-future");
          request.onsuccess = () => {
            database.close();
            resolve(request.result !== undefined);
          };
          request.onerror = () => {
            database.close();
            resolve(false);
          };
        };
        opening.onerror = () => {
          resolve(false);
        };
      });
      if (!survived) {
        throw new ContractFailure("the unreadable record was destroyed");
      }
    },
  },
  {
    name: "a project survives being read back through a second repository",
    run: async () => {
      // Two repository instances are what two tabs have. A record written by
      // one must be readable by the other, which is the difference between
      // persistence and a cache that happens to answer.
      const main = projectPath("main.tex");
      const writer = new OpfsProjectRepository();
      const project = await writer.create({
        title: "Shared",
        files: [{ path: main, bytes: new TextEncoder().encode("written") }],
      });

      const reader = new OpfsProjectRepository();
      const seen = await reader.get(project.id);
      if (seen.title !== "Shared") {
        throw new ContractFailure(`second instance saw ${seen.title}`);
      }
      const content = new TextDecoder().decode(
        await reader.readFile(project.id, main),
      );
      if (content !== "written") {
        throw new ContractFailure(`second instance read ${content}`);
      }
    },
  },
];

async function main(): Promise<void> {
  const results = document.querySelector("[data-testid=contract-results]");
  const status = document.querySelector("[data-testid=contract-status]");
  let failures = 0;

  for (const testCase of [...repositoryContract, ...storageCases]) {
    const item = document.createElement("li");
    item.dataset.testid = "contract-case";
    try {
      await resetStorage();
      await testCase.run(new OpfsProjectRepository());
      item.dataset.state = "passed";
      item.textContent = `PASS ${testCase.name}`;
    } catch (error) {
      failures++;
      item.dataset.state = "failed";
      item.textContent = `FAIL ${testCase.name} — ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    results?.append(item);
  }

  if (status instanceof HTMLElement) {
    status.dataset.state = failures === 0 ? "passed" : "failed";
    status.textContent = `${failures} failed`;
  }
}

void main();
