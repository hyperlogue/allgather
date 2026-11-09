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
  db.exec("DROP TABLE client_activity; PRAGMA user_version=31;");
}
