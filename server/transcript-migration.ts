import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
export function migrateTranscriptContent(db: Database) {
  db.transaction(() => {
    db.exec(`
    DROP TRIGGER session_events_immutable;
    CREATE TABLE session_event_content(id TEXT PRIMARY KEY REFERENCES session_events(id),payload TEXT,deleted_at TEXT,CHECK((payload IS NULL)=(deleted_at IS NOT NULL)));
    INSERT INTO session_event_content SELECT id,payload,NULL FROM session_events;
    ALTER TABLE session_events RENAME COLUMN payload TO payload_hash;
  `);
    const update = db.query("UPDATE session_events SET payload_hash=? WHERE id=?");
    for (const row of db.query("SELECT id,payload FROM session_event_content").all() as {
      id: string;
      payload: string;
    }[])
      update.run(createHash("sha256").update(row.payload).digest("hex"), row.id);
    db.exec(`
    CREATE TRIGGER session_events_immutable BEFORE UPDATE ON session_events BEGIN SELECT RAISE(ABORT,'Session events are append-only'); END;
    CREATE TRIGGER session_event_content_immutable BEFORE UPDATE ON session_event_content WHEN NEW.id IS NOT OLD.id OR OLD.payload IS NULL OR NEW.payload IS NOT NULL OR NEW.deleted_at IS NULL BEGIN SELECT RAISE(ABORT,'Captured content can only be deleted once'); END;
    CREATE TRIGGER session_event_content_retained BEFORE DELETE ON session_event_content BEGIN SELECT RAISE(ABORT,'Retain deleted event identity'); END;
    CREATE TABLE session_asset_identity(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,deleted_at TEXT);
    INSERT INTO session_asset_identity(id) SELECT id FROM session_assets ORDER BY created_at,id;
    CREATE TRIGGER session_asset_retired AFTER DELETE ON session_assets BEGIN UPDATE session_asset_identity SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=OLD.id; END;
    CREATE TRIGGER session_asset_no_revival BEFORE INSERT ON session_assets WHEN EXISTS(SELECT 1 FROM session_asset_identity WHERE id=NEW.id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Deleted assets cannot be restored by upload replay'); END;
    CREATE TABLE transcript_deletions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES agent_sessions(id),through_sequence INTEGER NOT NULL,through_asset_sequence INTEGER NOT NULL,event_count INTEGER NOT NULL,asset_count INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
    PRAGMA user_version=29;
  `);
  }).immediate();
}
