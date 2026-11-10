import type { Database } from "bun:sqlite";
import schema from "./artifact-schema.json";
export function migrateArtifacts(db: Database) {
  db.transaction(() => {
    for (const statement of schema) db.exec(statement);
    db.exec(`
 INSERT INTO artifact_activity_coverage VALUES(1,NULL);
 CREATE TABLE artifact_entities(entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE);
 CREATE INDEX artifact_entity_owners ON artifact_entities(artifact_id);
 CREATE TRIGGER artifact_context_cleanup BEFORE DELETE ON artifacts BEGIN
   DELETE FROM relations WHERE source_id IN (SELECT entity_id FROM artifact_entities WHERE artifact_id=OLD.id) OR target_id IN (SELECT entity_id FROM artifact_entities WHERE artifact_id=OLD.id);
   DELETE FROM entities WHERE id IN (SELECT entity_id FROM artifact_entities WHERE artifact_id=OLD.id);
 END;
 CREATE TRIGGER artifact_thread_context_cleanup BEFORE DELETE ON threads BEGIN
   DELETE FROM relations WHERE source_id=OLD.id OR target_id=OLD.id OR source_id='comment_'||OLD.id OR target_id='comment_'||OLD.id OR source_id IN (SELECT id FROM comments WHERE thread_id=OLD.id) OR target_id IN (SELECT id FROM comments WHERE thread_id=OLD.id);
   DELETE FROM entities WHERE id=OLD.id OR id='comment_'||OLD.id OR id IN (SELECT id FROM comments WHERE thread_id=OLD.id);
 END;
 INSERT OR REPLACE INTO settings VALUES('artifact_schema_version','20');
 PRAGMA user_version=8;
 `);
  }).immediate();
}
