import type { Database } from "bun:sqlite";

export function restoreTaskSchema36(db: Database) {
  if (
    !db
      .query<{ name: string }, []>("PRAGMA table_info(tasks)")
      .all()
      .some((c) => c.name === "is_done")
  )
    return;
  for (const { name } of db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_temp_master WHERE type='trigger' AND tbl_name IN ('tasks','task_blockers')",
    )
    .all())
    db.exec(`DROP TRIGGER temp."${name.replaceAll('"', '""')}"`);
  db.exec(`
    ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled'));
    UPDATE tasks SET status=CASE WHEN closed_at IS NULL THEN 'open' WHEN is_done=1 THEN 'done' ELSE 'cancelled' END;
    DROP INDEX tasks_project_closed;
    ALTER TABLE tasks DROP COLUMN is_done;
    CREATE INDEX tasks_v5_project ON tasks(project_id,status,updated_at);
    CREATE TABLE task_prerequisites(task_id TEXT NOT NULL REFERENCES tasks(id),prerequisite_id TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(task_id,prerequisite_id));
    INSERT INTO task_prerequisites SELECT task_id,waiting_on_task_id FROM task_blockers WHERE waiting_on='task';
    CREATE TABLE task_claims(task_id TEXT PRIMARY KEY REFERENCES tasks(id),holder TEXT,session_id TEXT REFERENCES agent_sessions(id),lease_until TEXT);
    CREATE TABLE task_blockers_v36(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),waiting_on TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,resolved_at TEXT,resolved_comment_id TEXT REFERENCES task_comments(id));
    INSERT INTO task_blockers_v36 SELECT id,task_id,CASE waiting_on WHEN 'human' THEN 'owner' ELSE waiting_on END,body,created_at,cleared_at,resolution_comment_id FROM task_blockers WHERE waiting_on!='task';
    DROP TABLE task_blockers;
    ALTER TABLE task_blockers_v36 RENAME TO task_blockers;
    PRAGMA user_version=36;
  `);
}
