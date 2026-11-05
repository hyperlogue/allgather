import type { Database } from "bun:sqlite";
export function migrateNotifications(db: Database) {
  db.transaction(() => {
    db.exec(`
 CREATE TABLE artifact_notifications(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,registration_id TEXT NOT NULL REFERENCES worker_registrations(id),session_id TEXT NOT NULL REFERENCES agent_sessions(id),fingerprint TEXT NOT NULL,event TEXT NOT NULL CHECK(event IN ('submitted','archived')),body TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','sending','sent','unknown','failed')),machine_id TEXT REFERENCES machines(id),tower_id TEXT,receipt TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(artifact_id,registration_id,fingerprint,event));
 PRAGMA user_version=9;
 `);
  }).immediate();
}
