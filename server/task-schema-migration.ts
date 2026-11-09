import type { Database } from "bun:sqlite";

export function migrateTaskSchema(db: Database) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN is_done INTEGER NOT NULL DEFAULT 0
        CHECK(is_done IN (0,1) AND (is_done=0 OR closed_at IS NOT NULL));
      UPDATE tasks SET is_done=(status='done');
      DROP INDEX tasks_v5_project;
      ALTER TABLE tasks DROP COLUMN status;
      CREATE INDEX tasks_project_closed ON tasks(project_id,closed_at,updated_at);
      ALTER TABLE task_blockers RENAME TO previous_task_blockers;
      CREATE TABLE task_blockers(
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        waiting_on TEXT NOT NULL CHECK(waiting_on IN ('human','task','external')),
        waiting_on_task_id TEXT REFERENCES tasks(id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        cleared_at TEXT,
        resolution_comment_id TEXT REFERENCES task_comments(id),
        CHECK((waiting_on='task')=(waiting_on_task_id IS NOT NULL)),
        CHECK(waiting_on_task_id IS NULL OR waiting_on_task_id!=task_id),
        CHECK(waiting_on!='task' OR (cleared_at IS NULL AND resolution_comment_id IS NULL)),
        CHECK(cleared_at IS NOT NULL OR resolution_comment_id IS NULL)
      );
      INSERT INTO task_blockers
        SELECT id,task_id,CASE waiting_on WHEN 'owner' THEN 'human' ELSE waiting_on END,NULL,
          body,created_at,resolved_at,resolved_comment_id FROM previous_task_blockers;
      INSERT INTO task_blockers
        SELECT 'blocker_'||lower(hex(randomblob(16))),p.task_id,'task',p.prerequisite_id,
          'Complete prerequisite',t.created_at,NULL,NULL
        FROM task_prerequisites p JOIN tasks t ON t.id=p.task_id;
      CREATE INDEX blockers_by_task ON task_blockers(task_id,created_at,id);
      CREATE UNIQUE INDEX blockers_unique_prerequisite ON task_blockers(task_id,waiting_on_task_id)
        WHERE waiting_on='task';
      CREATE INDEX blockers_by_prerequisite ON task_blockers(waiting_on_task_id,task_id)
        WHERE waiting_on='task';
      DROP TABLE previous_task_blockers;
      DROP TABLE task_prerequisites;
      DROP TABLE task_claims;
      PRAGMA user_version=37;
    `);
  }).immediate();
}
