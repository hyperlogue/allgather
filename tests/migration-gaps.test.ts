import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SCHEMA_VERSION } from "../server/storage.ts";
import { migrateTaskSchema } from "../server/task-schema-migration.ts";
import { restoreSessionSchema31 } from "./fixtures/session-schema.ts";

test("later task schemas backfill missing access and identity migrations without losing version or work", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-migration-gaps-"));
  const path = join(root, "state.sqlite");
  let db = openDatabase(path);
  try {
    db.query(
      "INSERT INTO projects(id,name,description,slug,created_at) VALUES('project','Retained','','KEEP','2026-01-01')",
    ).run();
    restoreSessionSchema31(db);
    migrateTaskSchema(db);
    db.exec("DROP TABLE cli_pairings; PRAGMA user_version=38;");
    db.close();
    db = openDatabase(path);
    const backups = readdirSync(root).filter((name) => name.includes(".before-v38-"));
    expect(backups).toHaveLength(1);
    for (const name of ["cli_pairings", "session_identities", "client_activity", "passkeys"])
      expect(
        db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
      ).toBeTruthy();
    expect(db.query("SELECT name,slug FROM projects WHERE id='project'").get()).toEqual({
      name: "Retained",
      slug: "KEEP",
    });
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    db = openDatabase(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.query("SELECT COUNT(*) n FROM projects").get()).toEqual({ n: 1 });
    expect(readdirSync(root).filter((name) => name.includes(".before-v38-"))).toEqual(backups);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
