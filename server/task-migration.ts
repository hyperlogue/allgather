import type { Database } from "bun:sqlite";

/** Upgrade Allgather's own records; no external issue format is involved. */
export function migrateTaskWorkflow(db: Database) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN expected_result TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN next_action TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE tasks ADD COLUMN defer_until TEXT;
      ALTER TABLE tasks ADD COLUMN resolution TEXT;
      ALTER TABLE tasks ADD COLUMN closed_at TEXT;
      ALTER TABLE tasks ADD COLUMN closed_by TEXT;
      ALTER TABLE tasks ADD COLUMN migration_note TEXT;
      UPDATE tasks SET resolution=CASE status WHEN 'finished' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE NULL END,
        closed_at=CASE WHEN status IN ('finished','cancelled') THEN COALESCE(finished_at,updated_at) ELSE NULL END,
        status=CASE status WHEN 'finished' THEN 'closed' WHEN 'cancelled' THEN 'closed' WHEN 'in_progress' THEN 'active' ELSE 'inbox' END;
      CREATE TABLE operators(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,agent_type TEXT,created_at TEXT NOT NULL);
      CREATE TABLE agent_runs(id TEXT PRIMARY KEY,operator_id TEXT NOT NULL REFERENCES operators(id),session_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(operator_id,session_id));
      CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,project_id TEXT REFERENCES projects(id));
      CREATE TABLE relations(id TEXT PRIMARY KEY,type TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES entities(id),target_id TEXT NOT NULL REFERENCES entities(id),reason TEXT NOT NULL,created_at TEXT NOT NULL,CHECK(source_id!=target_id),UNIQUE(type,source_id,target_id));
      CREATE INDEX relations_source ON relations(source_id,type);
      CREATE INDEX relations_target ON relations(target_id,type);
      CREATE UNIQUE INDEX one_parent ON relations(source_id) WHERE type='part_of';
      CREATE UNIQUE INDEX one_resolution_target ON relations(source_id) WHERE type IN ('duplicate_of','superseded_by');
      CREATE TABLE task_comments(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL REFERENCES tasks(id),body TEXT NOT NULL,operator_id TEXT REFERENCES operators(id),operator_name TEXT NOT NULL,operator_kind TEXT NOT NULL,session_id TEXT,reply_to TEXT REFERENCES task_comments(id),created_at TEXT NOT NULL,legacy_event_id INTEGER UNIQUE);
      CREATE INDEX comments_task ON task_comments(task_id,sequence);
      CREATE TABLE task_blockers(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),waiting_on TEXT NOT NULL,reason TEXT NOT NULL,requested_action TEXT NOT NULL,resume_note TEXT NOT NULL,created_at TEXT NOT NULL,resolved_at TEXT);
      CREATE INDEX blockers_task ON task_blockers(task_id,resolved_at);
      CREATE TABLE handoffs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),comment_id TEXT NOT NULL REFERENCES task_comments(id),from_operator TEXT NOT NULL REFERENCES operators(id),from_session TEXT,to_operator TEXT NOT NULL REFERENCES operators(id),to_name TEXT NOT NULL,status TEXT NOT NULL,accepted_session TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,reason TEXT);
      CREATE UNIQUE INDEX one_pending_handoff ON handoffs(task_id) WHERE status='pending';
      CREATE TABLE audit_operations(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,inlet TEXT NOT NULL,operator_id TEXT NOT NULL,operator_name TEXT NOT NULL,operator_kind TEXT NOT NULL,agent_type TEXT,session_id TEXT,source TEXT NOT NULL,operation TEXT NOT NULL,operation_key TEXT NOT NULL,at TEXT NOT NULL,details TEXT NOT NULL);
      CREATE TABLE audit_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL REFERENCES audit_operations(id),entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,change_kind TEXT NOT NULL,project_id TEXT,task_id TEXT,related_task_id TEXT,before_value TEXT,after_value TEXT);
      CREATE INDEX audit_operation_changes ON audit_changes(operation_id,sequence);
      CREATE INDEX audit_task_changes ON audit_changes(task_id,sequence);
      CREATE INDEX audit_related_changes ON audit_changes(related_task_id,sequence);
      CREATE INDEX audit_project_changes ON audit_changes(project_id,sequence);
      CREATE INDEX audit_operator ON audit_operations(operator_id,at);
      INSERT INTO entities SELECT id,'project',id FROM projects;
      INSERT INTO entities SELECT id,'task',project_id FROM tasks;
      INSERT INTO entities SELECT id,'repository',project_id FROM repositories;
      INSERT OR IGNORE INTO entities SELECT 'commit:'||tc.repository_id||':'||tc.commit_id,'commit',r.project_id FROM task_commits tc JOIN repositories r ON r.id=tc.repository_id;
      INSERT INTO relations SELECT 'rel-parent-'||id,'part_of',id,COALESCE(parent_id,epic_id),'',created_at FROM tasks WHERE COALESCE(parent_id,epic_id) IS NOT NULL;
      INSERT INTO relations SELECT 'rel-dep-'||lower(hex(randomblob(16))),'depends_on',task_id,depends_on,'',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM dependencies;
      INSERT OR IGNORE INTO relations SELECT 'rel-origin-'||lower(hex(randomblob(16))),kind,task_id,source_id,'',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM task_relations;
      INSERT OR IGNORE INTO relations SELECT 'rel-commit-'||lower(hex(randomblob(16))),'relates_to',task_id,'commit:'||repository_id||':'||commit_id,'Commit reference from the earlier schema',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM task_commits;
      INSERT INTO task_comments(id,task_id,body,operator_name,operator_kind,created_at,legacy_event_id)
        SELECT 'comment-legacy-'||id,task_id,COALESCE(json_extract(payload,'$.note'),json_extract(payload,'$.summary'),json_extract(payload,'$.reason')),actor,'unknown',at,id FROM events
        WHERE task_id IN (SELECT id FROM tasks) AND trim(COALESCE(json_extract(payload,'$.note'),json_extract(payload,'$.summary'),json_extract(payload,'$.reason'),''))!='';
      INSERT INTO entities SELECT id,'comment',(SELECT project_id FROM tasks WHERE tasks.id=task_comments.task_id) FROM task_comments;
      UPDATE tasks SET status='blocked' WHERE status!='closed' AND EXISTS (
        SELECT 1 FROM relations r JOIN tasks prerequisite ON prerequisite.id=r.target_id WHERE r.type='depends_on' AND r.source_id=tasks.id AND (prerequisite.status!='closed' OR prerequisite.resolution!='done')
      );
      PRAGMA user_version=3;
    `);
    // Keep a conflicting earlier epic assignment visible instead of discarding it.
    const rows = db
      .query(
        "SELECT id,parent_id,epic_id FROM tasks WHERE parent_id IS NOT NULL AND epic_id IS NOT NULL AND parent_id!=epic_id",
      )
      .all() as { id: string; parent_id: string; epic_id: string }[];
    for (const task of rows) {
      const ancestors = db
        .query(
          "WITH RECURSIVE parents(id) AS (SELECT target_id FROM relations WHERE source_id=? AND type='part_of' UNION SELECT r.target_id FROM relations r JOIN parents p ON r.source_id=p.id WHERE r.type='part_of') SELECT 1 FROM parents WHERE id=?",
        )
        .get(task.id, task.epic_id);
      if (ancestors) continue;
      db.query(
        "INSERT OR IGNORE INTO relations VALUES(?,'relates_to',?,?,'Earlier epic assignment',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      ).run(`rel-legacy-epic-${task.id}`, task.id, task.epic_id);
      db.query("UPDATE tasks SET migration_note=? WHERE id=?").run(
        `Earlier parent ${task.parent_id} and epic ${task.epic_id} differ. The parent is retained; the epic remains a contextual link.`,
        task.id,
      );
    }
  }).immediate();
}
