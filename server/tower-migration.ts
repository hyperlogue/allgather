import type { Database } from "bun:sqlite";

export function migrateTower(db: Database) {
  db.transaction(() =>
    db.exec(`
    ALTER TABLE tower_credentials ADD COLUMN scopes TEXT NOT NULL DEFAULT '["read","send"]';
    ALTER TABLE session_runtimes ADD COLUMN owner_id TEXT;
    ALTER TABLE session_runtimes ADD COLUMN native_session_id TEXT;
    ALTER TABLE session_runtimes ADD COLUMN fenced INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_runtimes ADD COLUMN termination TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE session_runtimes ADD COLUMN active_prompt_id TEXT;
    ALTER TABLE session_runtimes ADD COLUMN loss_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_runtimes ADD COLUMN takeover_at TEXT;
    CREATE TABLE tower_enrollments(id TEXT PRIMARY KEY,poll_hash TEXT NOT NULL,host_id TEXT NOT NULL,tower_version TEXT NOT NULL,node_label TEXT NOT NULL,requested_scopes TEXT NOT NULL,scopes TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT 'pending',expires_at TEXT NOT NULL,last_poll_at TEXT,machine_id TEXT REFERENCES machines(id),credential_id TEXT REFERENCES tower_credentials(id),created_at TEXT NOT NULL);
    CREATE TABLE command_receipts(command_id TEXT PRIMARY KEY REFERENCES session_commands(id),revision INTEGER NOT NULL,body TEXT NOT NULL,fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE runtime_losses(runtime_id TEXT NOT NULL REFERENCES session_runtimes(id),loss_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(runtime_id,revision));
    CREATE TABLE private_request_metadata(request_id TEXT PRIMARY KEY REFERENCES session_requests(id),owner_id TEXT NOT NULL,source_revision INTEGER NOT NULL,native_id TEXT NOT NULL,fingerprint TEXT NOT NULL,prompt_command_id TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE command_authority(command_id TEXT PRIMARY KEY REFERENCES session_commands(id),principal TEXT NOT NULL,expires_at TEXT NOT NULL);
    UPDATE session_requests SET payload='{"redacted":true}',response=CASE WHEN response IS NULL THEN NULL ELSE '{"redacted":true}' END,state=CASE WHEN state='pending' THEN 'stale' ELSE state END;
    UPDATE session_commands SET payload='{"redacted":true}' WHERE kind='reply';
    UPDATE operations SET result=json_set(result,'$.payload',json('{"redacted":true}')) WHERE operation='session_reply' AND json_valid(result);
    PRAGMA user_version=12;
  `),
  ).immediate();
}
