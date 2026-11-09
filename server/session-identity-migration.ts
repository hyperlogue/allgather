import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { inferredSessionIdentity, SessionIdentity, sessionProvider } from "./session-identity.ts";

export function migrateSessionIdentity(db: Database) {
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      const definition = (
        db
          .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_sessions'")
          .get() as { sql: string }
      ).sql;
      const objects = db
        .query(
          "SELECT sql FROM sqlite_master WHERE tbl_name='agent_sessions' AND type IN ('index','trigger') AND sql IS NOT NULL",
        )
        .all() as { sql: string }[];
      const rebuilt = definition
        .replace(
          /CREATE TABLE (?:"agent_sessions"|agent_sessions)/,
          "CREATE TABLE agent_sessions_v32",
        )
        .replace(/,\s*UNIQUE\s*\(source_namespace\s*,\s*native_session_id\)/, "");
      if (rebuilt === definition || rebuilt.includes("UNIQUE(source_namespace"))
        throw new Error("Unexpected session identity schema");
      db.exec(rebuilt);
      db.exec(`INSERT INTO agent_sessions_v32 SELECT * FROM agent_sessions;
        DROP TABLE agent_sessions;
        ALTER TABLE agent_sessions_v32 RENAME TO agent_sessions;
        ALTER TABLE agent_sessions ADD COLUMN merged_into TEXT REFERENCES agent_sessions(id) CHECK(merged_into IS NULL OR merged_into!=id);
        ALTER TABLE agent_sessions ADD COLUMN native_provider TEXT;
        ALTER TABLE agent_sessions ADD COLUMN timeline_revision INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX session_canonical_members ON agent_sessions(merged_into);
        CREATE INDEX session_group_lookup ON agent_sessions(COALESCE(merged_into,id));
        CREATE INDEX runtime_session_lookup ON session_runtimes(session_id);
        CREATE INDEX transcript_deletion_session ON transcript_deletions(session_id,sequence);
        CREATE TABLE session_alias_origins(alias TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES agent_sessions(id));
        INSERT INTO session_alias_origins SELECT alias,session_id FROM session_aliases;
        CREATE TRIGGER session_alias_origin AFTER INSERT ON session_aliases BEGIN INSERT OR IGNORE INTO session_alias_origins VALUES(NEW.alias,NEW.session_id); END;
        CREATE VIEW session_members AS SELECT id member_id,COALESCE(merged_into,id) session_id FROM agent_sessions;
        CREATE TABLE session_identities(provider TEXT NOT NULL,native_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES agent_sessions(id),PRIMARY KEY(provider,native_id));
        CREATE INDEX session_identity_canonical ON session_identities(session_id);
        CREATE TABLE session_identity_warnings(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES agent_sessions(id),fingerprint TEXT NOT NULL,field TEXT NOT NULL,message TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(session_id,fingerprint));
        CREATE TABLE session_project_scopes(session_id TEXT NOT NULL REFERENCES agent_sessions(id),project_id TEXT REFERENCES projects(id));
        CREATE UNIQUE INDEX session_project_scope ON session_project_scopes(session_id,COALESCE(project_id,''));
        INSERT INTO session_project_scopes SELECT id,project_id FROM agent_sessions;
        CREATE TRIGGER session_project_scope_insert AFTER INSERT ON agent_sessions BEGIN INSERT OR IGNORE INTO session_project_scopes VALUES(NEW.id,NEW.project_id); END;
        CREATE TRIGGER session_project_scope_update AFTER UPDATE OF project_id ON agent_sessions BEGIN INSERT OR IGNORE INTO session_project_scopes VALUES(NEW.id,NEW.project_id); END;
        CREATE TABLE session_tower_links(machine_id TEXT NOT NULL REFERENCES machines(id),tower_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES agent_sessions(id),fingerprint TEXT NOT NULL,PRIMARY KEY(machine_id,tower_id));
        CREATE INDEX session_tower_canonical ON session_tower_links(session_id);
        CREATE TABLE session_timeline(event_id TEXT PRIMARY KEY REFERENCES session_events(id),session_id TEXT NOT NULL REFERENCES agent_sessions(id),sequence INTEGER NOT NULL,UNIQUE(session_id,sequence));
        INSERT INTO session_timeline SELECT id,session_id,sequence FROM session_events;
        CREATE TRIGGER session_timeline_insert AFTER INSERT ON session_events BEGIN
          INSERT INTO session_timeline(event_id,session_id,sequence)
          SELECT NEW.id,m.session_id,COALESCE((SELECT MAX(sequence) FROM session_timeline WHERE session_id=m.session_id),0)+1 FROM session_members m WHERE m.member_id=NEW.session_id;
        END;
      `);
      for (const object of objects) db.exec(object.sql);
      const identity = new SessionIdentity(
        db,
        () => new Date().toISOString(),
        () => {},
      );
      const rows = db
        .query(
          "SELECT id,agent_type,native_session_id,source_namespace FROM agent_sessions ORDER BY created_at,id",
        )
        .all() as {
        id: string;
        agent_type: string;
        native_session_id: string | null;
        source_namespace: string | null;
      }[];
      for (const row of rows) {
        const inferred = inferredSessionIdentity(row.id, row.agent_type);
        if (row.source_namespace === "legacy" && row.native_session_id === row.id && inferred) {
          db.query("UPDATE agent_sessions SET native_session_id=? WHERE id=?").run(
            inferred.native_id,
            row.id,
          );
          row.native_session_id = inferred.native_id;
        }
        const provider = sessionProvider(row.agent_type) ?? inferred?.provider;
        const native = row.native_session_id ?? inferred?.native_id;
        if (provider && native) identity.register(row.id, provider, native);
      }
      const runtimes = db
        .query(
          "SELECT r.session_id,s.agent_type,r.native_session_id FROM session_runtimes r JOIN agent_sessions s ON s.id=r.session_id WHERE r.native_session_id IS NOT NULL ORDER BY r.rowid",
        )
        .all() as { session_id: string; agent_type: string; native_session_id: string }[];
      for (const runtime of runtimes)
        identity.register(runtime.session_id, runtime.agent_type, runtime.native_session_id);
      const records = db
        .query(
          "SELECT machine_id,tower_id,record FROM tower_records ORDER BY observed_at,machine_id,tower_id",
        )
        .all() as { machine_id: string; tower_id: string; record: string }[];
      for (const row of records) {
        const record = JSON.parse(row.record),
          provider = sessionProvider(record.harness),
          native = record.native_session_id;
        if (!provider || typeof native !== "string" || !native || native.length > 160) continue;
        const match = db
          .query("SELECT session_id FROM session_identities WHERE provider=? AND native_id=?")
          .get(provider, native) as { session_id: string } | null;
        let session = match?.session_id;
        if (!session) {
          session = `session-${randomUUID()}`;
          const now = new Date().toISOString();
          db.query("INSERT INTO entities(id,kind,project_id) VALUES(?,'session',NULL)").run(
            session,
          );
          db.query(
            "INSERT INTO agent_sessions(id,agent_type,label,created_at,updated_at) VALUES(?,?,?,?,?)",
          ).run(
            session,
            String(record.harness),
            typeof record.display_name === "string" ? record.display_name : null,
            now,
            now,
          );
          session = identity.register(session, provider, native);
        }
        db.query("INSERT INTO session_tower_links VALUES(?,?,?,?)").run(
          row.machine_id,
          row.tower_id,
          session,
          createHash("sha256")
            .update(JSON.stringify([provider, native, record.display_name ?? null]))
            .digest("hex"),
        );
      }
      if (db.query("PRAGMA foreign_key_check").all().length)
        throw new Error("Session reconciliation would break retained references");
      db.exec("PRAGMA user_version=32");
    }).immediate();
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}
