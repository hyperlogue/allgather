import type { Database } from "bun:sqlite";
import { availableProjectSlug } from "./project-slugs.ts";

export function migrateFallbackProject(db: Database) {
  db.transaction(() => {
    if (
      db
        .query<{ name: string }, []>("PRAGMA table_info(projects)")
        .all()
        .some((column) => column.name === "is_fallback")
    ) {
      db.exec("PRAGMA user_version=39");
      return;
    }
    db.exec(
      "ALTER TABLE projects ADD COLUMN is_fallback INTEGER NOT NULL DEFAULT 0 CHECK(is_fallback IN (0,1))",
    );
    if (!db.query("SELECT 1 FROM projects WHERE id='prj-inbox'").get()) {
      let name = "Inbox";
      let suffix = 2;
      while (db.query("SELECT 1 FROM projects WHERE name=?").get(name)) name = `Inbox ${suffix++}`;
      db.query(
        "INSERT INTO projects(id,name,slug,description,body,created_at) VALUES('prj-inbox',?,?,'','',?)",
      ).run(name, availableProjectSlug(db, "Inbox"), new Date().toISOString());
      db.exec("INSERT INTO entities(id,kind,project_id) VALUES('prj-inbox','project','prj-inbox')");
    }
    db.exec(`
      UPDATE projects SET is_fallback=1 WHERE id='prj-inbox';
      CREATE UNIQUE INDEX projects_one_fallback ON projects(is_fallback) WHERE is_fallback=1;
      CREATE TRIGGER fallback_project_no_delete BEFORE DELETE ON projects WHEN OLD.is_fallback=1 BEGIN SELECT RAISE(ABORT,'The fallback project cannot be deleted'); END;
      PRAGMA user_version=39;
    `);
  }).immediate();
}
