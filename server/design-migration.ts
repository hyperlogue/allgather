import type { Database } from "bun:sqlite";

/** Preserve the old model as an immutable migration archive while installing the approved model. */
export function migrateDesign(db: Database) {
  db.transaction(() => {
    for (const table of [
      "tasks",
      "task_comments",
      "task_blockers",
      "handoffs",
      "agent_runs",
      "dependencies",
      "task_relations",
      "relations",
    ])
      db.exec(`ALTER TABLE ${table} RENAME TO legacy_${table}`);
    db.exec(`
      ALTER TABLE projects ADD COLUMN body TEXT NOT NULL DEFAULT '';
      UPDATE projects SET body=description;
      CREATE TABLE roles(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
      CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,agent_type TEXT NOT NULL,source_namespace TEXT,native_session_id TEXT,label TEXT,role_id TEXT REFERENCES roles(id),revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(source_namespace,native_session_id));
      CREATE TABLE session_aliases(alias TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES agent_sessions(id));
      INSERT OR IGNORE INTO agent_sessions(id,agent_type,source_namespace,native_session_id,label,created_at,updated_at)
        SELECT r.session_id,COALESCE(o.agent_type,'unknown'),'legacy',r.session_id,o.name,r.created_at,r.created_at FROM legacy_agent_runs r JOIN operators o ON o.id=r.operator_id ORDER BY r.created_at,r.id;
      INSERT INTO session_aliases SELECT id,session_id FROM legacy_agent_runs;
      INSERT OR IGNORE INTO entities SELECT id,'session',NULL FROM agent_sessions;
      CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),parent_id TEXT REFERENCES tasks(id),labels TEXT NOT NULL DEFAULT '[]',defer_until TEXT,assignee TEXT,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT,CHECK(parent_id IS NULL OR parent_id!=id));
      CREATE INDEX tasks_v5_project ON tasks(project_id,status,updated_at);
      CREATE INDEX tasks_v5_parent ON tasks(parent_id);
      CREATE TABLE task_prerequisites(task_id TEXT NOT NULL REFERENCES tasks(id),prerequisite_id TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(task_id,prerequisite_id),CHECK(task_id!=prerequisite_id));
      CREATE INDEX prerequisites_reverse ON task_prerequisites(prerequisite_id);
      CREATE TABLE task_claims(task_id TEXT PRIMARY KEY REFERENCES tasks(id),holder TEXT NOT NULL CHECK(holder IN ('owner','session')),session_id TEXT REFERENCES agent_sessions(id),lease_until TEXT NOT NULL,CHECK((holder='owner' AND session_id IS NULL) OR (holder='session' AND session_id IS NOT NULL)));
      CREATE TABLE task_comments(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL REFERENCES tasks(id),body TEXT NOT NULL,operator_id TEXT REFERENCES operators(id),operator_name TEXT NOT NULL,operator_kind TEXT NOT NULL,session_id TEXT,role_id TEXT,role_name TEXT,reply_to TEXT REFERENCES task_comments(id),created_at TEXT NOT NULL,legacy_event_id INTEGER UNIQUE);
      CREATE INDEX comments_v5_task ON task_comments(task_id,sequence);
      CREATE TABLE task_blockers(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),waiting_on TEXT NOT NULL CHECK(waiting_on IN ('owner','external')),body TEXT NOT NULL,created_at TEXT NOT NULL,resolved_at TEXT);
      CREATE INDEX blockers_v5_task ON task_blockers(task_id,resolved_at);
      CREATE TABLE relations(id TEXT PRIMARY KEY,type TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES entities(id),target_id TEXT NOT NULL REFERENCES entities(id),reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(type,source_id,target_id));
      CREATE INDEX relations_v5_source ON relations(source_id,type);
      CREATE INDEX relations_v5_target ON relations(target_id,type);
      ALTER TABLE audit_operations ADD COLUMN role_id TEXT;
      ALTER TABLE audit_operations ADD COLUMN role_name TEXT;
      CREATE TABLE project_repositories(project_id TEXT NOT NULL REFERENCES projects(id),repository_id TEXT NOT NULL REFERENCES repositories(id),PRIMARY KEY(project_id,repository_id));
      INSERT INTO project_repositories SELECT project_id,id FROM repositories;
      ALTER TABLE repositories ADD COLUMN branches TEXT NOT NULL DEFAULT '["main"]';
      ALTER TABLE repositories ADD COLUMN tag_regex TEXT;
      ALTER TABLE repositories ADD COLUMN initial_fetch_limit INTEGER NOT NULL DEFAULT 10000;
      ALTER TABLE repositories ADD COLUMN max_indexed_commits INTEGER DEFAULT 100000;
      ALTER TABLE repositories ADD COLUMN cache_policy TEXT NOT NULL DEFAULT 'metadata_only';
      ALTER TABLE repositories ADD COLUMN actual_cache_mode TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE repositories ADD COLUMN cache_cleanup TEXT NOT NULL DEFAULT 'idle';
      ALTER TABLE repositories ADD COLUMN backfill_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE repositories ADD COLUMN cleanup_requested INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE repositories ADD COLUMN collection_checkpoint TEXT;
      UPDATE repositories SET initial_fetch_limit=CASE history_limit WHEN 2000 THEN 10000 ELSE history_limit END,
        branches=CASE refs WHEN '["HEAD"]' THEN '["main"]' ELSE refs END;
      ALTER TABLE commits ADD COLUMN author TEXT;
      ALTER TABLE commits ADD COLUMN committer TEXT;
      CREATE TABLE commit_references(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL REFERENCES repositories(id),hash TEXT NOT NULL,UNIQUE(repository_id,hash));
      INSERT OR IGNORE INTO commit_references SELECT 'commit:'||repository_id||':'||id,repository_id,id FROM commits;
      INSERT OR IGNORE INTO commit_references SELECT 'commit:'||repository_id||':'||commit_id,repository_id,commit_id FROM task_commits;
      CREATE VIRTUAL TABLE commit_search USING fts5(repository_id UNINDEXED,commit_id UNINDEXED,message);
      INSERT INTO commit_search SELECT repository_id,id,message FROM commits WHERE verified_upstream=1;
      CREATE TRIGGER commit_search_insert AFTER INSERT ON commits WHEN NEW.verified_upstream=1 BEGIN INSERT INTO commit_search VALUES(NEW.repository_id,NEW.id,NEW.message); END;
      CREATE TRIGGER commit_search_update AFTER UPDATE ON commits BEGIN DELETE FROM commit_search WHERE repository_id=OLD.repository_id AND commit_id=OLD.id; INSERT INTO commit_search SELECT NEW.repository_id,NEW.id,NEW.message WHERE NEW.verified_upstream=1; END;
      CREATE TRIGGER commit_search_delete AFTER DELETE ON commits BEGIN DELETE FROM commit_search WHERE repository_id=OLD.repository_id AND commit_id=OLD.id; END;
      CREATE TABLE storage_observations(id INTEGER PRIMARY KEY CHECK(id=1),at TEXT NOT NULL,value TEXT NOT NULL);
    `);
    const rows = db.query("SELECT * FROM legacy_tasks ORDER BY created_at,id").all() as Record<
      string,
      unknown
    >[];
    for (const t of rows) {
      const sections = [
        ["", t.description],
        ["Expected result", t.expected_result],
        ["Next action", t.next_action],
        ["Acceptance criteria", t.acceptance_criteria],
        ["Migration note", t.migration_note],
      ]
        .filter(([, v]) => typeof v === "string" && v.length)
        .map(([title, value]) => (title ? `## ${title}\n\n${value}` : value));
      db.query(
        "INSERT INTO tasks(id,project_id,title,body,status,labels,defer_until,revision,created_at,updated_at,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        String(t.id),
        String(t.project_id),
        String(t.title),
        sections.join("\n\n"),
        t.status === "closed" ? (t.resolution === "done" ? "done" : "cancelled") : "open",
        String(t.labels),
        t.defer_until as string | null,
        Number(t.revision),
        String(t.created_at),
        String(t.updated_at),
        t.closed_at as string | null,
      );
    }
    db.exec(`
      UPDATE tasks SET parent_id=(SELECT target_id FROM legacy_relations WHERE source_id=tasks.id AND type='part_of');
      INSERT INTO task_prerequisites SELECT source_id,target_id FROM legacy_relations WHERE type='depends_on';
      INSERT INTO task_comments SELECT sequence,id,task_id,body,operator_id,operator_name,operator_kind,session_id,NULL,NULL,reply_to,created_at,legacy_event_id FROM legacy_task_comments;
      INSERT INTO task_blockers SELECT id,task_id,waiting_on,reason||char(10)||char(10)||requested_action||CASE resume_note WHEN '' THEN '' ELSE char(10)||char(10)||resume_note END,created_at,resolved_at FROM legacy_task_blockers;
      INSERT OR IGNORE INTO relations SELECT id,type,COALESCE((SELECT session_id FROM session_aliases WHERE alias=source_id),source_id),COALESCE((SELECT session_id FROM session_aliases WHERE alias=target_id),target_id),reason,created_at FROM legacy_relations WHERE type NOT IN ('part_of','depends_on');
      INSERT OR IGNORE INTO agent_sessions(id,agent_type,label,created_at,updated_at) SELECT claim_session,'unknown',claim_session,created_at,updated_at FROM legacy_tasks WHERE claim_session IS NOT NULL AND claim_actor!='operator-owner';
      INSERT OR IGNORE INTO entities SELECT id,'session',NULL FROM agent_sessions;
      INSERT INTO task_claims SELECT id,CASE claim_actor WHEN 'operator-owner' THEN 'owner' ELSE 'session' END,CASE claim_actor WHEN 'operator-owner' THEN NULL ELSE claim_session END,claim_expires FROM legacy_tasks WHERE claim_expires IS NOT NULL AND (claim_actor='operator-owner' OR claim_session IS NOT NULL) AND status!='closed';
      INSERT OR IGNORE INTO roles(id,name,description,created_at) SELECT 'role-'||to_operator,to_name,'Assignment retained from an earlier handoff',created_at FROM legacy_handoffs WHERE status='pending';
      UPDATE tasks SET assignee=(SELECT json_object('kind','role','id','role-'||to_operator) FROM legacy_handoffs WHERE task_id=tasks.id AND status='pending') WHERE EXISTS(SELECT 1 FROM legacy_handoffs WHERE task_id=tasks.id AND status='pending');
      PRAGMA user_version=5;
    `);
    const violations = db.query("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error("Design migration found broken references");
  }).immediate();
}
