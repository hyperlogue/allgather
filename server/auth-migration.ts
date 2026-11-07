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

export function migrateApprovals(db: Database) {
  db.transaction(() =>
    db.exec(`
    ALTER TABLE oauth_grants ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}';
    CREATE TABLE approval_requests(
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(id), grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
      operation TEXT NOT NULL, operation_key TEXT NOT NULL, fingerprint TEXT NOT NULL, input TEXT NOT NULL, principal TEXT NOT NULL, target TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('needs_approval','approved','executing','succeeded','failed','denied','expired')),
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, result TEXT, error TEXT,
      UNIQUE(client_id,operation_key)
    );
    CREATE INDEX approval_requests_grant ON approval_requests(grant_id,created_at);
    PRAGMA user_version=25;
  `),
  ).immediate();
}

export function migrateTowerInvitations(db: Database) {
  db.transaction(() =>
    db.exec(`
    CREATE TABLE tower_invitations(id TEXT PRIMARY KEY,code_hash TEXT NOT NULL UNIQUE,machine_id TEXT REFERENCES machines(id),node_label TEXT,scopes TEXT NOT NULL,owner TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,enrollment_id TEXT UNIQUE REFERENCES tower_enrollments(id),request_fingerprint TEXT);
    UPDATE tower_credentials SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (SELECT credential_id FROM tower_enrollments WHERE state!='confirmed');
    UPDATE tower_enrollments SET state='denied' WHERE state!='confirmed';
    PRAGMA user_version=26;
  `),
  ).immediate();
}

export function migrateMcpPairings(db: Database) {
  db.transaction(() =>
    db.exec(`
      CREATE TABLE mcp_pairings(
        id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, scopes TEXT NOT NULL,
        resources TEXT NOT NULL, permissions TEXT NOT NULL, owner TEXT NOT NULL, created_at TEXT NOT NULL,
        register_until TEXT NOT NULL, expires_at TEXT NOT NULL, registrations INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0, consumed_at TEXT, client_id TEXT, revoked_at TEXT
      );
      ALTER TABLE oauth_clients ADD COLUMN pairing_id TEXT REFERENCES mcp_pairings(id);
      CREATE TABLE oauth_requests(
        hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(id),
        pairing_id TEXT NOT NULL REFERENCES mcp_pairings(id), params TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      PRAGMA user_version=30;
    `),
  ).immediate();
}
