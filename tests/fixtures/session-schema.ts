import type { Database } from "bun:sqlite";
import { restoreTaskSchema36 } from "./task-schema.ts";

export function restoreBrowserSchema34(db: Database) {
  restoreTaskSchema36(db);
  db.exec(
    `DELETE FROM sessions; ALTER TABLE sessions DROP COLUMN passkey_id; ALTER TABLE sessions DROP COLUMN last_used_at; DROP TABLE passkey_challenges; DROP TABLE passkeys; PRAGMA user_version=34;`,
  );
}
export function restoreClientSchema33(db: Database) {
  restoreBrowserSchema34(db);
  db.exec(
    `DROP TRIGGER client_tombstone_no_revival; DROP TRIGGER client_tombstone_retained; ALTER TABLE oauth_clients DROP COLUMN deleted_at; PRAGMA user_version=33;`,
  );
}
export function restoreSessionSchema31(db: Database) {
  restoreClientSchema33(db);
  db.exec(`
    DROP TABLE client_activity;
    DROP TRIGGER session_alias_origin;
    DROP TRIGGER session_project_scope_insert;
    DROP TRIGGER session_project_scope_update;
    DROP TRIGGER session_timeline_insert;
    DROP TABLE session_alias_origins;
    DROP TABLE session_identities;
    DROP TABLE session_identity_warnings;
    DROP TABLE session_project_scopes;
    DROP TABLE session_tower_links;
    DROP TABLE session_timeline;
    DROP VIEW session_members;
    DROP INDEX session_canonical_members;
    DROP INDEX session_group_lookup;
    DROP INDEX runtime_session_lookup;
    DROP INDEX transcript_deletion_session;
    ALTER TABLE agent_sessions DROP COLUMN merged_into;
    ALTER TABLE agent_sessions DROP COLUMN native_provider;
    ALTER TABLE agent_sessions DROP COLUMN timeline_revision;
    CREATE UNIQUE INDEX session_native_namespace ON agent_sessions(source_namespace,native_session_id);
    PRAGMA user_version=31;
  `);
}
