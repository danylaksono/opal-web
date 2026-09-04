/**
 * Stored-project schema and its migrations (PLAN.md 6.2).
 *
 * Migrations are forward-only and run before a project opens, because a record
 * written by an older build is the normal case for a product that updates
 * itself underneath the user: a tab that has been open for a week writes v1
 * while the service worker has already installed v2.
 *
 * Two rules keep that safe, and both are enforced here rather than trusted:
 *
 * - **A record from the future is not migrated, it is refused.** Downgrading is
 *   guesswork, and guessing at someone's only copy of a document is the wrong
 *   trade. An older build that meets a newer record should say so and leave it
 *   alone.
 * - **Every step is total.** A migration takes any valid record at version *n*
 *   and produces one at *n+1*, so the chain composes and no step needs to know
 *   which version the record started at.
 */

import type { StoredProject } from "./repository";

/**
 * The schema this build writes.
 *
 * Raise it in the same commit that adds a migration to `MIGRATIONS`, and never
 * change what an existing version means — a released version number is a fact
 * about records on disk, not a label this repository controls any more.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/** A record as it was found, before migration says what it is. */
export type UnknownProjectRecord = Record<string, unknown> & {
  schemaVersion?: unknown;
};

export class UnsupportedSchemaError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `Project was written by a newer version of Opal Web ` +
        `(schema ${found}, this build understands ${supported}). ` +
        "Update the app rather than opening it here.",
    );
    this.name = "UnsupportedSchemaError";
    this.found = found;
    this.supported = supported;
  }
}

export class CorruptProjectRecordError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Project record is unusable: ${reason}`);
    this.name = "CorruptProjectRecordError";
    this.reason = reason;
  }
}

/**
 * One step, from `version` to `version + 1`.
 *
 * There are none yet — version 1 is the first released schema. The array and
 * its test exist from the start so that adding the first real migration is an
 * ordinary change rather than the moment the mechanism gets designed, which is
 * historically when it gets designed badly.
 */
const MIGRATIONS: readonly ((
  record: UnknownProjectRecord,
) => UnknownProjectRecord)[] = [];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Check the fields every version has had, after migration has run.
 *
 * Deliberately shallow: this guards against a truncated or foreign record, not
 * against every way a field could be wrong. A record that has an id, a title
 * and a revision can be listed and opened, and anything stricter would refuse
 * projects a user could otherwise still get their files out of.
 */
function assertUsable(
  record: UnknownProjectRecord,
): asserts record is Record<string, unknown> {
  if (!isNonEmptyString(record.id)) {
    throw new CorruptProjectRecordError("no id");
  }
  if (typeof record.title !== "string") {
    throw new CorruptProjectRecordError("no title");
  }
  if (
    typeof record.revision !== "number" ||
    !Number.isFinite(record.revision)
  ) {
    throw new CorruptProjectRecordError("no revision");
  }
}

/**
 * Bring a stored record up to `CURRENT_SCHEMA_VERSION`.
 *
 * A record with no `schemaVersion` is treated as version 1 rather than
 * rejected: the field was introduced with the first schema, so its absence
 * means "written before anyone thought to write it", which is a record from a
 * pre-release build and not a corrupt one.
 */
export function migrateProject(record: UnknownProjectRecord): StoredProject {
  const found =
    typeof record.schemaVersion === "number" ? record.schemaVersion : 1;

  if (!Number.isInteger(found) || found < 1) {
    throw new CorruptProjectRecordError(
      `schema version ${JSON.stringify(record.schemaVersion)}`,
    );
  }
  if (found > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(found, CURRENT_SCHEMA_VERSION);
  }

  let migrated = record;
  for (let version = found; version < CURRENT_SCHEMA_VERSION; version++) {
    const step = MIGRATIONS[version - 1];
    if (!step) {
      // A gap here means CURRENT_SCHEMA_VERSION was raised without adding the
      // migration that justifies it. Failing loudly beats opening the project
      // and writing back a record that claims a shape it does not have.
      throw new CorruptProjectRecordError(
        `no migration from schema ${version} to ${version + 1}`,
      );
    }
    migrated = step(migrated);
  }

  assertUsable(migrated);
  return {
    ...migrated,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  } as unknown as StoredProject;
}
