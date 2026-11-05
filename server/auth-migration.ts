import type { Database } from "bun:sqlite";
export function migrateAuthentication(db: Database) {
  db.transaction(() => {
    db.exec(`
 CREATE TABLE login_tokens(id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,label TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT NOT NULL,revoked_at TEXT);
 ALTER TABLE sessions ADD COLUMN token_id TEXT REFERENCES login_tokens(id);
 PRAGMA user_version=6;
`);
  }).immediate();
}
