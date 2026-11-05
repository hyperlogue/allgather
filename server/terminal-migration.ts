import type { Database } from "bun:sqlite";

export function migrateTerminalSessions(db: Database) {
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      const objects = db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE tbl_name='transcript_sources' AND type IN ('index','trigger') AND sql IS NOT NULL",
        )
        .all();
      db.exec(`
        ALTER TABLE machines ADD COLUMN terminal_controls TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE machines ADD COLUMN active_credential_id TEXT REFERENCES tower_credentials(id);
        CREATE TABLE transcript_sources_v18(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES agent_sessions(id),runtime_id TEXT REFERENCES session_runtimes(id),kind TEXT NOT NULL CHECK(kind IN ('acp_stream','native_import','terminal_lifecycle')),source_key TEXT NOT NULL,format_version TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,coverage TEXT NOT NULL CHECK(coverage IN ('complete','partial','unknown')),created_at TEXT NOT NULL,UNIQUE(session_id,kind,source_key));
        INSERT INTO transcript_sources_v18 SELECT * FROM transcript_sources;
        DROP TABLE transcript_sources;
        ALTER TABLE transcript_sources_v18 RENAME TO transcript_sources;
      `);
      for (const object of objects) db.exec(object.sql);
      if (db.query("PRAGMA foreign_key_check").all().length)
        throw new Error("Terminal migration would break retained references");
      db.exec("PRAGMA user_version=18");
    }).immediate();
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}
