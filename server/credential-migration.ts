import type { Database } from "bun:sqlite";

export function migrateCredentials(db: Database) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE login_tokens ADD COLUMN expires_at TEXT;
      ALTER TABLE login_tokens ADD COLUMN consumed_at TEXT;
      DELETE FROM settings WHERE key='owner_key_hash';
      DELETE FROM sessions;
      UPDATE login_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
      DELETE FROM oauth_codes;
      UPDATE worker_registrations SET state='retired' WHERE principal='owner';
      PRAGMA user_version=21;
    `);
  }).immediate();
}

export function migratePasskeys(db: Database) {
  db.transaction(() =>
    db.exec(`
    CREATE TABLE passkeys(
      id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
      user_handle TEXT NOT NULL, label TEXT NOT NULL, transports TEXT NOT NULL,
      device_type TEXT NOT NULL, backed_up INTEGER NOT NULL, created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE TABLE passkey_challenges(
      hash TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('register','authenticate')),
      link_id TEXT REFERENCES login_tokens(id), expires_at TEXT NOT NULL
    );
    ALTER TABLE sessions ADD COLUMN passkey_id TEXT REFERENCES passkeys(id);
    ALTER TABLE sessions ADD COLUMN last_used_at TEXT;
    DELETE FROM sessions;
    UPDATE login_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE revoked_at IS NULL;
    PRAGMA user_version=35;
  `),
  ).immediate();
}
