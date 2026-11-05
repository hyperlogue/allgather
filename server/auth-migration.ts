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

export function migrateResourceGrants(db: Database) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE oauth_grants(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES oauth_clients(id),resource TEXT NOT NULL,scopes TEXT NOT NULL,resources TEXT NOT NULL,created_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      ALTER TABLE oauth_tokens ADD COLUMN grant_id TEXT REFERENCES oauth_grants(id);
      ALTER TABLE agent_sessions ADD COLUMN project_id TEXT REFERENCES projects(id);
      UPDATE oauth_tokens SET revoked=1;
      DELETE FROM oauth_codes;
      PRAGMA user_version=24;
    `);
  }).immediate();
}
