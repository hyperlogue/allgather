import type { Database } from "bun:sqlite";
export function migrateGraphTombstones(db: Database) {
  db.transaction(() =>
    db.exec(`
 ALTER TABLE entities ADD COLUMN deleted_at TEXT;
 ALTER TABLE entities ADD COLUMN label TEXT;
 DROP TRIGGER artifact_context_cleanup;
 DROP TRIGGER artifact_thread_context_cleanup;
 CREATE TRIGGER artifact_context_cleanup BEFORE DELETE ON artifacts BEGIN
   UPDATE entities SET deleted_at=COALESCE(deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),label=COALESCE(label,CASE kind WHEN 'artifact' THEN OLD.title WHEN 'artifact_version' THEN OLD.title||' · version '||substr(id,instr(id,'@')+1) ELSE replace(kind,'_',' ') END)
   WHERE id IN (SELECT entity_id FROM artifact_entities WHERE artifact_id=OLD.id);
 END;
 CREATE TRIGGER artifact_thread_context_cleanup BEFORE DELETE ON threads BEGIN
   UPDATE entities SET deleted_at=COALESCE(deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),label=COALESCE(label,replace(kind,'_',' '))
   WHERE id=OLD.id OR id='comment_'||OLD.id OR id IN (SELECT id FROM comments WHERE thread_id=OLD.id);
 END;
 CREATE TRIGGER artifact_comment_context_cleanup BEFORE DELETE ON comments BEGIN
   UPDATE entities SET deleted_at=COALESCE(deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),label=COALESCE(label,'artifact comment') WHERE id=OLD.id;
 END;
 CREATE TRIGGER artifact_lifecycle_comment_context_cleanup BEFORE DELETE ON artifact_comments BEGIN
   UPDATE entities SET deleted_at=COALESCE(deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),label=COALESCE(label,'artifact comment') WHERE id=OLD.id;
 END;
 CREATE TRIGGER artifact_version_context_cleanup BEFORE DELETE ON artifact_versions BEGIN
   UPDATE entities SET deleted_at=COALESCE(deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),label=COALESCE(label,'Version '||OLD.seq) WHERE id=OLD.artifact_id||'@'||OLD.seq;
 END;
 CREATE TRIGGER entity_tombstone_immutable BEFORE UPDATE OF deleted_at ON entities WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at BEGIN SELECT RAISE(ABORT,'Deleted identities cannot be revived'); END;
 PRAGMA user_version=28;
 `),
  ).immediate();
}
