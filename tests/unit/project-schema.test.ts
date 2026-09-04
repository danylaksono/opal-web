import { describe, expect, it } from "vitest";
import {
  CorruptProjectRecordError,
  CURRENT_SCHEMA_VERSION,
  migrateProject,
  UnsupportedSchemaError,
} from "@/core/project/schema";

/** A record as the current build writes one. */
function record(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: "8f14e45f-ea20-4a1b-9e2f-000000000000",
    title: "Thesis",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    revision: 3,
    fileCount: 2,
    byteSize: 120,
    ...overrides,
  };
}

describe("migrateProject", () => {
  it("passes a current record through unchanged", () => {
    const migrated = migrateProject(record());
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.title).toBe("Thesis");
    expect(migrated.revision).toBe(3);
  });

  it("treats a record with no schema version as the first schema", () => {
    // The field arrived with schema 1, so its absence means a pre-release
    // record rather than a damaged one.
    const { schemaVersion: _omitted, ...withoutVersion } = record();
    expect(migrateProject(withoutVersion).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
  });

  it("refuses a record from a newer build rather than guessing", () => {
    // Downgrading is guesswork, and the guess would be at someone's only copy.
    expect(() =>
      migrateProject(record({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 })),
    ).toThrow(UnsupportedSchemaError);
  });

  it("names both versions when it refuses", () => {
    try {
      migrateProject(record({ schemaVersion: 99 }));
      expect.unreachable("should have refused");
    } catch (error) {
      expect(error).toMatchObject({
        found: 99,
        supported: CURRENT_SCHEMA_VERSION,
      });
    }
  });

  it("rejects a schema version that is not a version", () => {
    expect(() => migrateProject(record({ schemaVersion: 0 }))).toThrow(
      CorruptProjectRecordError,
    );
    expect(() => migrateProject(record({ schemaVersion: 1.5 }))).toThrow(
      CorruptProjectRecordError,
    );
  });

  it("rejects a record missing the fields every version has", () => {
    const { id: _id, ...withoutId } = record();
    expect(() => migrateProject(withoutId)).toThrow(/no id/);

    const { revision: _revision, ...withoutRevision } = record();
    expect(() => migrateProject(withoutRevision)).toThrow(/no revision/);
  });

  it("accepts an empty title, which is a project the user has not named", () => {
    expect(migrateProject(record({ title: "" })).title).toBe("");
  });
});
