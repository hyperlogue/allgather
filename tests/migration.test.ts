import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER } from "../server/auth.ts";
import { openDatabase, SCHEMA_VERSION } from "../server/storage.ts";
import { migrateTerminalSessions } from "../server/terminal-migration.ts";
import { Workspace } from "../server/workspace.ts";
import type { Machine, TaskContext } from "../shared/contracts.ts";
import type { CheckoutObservation } from "../shared/tower-catalog.ts";
import { fixtureOwner, fullControls } from "./fixtures/tower-controls.ts";

test("upgrading earlier task records preserves intent, original authors, and conflicting hierarchy context", () => {
  const dir = mkdtempSync(join(tmpdir(), "allgather-task-migration-")),
    path = join(dir, "data.sqlite");
  let db = new Database(path);
  try {
    db.exec(readFileSync(new URL("./fixtures/schema-v1.sql", import.meta.url), "utf8"));
    const at = "2026-01-01T00:00:00.000Z";
    db.query("INSERT INTO projects VALUES('project','Example','',1,?)").run(at);
    const add = (
      id: string,
      status: string,
      kind = "task",
      parent: string | null = null,
      epic: string | null = null,
    ) =>
      db
        .query(
          "INSERT INTO tasks(id,project_id,title,description,kind,status,priority,revision,created_at,updated_at,parent_id,epic_id) VALUES(?,'project',?,'Original intent',?,?,2,3,?,?,?,?)",
        )
        .run(id, id, kind, status, at, at, parent, epic);
    add("epic", "open", "epic");
    add("other-epic", "open", "epic");
    add("parent", "in_progress", "task", null, "epic");
    add("child", "open", "task", "parent", "epic");
    add("conflict", "open", "task", "parent", "other-epic");
    add("done", "finished");
    add("cancelled", "cancelled");
    db.exec("INSERT INTO dependencies VALUES('child','parent')");
    db.query(
      "INSERT INTO events(project_id,task_id,action,actor,at,payload) VALUES('project','child','task.note','earlier-connection',?,?)",
    ).run(at, JSON.stringify({ note: "Keep this original note" }));
    db.query(
      "INSERT INTO events(project_id,task_id,action,actor,at,payload) VALUES('project','done','task.finish','earlier-connection',?,?)",
    ).run(at, JSON.stringify({ summary: "Original completion summary" }));
    db.close();
    db = openDatabase(path);
    let w = new Workspace(db);
    expect(w.task("parent").status).toBe("open");
    expect(w.task("child").blocked).toBe(true);
    expect(w.task("epic").status).toBe("open");
    expect(w.task("done").status).toBe("done");
    expect(w.task("cancelled").status).toBe("cancelled");
    expect(w.task("child").body).toBe("Original intent");
    expect(w.task("child").revision).toBe(3);
    expect(w.task("child").parent_id).toBe("parent");
    expect(w.task("conflict").body).toContain("other-epic");
    expect(
      w.graph
        .relations("conflict")
        .some((r) => r.type === "relates_to" && r.target_id === "other-epic"),
    ).toBe(true);
    const context = w.execute("tasks_context", { task_id: "child" }, OWNER) as TaskContext;
    expect(context.comments.items[0]).toMatchObject({
      body: "Keep this original note",
      operator_name: "earlier-connection",
      operator_kind: "unknown",
      operator_id: null,
      legacy_event_id: 1,
    });
    expect(w.all("SELECT * FROM audit_operations")).toEqual([]);
    db.close();
    db = openDatabase(path);
    w = new Workspace(db);
    expect(w.all("SELECT * FROM task_comments")).toHaveLength(2);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION,
    );
    expect(w.task("conflict").parent_id).toBe("parent");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version 15 repository memberships migrate without inventing project prefixes", () => {
  const dir = mkdtempSync(join(tmpdir(), "allgather-prefix-migration-"));
  const path = join(dir, "data.sqlite");
  let db = new Database(path);
  try {
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
      CREATE TABLE repositories(id TEXT PRIMARY KEY,name TEXT,upstream_url TEXT,url_aliases TEXT);
      CREATE TABLE machines(id TEXT PRIMARY KEY);
      CREATE TABLE tower_credentials(id TEXT PRIMARY KEY,revoked_at TEXT);
      CREATE TABLE agent_sessions(id TEXT PRIMARY KEY);
      CREATE TABLE session_runtimes(id TEXT PRIMARY KEY,state TEXT,fenced INTEGER,connected INTEGER,termination TEXT,takeover_at TEXT,protocol_version TEXT,capabilities TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE session_commands(runtime_id TEXT,state TEXT,payload TEXT,result TEXT,updated_at TEXT);
      CREATE TABLE runtime_takeovers(id TEXT);
      CREATE TABLE project_repositories(project_id TEXT NOT NULL REFERENCES projects(id),repository_id TEXT NOT NULL REFERENCES repositories(id),PRIMARY KEY(project_id,repository_id));
      INSERT INTO projects VALUES('one','One'),('two','Two');
      INSERT INTO repositories VALUES('shared','Shared',NULL,'[]');
      INSERT INTO project_repositories VALUES('one','shared'),('two','shared');
      PRAGMA user_version=15;
    `);
    db.exec(
      readFileSync(new URL("./fixtures/transcript-sources-v17.sql", import.meta.url), "utf8"),
    );
    db.exec(readFileSync(new URL("./fixtures/auth-v20.sql", import.meta.url), "utf8"));
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT * FROM project_repositories ORDER BY project_id").all()).toEqual([
      { project_id: "one", repository_id: "shared", path_prefixes: "[]", revision: 1 },
      { project_id: "two", repository_id: "shared", path_prefixes: "[]", revision: 1 },
    ]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT count(*) n FROM project_repositories").get()).toEqual({ n: 2 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version 16 checkout observations retain legacy evidence and catalog revisions survive restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "allgather-catalog-upgrade-")),
    path = join(dir, "data.sqlite");
  let db = openDatabase(path);
  try {
    let w = new Workspace(db);
    const m = w.execute(
      "machines_create",
      { name: "Upgrade fixture", operation_key: "machine" },
      OWNER,
    ) as Machine;
    w.run("INSERT INTO checkouts VALUES('internal-checkout',?,NULL,'/work/old')", m.id);
    w.run(
      "INSERT INTO checkout_observations VALUES('internal-checkout','main',NULL,'{}',NULL,NULL,NULL,'2026-01-01T00:00:00.000Z',3)",
    );
    db.close();
    db = new Database(path);
    db.exec("PRAGMA foreign_keys=ON");
    // Reconstruct the supported prior layout; data and legacy references remain intact.
    for (const row of db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'catalog_%'",
      )
      .all())
      db.exec(`DROP TRIGGER "${row.name}"`);
    db.exec(
      "DROP TABLE tower_checkouts; DROP TABLE machine_catalog_sync; DROP TABLE repository_catalog_clock; ALTER TABLE machines DROP COLUMN active_credential_id; ALTER TABLE machines DROP COLUMN terminal_controls; ALTER TABLE session_runtimes ADD COLUMN takeover_at TEXT; ALTER TABLE session_runtimes ADD COLUMN protocol_version TEXT; ALTER TABLE session_runtimes ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'; CREATE TABLE runtime_takeovers(id TEXT); DROP TRIGGER artifact_context_cleanup; DROP TRIGGER artifact_thread_context_cleanup; CREATE TRIGGER artifact_context_cleanup BEFORE DELETE ON artifacts BEGIN SELECT 1; END; CREATE TRIGGER artifact_thread_context_cleanup BEFORE DELETE ON threads BEGIN SELECT 1; END; DROP TRIGGER entity_tombstone_immutable; DROP TRIGGER artifact_comment_context_cleanup; DROP TRIGGER artifact_lifecycle_comment_context_cleanup; DROP TRIGGER artifact_version_context_cleanup; ALTER TABLE entities DROP COLUMN deleted_at; ALTER TABLE entities DROP COLUMN label; ALTER TABLE task_blockers DROP COLUMN resolved_comment_id; DROP TABLE tower_invitations; DROP TABLE approval_requests; ALTER TABLE oauth_tokens DROP COLUMN grant_id; DROP TABLE oauth_grants; ALTER TABLE agent_sessions DROP COLUMN project_id; ALTER TABLE oauth_clients DROP COLUMN audience; ALTER TABLE login_tokens DROP COLUMN expires_at; ALTER TABLE login_tokens DROP COLUMN consumed_at; PRAGMA user_version=16;",
    );
    db.close();
    db = openDatabase(path);
    w = new Workspace(db);
    const legacy = w.execute("checkouts_list", {}, OWNER) as CheckoutObservation[];
    expect(legacy[0]).toMatchObject({
      machine_id: m.id,
      checkout_id: null,
      identity: "legacy_path",
      path: "/work/old",
      branch: "main",
      revision: 3,
    });
    expect(JSON.stringify(legacy)).not.toContain("internal-checkout");
    expect(w.one<{ id: string }>("SELECT id FROM checkouts")).toEqual({ id: "internal-checkout" });
    const before = w.one<{ revision: number }>(
      "SELECT revision FROM repository_catalog_clock",
    )!.revision;
    w.execute("projects_create", { name: "Catalog project", operation_key: "project" }, OWNER);
    const revision = w.one<{ revision: number }>(
      "SELECT revision FROM repository_catalog_clock",
    )!.revision;
    expect(revision).toBeGreaterThan(before);
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT revision FROM repository_catalog_clock").get()).toEqual({ revision });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function terminalMigrationFixture() {
  const db = new Database(":memory:");
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE machines(id TEXT PRIMARY KEY);
    CREATE TABLE tower_credentials(id TEXT PRIMARY KEY,revoked_at TEXT);
    CREATE TABLE agent_sessions(id TEXT PRIMARY KEY);
    CREATE TABLE session_runtimes(id TEXT PRIMARY KEY);
    INSERT INTO machines VALUES('machine');
    INSERT INTO agent_sessions VALUES('session');
    INSERT INTO session_runtimes VALUES('runtime');
  `);
  db.exec(readFileSync(new URL("./fixtures/transcript-sources-v17.sql", import.meta.url), "utf8"));
  db.exec(`
    CREATE TABLE source_deletions(id TEXT);
    CREATE TRIGGER source_deleted AFTER DELETE ON transcript_sources BEGIN INSERT INTO source_deletions VALUES(old.id); END;
    CREATE INDEX source_query ON transcript_sources(session_id,kind);
    INSERT INTO transcript_sources VALUES('source','session','runtime','acp_stream','generation','tower-session.v1',4,'unknown','2026-01-01T00:00:00Z');
    CREATE TABLE session_events(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES transcript_sources(id),payload TEXT NOT NULL);
    CREATE TRIGGER session_events_immutable BEFORE UPDATE ON session_events BEGIN SELECT RAISE(ABORT,'Session events are append-only'); END;
    INSERT INTO session_events VALUES('event','source','original evidence');
    CREATE TABLE blobs(hash TEXT PRIMARY KEY);
    INSERT INTO blobs VALUES('blob');
    CREATE TABLE session_assets(id TEXT PRIMARY KEY,source_id TEXT REFERENCES transcript_sources(id),blob_hash TEXT REFERENCES blobs(hash));
    INSERT INTO session_assets VALUES('asset','source','blob');
    PRAGMA user_version=17;
  `);
  return db;
}

test("terminal source migration preserves stream history, assets, indexes, and triggers", () => {
  const db = terminalMigrationFixture();
  try {
    migrateTerminalSessions(db);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 18 });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT terminal_controls,active_credential_id FROM machines").get()).toEqual({
      terminal_controls: "{}",
      active_credential_id: null,
    });
    expect(db.query("SELECT kind,cursor FROM transcript_sources WHERE id='source'").get()).toEqual({
      kind: "acp_stream",
      cursor: 4,
    });
    expect(db.query("SELECT * FROM session_events").get()).toEqual({
      id: "event",
      source_id: "source",
      payload: "original evidence",
    });
    expect(db.query("SELECT * FROM session_assets").get()).toEqual({
      id: "asset",
      source_id: "source",
      blob_hash: "blob",
    });
    expect(db.query("SELECT * FROM source_deletions").all()).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='source_query'").get()).toEqual({
      name: "source_query",
    });
    expect(() => db.exec("UPDATE session_events SET payload='changed'")).toThrow("append-only");
    expect(() => db.exec("DELETE FROM transcript_sources WHERE id='source'")).toThrow(
      "FOREIGN KEY",
    );
    db.exec(
      "INSERT INTO transcript_sources VALUES('terminal','session','runtime','terminal_lifecycle','generation','terminal.v1',0,'partial','2026-01-01T00:00:00Z')",
    );
    db.exec("DELETE FROM transcript_sources WHERE id='terminal'");
    expect(db.query("SELECT * FROM source_deletions").all()).toEqual([{ id: "terminal" }]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close();
  }
});

test("a failed terminal migration rolls back its schema and preserves original evidence", () => {
  const db = terminalMigrationFixture();
  try {
    db.exec(
      "PRAGMA foreign_keys=OFF; INSERT INTO session_events VALUES('orphan','missing','retained invalid reference'); PRAGMA foreign_keys=ON;",
    );
    expect(() => migrateTerminalSessions(db)).toThrow("break retained references");
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(
      (db.query("PRAGMA table_info(machines)").all() as { name: string }[]).some(
        (c) => c.name === "terminal_controls",
      ),
    ).toBe(false);
    expect(db.query("SELECT cursor FROM transcript_sources WHERE id='source'").get()).toEqual({
      cursor: 4,
    });
    expect(db.query("SELECT COUNT(*) n FROM session_events").get()).toEqual({ n: 2 });
    expect(db.query("SELECT * FROM source_deletions").all()).toEqual([]);
    db.exec("DELETE FROM session_events WHERE id='orphan'");
    migrateTerminalSessions(db);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("version 18 retires only undispatched takeover replacements and preserves execution evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-resume-upgrade-"));
  const path = join(root, "data.sqlite");
  let db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE projects(id TEXT PRIMARY KEY);
      CREATE TABLE machines(id TEXT PRIMARY KEY);
      CREATE TABLE tower_credentials(id TEXT PRIMARY KEY,revoked_at TEXT);
      CREATE TABLE agent_sessions(id TEXT PRIMARY KEY);
      CREATE TABLE session_runtimes(id TEXT PRIMARY KEY,state TEXT,fenced INTEGER,connected INTEGER,termination TEXT,takeover_at TEXT,protocol_version TEXT,capabilities TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE session_commands(id TEXT PRIMARY KEY,runtime_id TEXT REFERENCES session_runtimes(id),state TEXT,payload TEXT,result TEXT,updated_at TEXT);
      CREATE TABLE runtime_takeovers(id TEXT PRIMARY KEY,runtime_id TEXT REFERENCES session_runtimes(id));
      INSERT INTO session_runtimes(id,state,fenced,connected,termination,takeover_at) VALUES('old','error',1,0,'unknown','old-grant'),('queued','starting',0,0,'unknown',NULL),('running','idle',0,1,'unknown',NULL),('normal','starting',0,0,'unknown',NULL);
      INSERT INTO runtime_takeovers VALUES('grant','old');
      INSERT INTO session_commands VALUES('queued','queued','queued','{"takeover":{"owner_action_id":"grant"}}',NULL,'before'),('sent','running','sent','{"takeover":{"owner_action_id":"grant"}}',NULL,'before'),('normal','normal','queued','{}',NULL,'before');
      PRAGMA user_version=18;
    `);
    db.exec(readFileSync(new URL("./fixtures/auth-v20.sql", import.meta.url), "utf8"));
    db.close();
    db = openDatabase(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.query("SELECT state,result FROM session_commands WHERE id='queued'").get()).toEqual({
      state: "failed",
      result: '{"code":"takeover_removed"}',
    });
    expect(db.query("SELECT state FROM session_commands WHERE id='sent'").get()).toEqual({
      state: "sent",
    });
    expect(db.query("SELECT state FROM session_commands WHERE id='normal'").get()).toEqual({
      state: "queued",
    });
    expect(
      db.query("SELECT termination,fenced FROM session_runtimes WHERE id='old'").get(),
    ).toEqual({ termination: "unknown", fenced: 1 });
    expect(
      db.query("SELECT termination,fenced FROM session_runtimes WHERE id='queued'").get(),
    ).toEqual({ termination: "confirmed", fenced: 1 });
    expect(
      db.query("SELECT state,connected FROM session_runtimes WHERE id='running'").get(),
    ).toEqual({ state: "idle", connected: 1 });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name='runtime_takeovers'").get(),
    ).toBeNull();
    expect(
      db
        .query<{ name: string }, []>("PRAGMA table_info(session_runtimes)")
        .all()
        .map((r) => r.name),
    ).not.toContain("takeover_at");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT count(*) n FROM session_commands").get()).toEqual({ n: 3 });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("version 19 removes unused runtime metadata while retaining controls, identities and recovery evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-runtime-cleanup-"));
  const path = join(root, "data.sqlite");
  let db = openDatabase(path);
  try {
    let w = new Workspace(db);
    const owner = fixtureOwner(w);
    const m = w.execute(
      "machines_create",
      { name: "Migration fixture", operation_key: "machine" },
      owner,
    ) as Machine;
    w.run(
      "UPDATE machines SET connected=1,harnesses=?,harness_controls=?,capabilities=? WHERE id=?",
      JSON.stringify(["codex"]),
      JSON.stringify({ codex: fullControls("codex-app-server") }),
      JSON.stringify([
        "managed-acp.v1",
        "command-receipts.v1",
        "session-stream.v1",
        "session-resume.v1",
        "session-force-resume.v1",
      ]),
      m.id,
    );
    const created = w.execute(
      "session_launch",
      { machine_id: m.id, harness: "codex", cwd: "/work/project", operation_key: "launch" },
      owner,
    ) as {
      runtime: import("../shared/contracts.ts").SessionRuntime;
      command: import("../shared/contracts.ts").SessionCommand;
    };
    w.run(
      "UPDATE session_runtimes SET native_session_id='retained-native-history',owner_id='retained-owner' WHERE id=?",
      created.runtime.id,
    );
    const receipt = {
      runtime_id: created.runtime.id,
      generation: created.runtime.generation,
      command_id: created.command.id,
      receipt_revision: 1,
      state: "accepted",
      acceptance: { level: "adapter", at: w.now() },
      dispatch: { state: "unknown" },
    };
    w.run("UPDATE session_commands SET state='sent' WHERE id=?", created.command.id);
    w.executions.managed.receipt(m.id, receipt);
    w.executions.managed.loss(m.id, {
      runtime_id: created.runtime.id,
      generation: created.runtime.generation,
      owner_id: "retained-owner",
      loss_id: "retained-loss",
      report_revision: 1,
      termination: "unknown",
      reason: "dispatch_unknown",
      observed_at: w.now(),
    });
    const before = {
      runtime: w.executions.runtime(created.runtime.session_id),
      command: w.executions.command(created.command.id),
      receipts: w.all("SELECT * FROM command_receipts"),
      losses: w.all("SELECT * FROM runtime_losses"),
    };
    db.close();
    db = new Database(path);
    db.exec(`ALTER TABLE session_runtimes ADD COLUMN protocol_version TEXT;
      ALTER TABLE session_runtimes ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]';
      UPDATE session_runtimes SET protocol_version='obsolete',capabilities='["obsolete"]';
      DROP TRIGGER artifact_context_cleanup; DROP TRIGGER artifact_thread_context_cleanup; CREATE TRIGGER artifact_context_cleanup BEFORE DELETE ON artifacts BEGIN SELECT 1; END; CREATE TRIGGER artifact_thread_context_cleanup BEFORE DELETE ON threads BEGIN SELECT 1; END; DROP TRIGGER entity_tombstone_immutable; DROP TRIGGER artifact_comment_context_cleanup; DROP TRIGGER artifact_lifecycle_comment_context_cleanup; DROP TRIGGER artifact_version_context_cleanup; ALTER TABLE entities DROP COLUMN deleted_at; ALTER TABLE entities DROP COLUMN label; ALTER TABLE task_blockers DROP COLUMN resolved_comment_id; DROP TABLE tower_invitations; DROP TABLE approval_requests; ALTER TABLE oauth_tokens DROP COLUMN grant_id; DROP TABLE oauth_grants; ALTER TABLE agent_sessions DROP COLUMN project_id; ALTER TABLE oauth_clients DROP COLUMN audience; ALTER TABLE login_tokens DROP COLUMN expires_at;
      ALTER TABLE login_tokens DROP COLUMN consumed_at;
      PRAGMA user_version=19;`);
    db.close();
    db = openDatabase(path);
    w = new Workspace(db);
    const current = w.executions.runtime(created.runtime.session_id);
    expect(current).toEqual(before.runtime);
    expect(current).not.toHaveProperty("protocol_version");
    expect(current).not.toHaveProperty("capabilities");
    expect(w.executions.command(created.command.id)).toEqual(before.command);
    expect(w.all("SELECT * FROM command_receipts")).toEqual(before.receipts);
    expect(w.all("SELECT * FROM runtime_losses")).toEqual(before.losses);
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(session_runtimes)")
      .all()
      .map((c) => c.name);
    expect(columns).not.toContain("protocol_version");
    expect(columns).not.toContain("capabilities");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    db.close();
    db = openDatabase(path);
    expect(new Workspace(db).executions.runtime(created.runtime.session_id)).toEqual(
      before.runtime,
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
