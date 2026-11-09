import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { resolveSession, SessionIdentity } from "../server/session-identity.ts";
import { migrateSessionIdentity } from "../server/session-identity-migration.ts";

function previous() {
  const db = new Database(":memory:");
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE projects(id TEXT PRIMARY KEY);
    CREATE TABLE roles(id TEXT PRIMARY KEY);
    CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT,project_id TEXT);
    CREATE TABLE machines(id TEXT PRIMARY KEY);
    CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,agent_type TEXT NOT NULL,source_namespace TEXT,native_session_id TEXT,label TEXT,role_id TEXT REFERENCES roles(id),revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,project_id TEXT REFERENCES projects(id),UNIQUE(source_namespace,native_session_id));
    CREATE INDEX original_session_label ON agent_sessions(label);
    CREATE TABLE session_aliases(alias TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES agent_sessions(id));
    CREATE TABLE session_runtimes(id TEXT PRIMARY KEY,session_id TEXT REFERENCES agent_sessions(id),native_session_id TEXT,termination TEXT,state TEXT);
    CREATE TABLE transcript_sources(id TEXT PRIMARY KEY,session_id TEXT REFERENCES agent_sessions(id),kind TEXT,source_key TEXT);
    CREATE TABLE session_events(id TEXT PRIMARY KEY,session_id TEXT REFERENCES agent_sessions(id),sequence INTEGER,source_id TEXT REFERENCES transcript_sources(id),source_sequence INTEGER,payload_hash TEXT);
    CREATE TRIGGER session_events_immutable BEFORE UPDATE ON session_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TABLE transcript_deletions(sequence INTEGER PRIMARY KEY,session_id TEXT REFERENCES agent_sessions(id));
    CREATE TABLE tower_records(machine_id TEXT REFERENCES machines(id),tower_id TEXT,record TEXT,observed_at TEXT);
    CREATE TABLE retained_claims(id TEXT PRIMARY KEY,session_id TEXT REFERENCES agent_sessions(id));
    INSERT INTO agent_sessions(id,agent_type,source_namespace,native_session_id,label,created_at,updated_at) VALUES
      ('codex:native','codex','legacy','codex:native','codex:native','2026-01-01','2026-01-01'),
      ('imported','codex','native-import','native','Imported label','2026-01-02','2026-01-02');
    INSERT INTO entities SELECT id,'session',NULL FROM agent_sessions;
    INSERT INTO session_aliases VALUES('old-import-alias','imported');
    INSERT INTO transcript_sources VALUES('source-a','codex:native','native_import','export'),('source-b','imported','native_import','export');
    INSERT INTO session_events VALUES('event-a','codex:native',1,'source-a',1,'hash-a'),('event-b','imported',1,'source-b',1,'hash-b');
    INSERT INTO retained_claims VALUES('claim','imported');
    PRAGMA user_version=31;
  `);
  return db;
}
test("v31 sessions reconcile without rewriting retained event, alias-source or foreign-key evidence", () => {
  const db = previous();
  try {
    db.exec(`INSERT INTO machines VALUES('fixture-machine');
      INSERT INTO tower_records VALUES('fixture-machine','existing','{"harness":"codex","native_session_id":"native"}','2026-01-03'),
      ('fixture-machine','new','{"harness":"claude-code","native_session_id":"another-native"}','2026-01-03');`);
    const before = db.query("SELECT * FROM session_events ORDER BY id").all();
    migrateSessionIdentity(db);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 32 });
    expect(resolveSession(db, "imported")).toBe("codex:native");
    expect(resolveSession(db, "old-import-alias")).toBe("codex:native");
    const identity = new SessionIdentity(
      db,
      () => "2026-01-03",
      () => {},
    );
    expect(identity.physical("old-import-alias")).toBe("imported");
    expect(identity.describe("codex:native")?.observations?.[0]).toMatchObject({
      machine_id: "fixture-machine",
      tower_id: "existing",
    });
    expect(
      db.query("SELECT provider FROM session_identities WHERE native_id='another-native'").get(),
    ).toEqual({ provider: "claude" });
    expect(db.query("SELECT * FROM session_events ORDER BY id").all()).toEqual(before);
    expect(
      db.query("SELECT event_id,session_id,sequence FROM session_timeline ORDER BY sequence").all(),
    ).toEqual([
      { event_id: "event-a", session_id: "codex:native", sequence: 1 },
      { event_id: "event-b", session_id: "codex:native", sequence: 2 },
    ]);
    expect(db.query("SELECT session_id FROM retained_claims").get()).toEqual({
      session_id: "imported",
    });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.exec("UPDATE session_events SET payload_hash='changed'")).toThrow("immutable");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name='original_session_label'").get(),
    ).toBeTruthy();
    const beforeAgain = db.query("SELECT * FROM session_timeline ORDER BY sequence").all();
    identity.register("imported", "codex", "native");
    expect(db.query("SELECT * FROM session_timeline ORDER BY sequence").all()).toEqual(beforeAgain);
    expect(identity.warnings("codex:native").some((w) => w.field === "transcript_source")).toBe(
      true,
    );
  } finally {
    db.close();
  }
});
test("failed reconciliation upgrade rolls back the original schema and data", () => {
  const db = previous();
  try {
    db.exec(
      "PRAGMA foreign_keys=OFF; UPDATE agent_sessions SET project_id='missing' WHERE id='imported'; PRAGMA foreign_keys=ON;",
    );
    expect(() => migrateSessionIdentity(db)).toThrow("retained references");
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 31 });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name='session_identities'").get(),
    ).toBeNull();
    expect(db.query("SELECT COUNT(*) n FROM agent_sessions").get()).toEqual({ n: 2 });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  } finally {
    db.close();
  }
});
