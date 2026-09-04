/**
 * Transactional autosave over a `ProjectRepository` (PLAN.md 14, Phase 1).
 *
 * Saving on every keystroke would publish a revision per character; saving on a
 * timer alone loses whatever was typed in the last interval. This coalesces
 * edits and writes them as one revision once typing pauses, and it is the
 * storage half of autosave rather than an editor: what it takes is bytes for a
 * path, and it has no opinion about where they came from.
 *
 * Four rules, each of which exists because the obvious implementation loses
 * work in a way that is hard to notice:
 *
 * - **One write is in flight at a time.** Overlapping writes to the same
 *   project would race, and the loser would be an edit the user watched being
 *   accepted.
 * - **Edits during a write are kept, not dropped.** They become the next write,
 *   so a fast typist cannot outrun the scheduler.
 * - **Every write is conditional.** It carries the revision this session
 *   believes it is at, so another tab's change is a `conflict` rather than a
 *   silent overwrite — the Phase 1 exit criterion, enforced at the point where
 *   the overwrite would happen.
 * - **A conflict stops autosaving.** Retrying would resolve the conflict by
 *   discarding the other tab's work, which is precisely the thing the check
 *   exists to prevent. The caller decides.
 *
 * `flush` exists because a debounce is a promise to write soon, and "soon" is
 * not good enough when the tab is closing.
 */

import type { ProjectId, ProjectPath } from "./ids";
import {
  ProjectConflictError,
  type ProjectFile,
  type ProjectRepository,
} from "./repository";

export type SaveState =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "conflict"
  | "failed";

export interface SaveStatus {
  state: SaveState;
  /** The revision this session last saw, and writes against. */
  revision: number;
  /** Set when `state` is `conflict`: what the project had actually reached. */
  actualRevision?: number;
  /** Set when `state` is `failed`. */
  message?: string;
}

export interface AutosaveOptions {
  repository: ProjectRepository;
  projectId: ProjectId;
  /** The revision the caller last read. Writes are conditional on it. */
  revision: number;
  /**
   * Quiet period before a write, in milliseconds.
   *
   * Long enough that ordinary typing produces one write rather than dozens,
   * short enough that a user who stops to think has already been saved.
   */
  debounceMs?: number;
  onStatus?: (status: SaveStatus) => void;
}

export interface Autosave {
  /** Record an edit. Overwrites any queued edit for the same path. */
  queue(path: ProjectPath, bytes: Uint8Array): void;
  /** Write everything queued now, and wait for it. Safe to call when idle. */
  flush(): Promise<void>;
  status(): SaveStatus;
  /** Stop scheduling. Anything already queued stays queued for `flush`. */
  stop(): void;
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const { repository, projectId, onStatus } = options;
  const debounceMs = options.debounceMs ?? 800;

  const pending = new Map<ProjectPath, Uint8Array>();
  let status: SaveStatus = { state: "idle", revision: options.revision };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;
  let stopped = false;

  const publish = (next: SaveStatus): void => {
    status = next;
    onStatus?.(next);
  };

  const writeOnce = async (): Promise<void> => {
    // Taken before the write, so edits arriving during it queue for the next
    // round rather than being written twice or lost.
    const batch: ProjectFile[] = [...pending].map(([path, bytes]) => ({
      path,
      bytes,
    }));
    if (batch.length === 0) return;
    pending.clear();

    publish({ state: "saving", revision: status.revision });
    try {
      const revision = await repository.writeFiles(
        projectId,
        batch,
        status.revision,
      );
      publish({ state: "saved", revision });
    } catch (error) {
      // Put the batch back, so whatever happens next still has the edits.
      // First writer wins on re-queue: a newer edit for the same path arrived
      // after this batch was taken and is the one the user last typed.
      for (const file of batch) {
        if (!pending.has(file.path)) pending.set(file.path, file.bytes);
      }
      if (error instanceof ProjectConflictError) {
        stopped = true;
        publish({
          state: "conflict",
          revision: status.revision,
          actualRevision: error.actualRevision,
        });
        return;
      }
      publish({
        state: "failed",
        revision: status.revision,
        message: error instanceof Error ? error.message : "Save failed",
      });
    }
  };

  /** Drain the queue, one write at a time, until nothing is left. */
  const drain = async (): Promise<void> => {
    while (pending.size > 0 && !stopped) {
      await writeOnce();
      // A failure that is not a conflict leaves the batch re-queued; draining
      // again immediately would spin. The next edit, or an explicit flush,
      // retries it.
      if (status.state === "failed") break;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      writing = (writing ?? Promise.resolve()).then(drain);
    }, debounceMs);
  };

  return {
    queue(path, bytes) {
      if (stopped) return;
      pending.set(path, bytes);
      if (status.state !== "saving") {
        publish({ state: "pending", revision: status.revision });
      }
      schedule();
    },

    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Chained onto any write already running: starting a second one
      // concurrently is the race this whole module exists to avoid.
      writing = (writing ?? Promise.resolve()).then(drain);
      await writing;
    },

    status() {
      return status;
    },

    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
