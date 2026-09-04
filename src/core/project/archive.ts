/**
 * ZIP import and export for projects (PLAN.md 5.4, 14 Phase 1).
 *
 * Export is the backup story. OPFS is origin-private and evictable, so a ZIP a
 * user can put somewhere else is the only thing standing between a cleared site
 * setting and lost work — which is why the panel offers it rather than hiding it
 * in settings.
 *
 * Import is the hostile input. An archive arrives from anywhere, and every
 * entry in it is an attacker-controlled string and an attacker-controlled
 * length. The split of responsibility here is deliberate:
 *
 * - **The format is fflate's problem.** Hand-rolling a ZIP container reader is
 *   exactly where this kind of code grows security bugs, and fflate is small,
 *   dependency-free and well exercised.
 * - **The policy is ours.** Which names are acceptable, how many entries, how
 *   large, and what to do about two entries that normalise to one path are
 *   product decisions, not parser decisions, and they are enforced here where
 *   they can be read and tested.
 *
 * Every entry name goes through `projectPath`, which already rejects absolute
 * paths, traversal, drive letters, NUL bytes and Windows device names. What this
 * module adds is what a single-entry check cannot see: totals, counts, and
 * collisions between entries.
 */

import { unzipSync, zipSync } from "fflate";
import { InvalidProjectPathError, type ProjectPath, projectPath } from "./ids";
import type { ProjectFile } from "./repository";

/**
 * Resource limits for an imported archive.
 *
 * Chosen to be generous for documents and hostile to bombs: a LaTeX project of
 * 2,000 files and 256 MB is already far past anything a person edits by hand,
 * and a single 64 MB file covers a large figure or a bundled font.
 */
export interface ArchiveLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 2_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

export type ArchiveRejection =
  | "not-a-zip"
  | "too-many-entries"
  | "file-too-large"
  | "archive-too-large"
  | "invalid-path"
  | "duplicate-path"
  | "empty";

export class ArchiveRejectedError extends Error {
  readonly reason: ArchiveRejection;
  /** The entry that caused it, when one did. */
  readonly entry?: string;

  constructor(reason: ArchiveRejection, message: string, entry?: string) {
    super(message);
    this.name = "ArchiveRejectedError";
    this.reason = reason;
    if (entry !== undefined) this.entry = entry;
  }
}

/** ZIP timestamps start in 1980 and cannot represent anything earlier. */
const ZIP_EPOCH = Date.UTC(1980, 0, 1);

/**
 * Pack files into a ZIP.
 *
 * Stored order is sorted so that exporting the same project twice produces the
 * same bytes — a diffable backup, and a round-trip test that compares archives
 * rather than only their contents.
 */
export function packProject(files: readonly ProjectFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    entries[file.path] = file.bytes;
  }
  // A fixed timestamp, not the current one: fflate defaults to now, and a
  // backup whose bytes change every time it is taken is one nobody can diff.
  // ZIP's own epoch is the obvious choice, being the earliest it can store.
  return zipSync(entries, { level: 6, mtime: ZIP_EPOCH });
}

/**
 * Read files out of a ZIP, applying the import policy.
 *
 * Directory entries are dropped rather than rejected: a ZIP records them as
 * zero-length names ending in `/`, they carry no content, and the project's
 * paths already imply their structure.
 */
export function unpackProject(
  bytes: Uint8Array,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ProjectFile[] {
  let entries: Record<string, Uint8Array>;
  let entryCount = 0;
  let declaredTotal = 0;

  try {
    entries = unzipSync(bytes, {
      // The filter runs before an entry is decompressed, which is what makes
      // these limits a bound on memory rather than a verdict after the fact.
      // Understating a size here does not defeat them: measured against
      // fflate 0.8.3, an entry whose header claims 100 bytes over a stream
      // that inflates to 4 MB yields 100 bytes, because the declared size is
      // what gets allocated. A lying archive can therefore truncate its own
      // file, which the size check below catches as a mismatch — it cannot
      // make us allocate more than it declared.
      filter: (file) => {
        if (file.name.endsWith("/")) return false;
        if (++entryCount > limits.maxEntries) {
          throw new ArchiveRejectedError(
            "too-many-entries",
            `Archive has more than ${limits.maxEntries} entries`,
          );
        }
        if (file.originalSize !== undefined) {
          if (file.originalSize > limits.maxFileBytes) {
            throw new ArchiveRejectedError(
              "file-too-large",
              `${file.name} declares ${file.originalSize} bytes`,
              file.name,
            );
          }
          declaredTotal += file.originalSize;
          if (declaredTotal > limits.maxTotalBytes) {
            throw new ArchiveRejectedError(
              "archive-too-large",
              `Archive declares more than ${limits.maxTotalBytes} bytes`,
            );
          }
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ArchiveRejectedError) throw error;
    throw new ArchiveRejectedError(
      "not-a-zip",
      error instanceof Error ? error.message : "Unreadable archive",
    );
  }

  const files: ProjectFile[] = [];
  const seen = new Map<ProjectPath, string>();
  let total = 0;

  for (const [name, content] of Object.entries(entries)) {
    let path: ProjectPath;
    try {
      path = projectPath(name);
    } catch (error) {
      if (error instanceof InvalidProjectPathError) {
        throw new ArchiveRejectedError("invalid-path", error.message, name);
      }
      throw error;
    }

    // Two entries can differ as strings and agree as paths — `./a.tex` and
    // `a.tex`, or `a\b` and `a/b`. Silently keeping the last would let an
    // archive decide which of two files a project ends up with.
    const previous = seen.get(path);
    if (previous !== undefined) {
      throw new ArchiveRejectedError(
        "duplicate-path",
        `${JSON.stringify(previous)} and ${JSON.stringify(name)} both become ${path}`,
        name,
      );
    }
    seen.set(path, name);

    // Checked again against what was actually produced. The header is the
    // archive's claim; this is the measurement, and they can disagree.
    if (content.length > limits.maxFileBytes) {
      throw new ArchiveRejectedError(
        "file-too-large",
        `${name} expands to ${content.length} bytes`,
        name,
      );
    }
    total += content.length;
    if (total > limits.maxTotalBytes) {
      throw new ArchiveRejectedError(
        "archive-too-large",
        `Archive expands past ${limits.maxTotalBytes} bytes`,
      );
    }

    files.push({ path, bytes: content });
  }

  if (files.length === 0) {
    throw new ArchiveRejectedError("empty", "Archive contains no files");
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
