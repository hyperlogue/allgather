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

export function migrateClientAudiences(db: Database) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE oauth_clients ADD COLUMN audience TEXT NOT NULL DEFAULT 'mcp' CHECK(audience IN ('mcp','api'));
      UPDATE oauth_clients SET revoked=1;
      UPDATE oauth_tokens SET revoked=1;
      DELETE FROM oauth_codes;
      PRAGMA user_version=22;
    `);
  }).immediate();
}

export function migrateGranularScopes(db: Database) {
  db.transaction(() => {
    db.exec(`
      UPDATE oauth_tokens SET revoked=1;
      DELETE FROM oauth_codes;
      PRAGMA user_version=23;
    `);
  }).immediate();
}
