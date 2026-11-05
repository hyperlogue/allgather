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
