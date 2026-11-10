import { Database } from "bun:sqlite";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppError } from "../shared/contracts.ts";
import { migrateArtifacts } from "./artifact-migration.ts";
import {
  migrateApprovals,
  migrateAuthentication,
  migrateClientActivity,
  migrateClientAudiences,
  migrateClientTombstones,
  migrateCliPairings,
  migrateGranularScopes,
  migrateMcpPairings,
  migrateResourceGrants,
  migrateTowerInvitations,
} from "./auth-migration.ts";
import { migrateCatalog } from "./catalog-migration.ts";
import { migrateCredentials, migratePasskeys } from "./credential-migration.ts";
import { migrateDesign } from "./design-migration.ts";
import { migrateGraphTombstones } from "./graph-migration.ts";
import { migrateNotifications } from "./notification-migration.ts";
import { migrateSessionIdentity } from "./session-identity-migration.ts";
import { migrateSessions } from "./session-migration.ts";
import { migrateTaskWorkflow } from "./task-migration.ts";
import { migrateTaskSchema } from "./task-schema-migration.ts";
import { migrateTerminalSessions } from "./terminal-migration.ts";
import { migrateTower } from "./tower-migration.ts";
import { migrateTranscriptContent } from "./transcript-migration.ts";

export const SCHEMA_VERSION = 38;
export function writeDatabaseSnapshot(db: Database, path: string) {
  const directory = mkdtempSync(join(dirname(path), ".allgather-snapshot-"));
  const staged = join(directory, "snapshot.sqlite");
  try {
    db.query("VACUUM INTO ?").run(staged);
    chmodSync(staged, 0o600);
    linkSync(staged, path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
export function snapshotDatabase(db: Database) {
  const directory = mkdtempSync(join(tmpdir(), "allgather-snapshot-"));
  const path = join(directory, "snapshot.sqlite");
  try {
    writeDatabaseSnapshot(db, path);
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    return initializeDatabase(db, path);
  } catch (error) {
    db.close();
    throw error;
  }
}
function initializeDatabase(db: Database, path: string) {
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version > SCHEMA_VERSION) {
    throw new AppError("newer_database", "This database needs a newer allgather release.");
  }
  const hasProjectSlug = db
    .query<{ name: string }, []>("PRAGMA table_info(projects)")
    .all()
    .some((column) => column.name === "slug");
  if (
    version > 0 &&
    version < 36 &&
    !hasProjectSlug &&
    db.query("SELECT 1 FROM projects LIMIT 1").get()
  ) {
    throw new AppError(
      "project_slug_upgrade_required",
      "Upgrade this database with the previous build before opening it here; the project slug backfill has been retired.",
    );
  }
  if (version > 0 && version < SCHEMA_VERSION && path !== ":memory:") {
    const backup = `${path}.before-v${version}-${Date.now()}.sqlite`;
    writeFileSync(backup, snapshotDatabase(db), { mode: 0o600, flag: "wx" });
  }
  if (version === 0)
    db.transaction(() => {
      db.exec(`
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
      CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,description TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,priority INTEGER NOT NULL,epic_id TEXT REFERENCES tasks(id),parent_id TEXT REFERENCES tasks(id),revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,claim_actor TEXT,claim_session TEXT,claim_expires TEXT,blocked_since TEXT,blocked_ms INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX tasks_project ON tasks(project_id,status,updated_at);
      CREATE TABLE dependencies(task_id TEXT NOT NULL REFERENCES tasks(id),depends_on TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(task_id,depends_on),CHECK(task_id!=depends_on));
      CREATE TABLE task_relations(task_id TEXT NOT NULL REFERENCES tasks(id),source_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,PRIMARY KEY(task_id,source_id,kind));
      CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT,task_id TEXT,action TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX events_task ON events(task_id,id);
      CREATE TABLE operations(actor TEXT NOT NULL,key TEXT NOT NULL,operation TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor,key));
      CREATE TABLE repositories(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(project_id,name));
      CREATE TABLE commits(repository_id TEXT NOT NULL REFERENCES repositories(id),id TEXT NOT NULL,parents TEXT NOT NULL,message TEXT NOT NULL,authored_at TEXT NOT NULL,committed_at TEXT NOT NULL,files TEXT NOT NULL,PRIMARY KEY(repository_id,id));
      CREATE INDEX commits_date ON commits(repository_id,committed_at);
      CREATE TABLE scans(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL REFERENCES repositories(id),source_id TEXT NOT NULL,captured_at TEXT NOT NULL,received_at TEXT NOT NULL,refs TEXT NOT NULL,reachable TEXT NOT NULL,shallow INTEGER NOT NULL,truncated INTEGER NOT NULL,error TEXT);
      CREATE TABLE sources(repository_id TEXT NOT NULL REFERENCES repositories(id),source_id TEXT NOT NULL,latest_scan TEXT NOT NULL REFERENCES scans(id),success_scan TEXT REFERENCES scans(id),PRIMARY KEY(repository_id,source_id));
      CREATE TABLE task_commits(task_id TEXT NOT NULL REFERENCES tasks(id),repository_id TEXT NOT NULL REFERENCES repositories(id),commit_id TEXT NOT NULL,PRIMARY KEY(task_id,repository_id,commit_id));
      CREATE TABLE sessions(hash TEXT PRIMARY KEY,expires TEXT NOT NULL);
      CREATE TABLE oauth_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,redirects TEXT NOT NULL,secret_hash TEXT,method TEXT NOT NULL,created_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE oauth_codes(hash TEXT PRIMARY KEY,data TEXT NOT NULL,expires TEXT NOT NULL);
      CREATE TABLE oauth_tokens(hash TEXT PRIMARY KEY,refresh_hash TEXT UNIQUE,client_id TEXT NOT NULL REFERENCES oauth_clients(id),scopes TEXT NOT NULL,expires TEXT NOT NULL,refresh_expires TEXT NOT NULL,resource TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version=1;
    `);
    }).immediate();
  if (version < 2)
    db.transaction(() => {
      db.exec(`
        ALTER TABLE repositories ADD COLUMN upstream_url TEXT;
        ALTER TABLE repositories ADD COLUMN upstream_id TEXT;
        ALTER TABLE repositories ADD COLUMN refs TEXT NOT NULL DEFAULT '["HEAD"]';
        ALTER TABLE repositories ADD COLUMN history_limit INTEGER NOT NULL DEFAULT 2000;
        ALTER TABLE repositories ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE repositories ADD COLUMN sync_requested INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE repositories ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'not_connected';
        ALTER TABLE repositories ADD COLUMN sync_error TEXT;
        ALTER TABLE repositories ADD COLUMN next_sync_at TEXT;
        ALTER TABLE repositories ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE repositories ADD COLUMN last_sync_revision INTEGER;
        ALTER TABLE repositories ADD COLUMN last_attempt_at TEXT;
        ALTER TABLE commits ADD COLUMN verified_upstream INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE commits ADD COLUMN files_complete INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE commits ADD COLUMN files_observed INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version=2;
      `);
    }).immediate();
  if (version < 3) migrateTaskWorkflow(db);
  if (version < 4)
    db.transaction(() => {
      db.exec("ALTER TABLE oauth_tokens ADD COLUMN operator_name TEXT");
      const columns = db.query("PRAGMA table_info(audit_operations)").all() as { name: string }[];
      if (!columns.some((c) => c.name === "details"))
        db.exec("ALTER TABLE audit_operations ADD COLUMN details TEXT NOT NULL DEFAULT '{}'");
      db.exec("PRAGMA user_version=4");
    }).immediate();
  if (version < 5) migrateDesign(db);
  if (version < 6) migrateAuthentication(db);
  if (version < 7) migrateSessions(db);
  if (version < 8) migrateArtifacts(db);
  if (version < 9) migrateNotifications(db);
  if (version < 10)
    db.transaction(() =>
      db.exec(
        "ALTER TABLE repositories ADD COLUMN url_aliases TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=10;",
      ),
    ).immediate();
  if (version < 11)
    db.transaction(() =>
      db.exec(
        "CREATE TABLE machine_policy_reports(machine_id TEXT PRIMARY KEY REFERENCES machines(id),requested_revision INTEGER NOT NULL,observed_at TEXT NOT NULL,body TEXT NOT NULL); PRAGMA user_version=11;",
      ),
    ).immediate();
  if (version < 12) migrateTower(db);
  if (version < 13)
    db.transaction(() =>
      db.exec(
        "ALTER TABLE machines ADD COLUMN harness_controls TEXT NOT NULL DEFAULT '{}'; ALTER TABLE session_runtimes ADD COLUMN controls TEXT; PRAGMA user_version=13;",
      ),
    ).immediate();
  if (version < 14)
    db.transaction(() =>
      db.exec(`
    CREATE TABLE runtime_takeovers(owner_action_id TEXT PRIMARY KEY REFERENCES audit_operations(id),runtime_id TEXT NOT NULL REFERENCES session_runtimes(id),generation TEXT NOT NULL,loss_id TEXT NOT NULL,loss_revision INTEGER NOT NULL,authorized_at TEXT NOT NULL,command_id TEXT UNIQUE REFERENCES session_commands(id));
    CREATE INDEX runtime_takeover_lookup ON runtime_takeovers(runtime_id,loss_revision);
    ALTER TABLE private_request_metadata ADD COLUMN source_state TEXT NOT NULL DEFAULT 'pending';
    UPDATE session_runtimes SET takeover_at=NULL;
    PRAGMA user_version=14;
  `),
    ).immediate();
  if (version < 15)
    db.transaction(() =>
      db.exec(`
    ALTER TABLE artifact_notifications ADD COLUMN command_id TEXT REFERENCES session_commands(id);
    ALTER TABLE artifact_notifications ADD COLUMN envelope TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE artifact_notifications ADD COLUMN route TEXT NOT NULL DEFAULT 'message';
    CREATE UNIQUE INDEX artifact_notification_command ON artifact_notifications(command_id) WHERE command_id IS NOT NULL;
    UPDATE artifact_notifications SET state='failed',error='This managed notification predates tracked routing; submit a new review.' WHERE state='queued' AND session_id IN (SELECT session_id FROM session_runtimes);
    PRAGMA user_version=15;
  `),
    ).immediate();
  if (version < 16)
    db.transaction(() =>
      db.exec(`
      ALTER TABLE project_repositories ADD COLUMN path_prefixes TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE project_repositories ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX project_repositories_repository ON project_repositories(repository_id,project_id);
      PRAGMA user_version=16;
    `),
    ).immediate();
  if (version < 17) migrateCatalog(db);
  if (version < 18) migrateTerminalSessions(db);
  if (version < 19)
    db.transaction(() =>
      db.exec(`
      UPDATE session_runtimes SET state='error',fenced=1,connected=0,termination='confirmed'
        WHERE state='starting' AND id IN (SELECT runtime_id FROM session_commands WHERE state='queued' AND json_type(payload,'$.takeover') IS NOT NULL);
      UPDATE session_commands SET state='failed',result='{"code":"takeover_removed"}',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE state='queued' AND json_type(payload,'$.takeover') IS NOT NULL;
      DROP TABLE runtime_takeovers;
      ALTER TABLE session_runtimes DROP COLUMN takeover_at;
      PRAGMA user_version=19;
    `),
    ).immediate();
  if (version < 20)
    db.transaction(() =>
      db.exec(`
      ALTER TABLE session_runtimes DROP COLUMN protocol_version;
      ALTER TABLE session_runtimes DROP COLUMN capabilities;
      PRAGMA user_version=20;
    `),
    ).immediate();
  if (version < 21) migrateCredentials(db);
  if (version < 22) migrateClientAudiences(db);
  if (version < 23) migrateGranularScopes(db);
  if (version < 24) migrateResourceGrants(db);
  if (version < 25) migrateApprovals(db);
  if (version < 26) migrateTowerInvitations(db);
  if (version < 27)
    db.transaction(() =>
      db.exec(`
    ALTER TABLE task_blockers ADD COLUMN resolved_comment_id TEXT REFERENCES task_comments(id);
    PRAGMA user_version=27;
  `),
    ).immediate();
  if (version < 28) migrateGraphTombstones(db);
  if (version < 29) migrateTranscriptContent(db);
  if (version < 30) migrateMcpPairings(db);
  const hasTable = (name: string) =>
    !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  let migrationBackupNeeded = version >= SCHEMA_VERSION && path !== ":memory:";
  for (const [needed, migrate] of [
    [!hasTable("cli_pairings"), migrateCliPairings],
    [!hasTable("session_identities"), migrateSessionIdentity],
    [!hasTable("client_activity"), migrateClientActivity],
    [
      !db
        .query<{ name: string }, []>("PRAGMA table_info(oauth_clients)")
        .all()
        .some((column) => column.name === "deleted_at"),
      migrateClientTombstones,
    ],
    [!hasTable("passkeys"), migratePasskeys],
  ] as const) {
    if (!needed) continue;
    if (migrationBackupNeeded) {
      const backup = `${path}.before-v${version}-${Date.now()}.sqlite`;
      writeFileSync(backup, snapshotDatabase(db), { mode: 0o600, flag: "wx" });
      migrationBackupNeeded = false;
    }
    migrate(db);
    const migrated = (db.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (version > migrated) db.exec(`PRAGMA user_version=${version}`);
  }
  if (version < 36)
    db.transaction(() => {
      if (!hasProjectSlug)
        db.exec(`
        ALTER TABLE projects ADD COLUMN slug TEXT;
        ALTER TABLE projects ADD COLUMN task_sequence INTEGER NOT NULL DEFAULT 0;
        CREATE UNIQUE INDEX project_slug_unique ON projects(slug);
        CREATE TRIGGER project_slug_required BEFORE INSERT ON projects WHEN NEW.slug IS NULL OR length(NEW.slug) NOT BETWEEN 1 AND 16 OR NEW.slug GLOB '*[^A-Z0-9]*' OR NEW.slug NOT GLOB '[A-Z]*' BEGIN SELECT RAISE(ABORT,'Invalid project slug'); END;
        CREATE TRIGGER project_slug_immutable BEFORE UPDATE OF slug ON projects WHEN NEW.slug IS NOT OLD.slug BEGIN SELECT RAISE(ABORT,'Project slug is immutable'); END;
      `);
      db.exec("PRAGMA user_version=36");
    }).immediate();
  if (version < 37) migrateTaskSchema(db);
  if (version < 38)
    db.transaction(() =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS project_icons(
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg')),
        hash TEXT NOT NULL CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
        bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 1048576)
      );
      PRAGMA user_version=38;
    `),
    ).immediate();
  return db;
}
export function setting(db: Database, key: string) {
  return (db.query("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | null)
    ?.value;
}
export function setSetting(db: Database, key: string, value: string) {
  db.query(
    "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
}
