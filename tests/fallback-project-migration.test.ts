import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateFallbackProject } from "../server/fallback-project-migration.ts";

for (const legacy of [false, true]) {
  test(`fallback migration preserves ${legacy ? "the existing fallback" : "an unrelated Inbox"}`, () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT UNIQUE,slug TEXT UNIQUE,description TEXT,body TEXT,created_at TEXT);
        CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT,project_id TEXT);
      `);
      const id = legacy ? "prj-inbox" : "other";
      db.query("INSERT INTO projects VALUES(?,?,'INB','','Retained','2026-01-01')").run(
        id,
        legacy ? "My tasks" : "Inbox",
      );
      db.query("INSERT INTO entities VALUES(?,'project',?)").run(id, id);
      migrateFallbackProject(db);
      const fallback = db
        .query<{ id: string; name: string; slug: string; body: string }, []>(
          "SELECT * FROM projects WHERE is_fallback=1",
        )
        .get()!;
      expect(fallback.id).toBe("prj-inbox");
      expect(fallback.name).toBe(legacy ? "My tasks" : "Inbox 2");
      expect(fallback.slug).toBe(legacy ? "INB" : "INB2");
      expect(db.query("SELECT body FROM projects WHERE id=?").get(id)).toEqual({
        body: "Retained",
      });
      expect(() => db.query("DELETE FROM projects WHERE id=?").run(fallback.id)).toThrow(
        "cannot be deleted",
      );
      expect(db.query("SELECT * FROM entities WHERE id=?").get(fallback.id)).toBeTruthy();
      migrateFallbackProject(db);
      expect(db.query("SELECT COUNT(*) n FROM projects WHERE is_fallback=1").get()).toEqual({
        n: 1,
      });
    } finally {
      db.close();
    }
  });
}
