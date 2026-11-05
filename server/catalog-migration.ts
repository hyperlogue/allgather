import type { Database } from "bun:sqlite";

export function migrateCatalog(db: Database) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE repository_catalog_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT INTO repository_catalog_clock VALUES(1,1);
      CREATE TABLE machine_catalog_sync(machine_id TEXT PRIMARY KEY REFERENCES machines(id),catalog_revision INTEGER NOT NULL DEFAULT 0,catalog_error TEXT,checkout_error TEXT,checkout_received_at TEXT,checkouts_current INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE tower_checkouts(machine_id TEXT NOT NULL REFERENCES machines(id),checkout_id TEXT NOT NULL,repository_id TEXT REFERENCES repositories(id),record TEXT NOT NULL,received_at TEXT NOT NULL,present INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(machine_id,checkout_id));
      CREATE INDEX tower_checkouts_repository ON tower_checkouts(repository_id,machine_id);
    `);
    for (const [table, columns] of [
      ["projects", ["id", "name"]],
      ["repositories", ["id", "name", "upstream_url", "url_aliases"]],
      ["project_repositories", ["project_id", "repository_id"]],
    ] as const) {
      for (const event of ["INSERT", "DELETE", "UPDATE"]) {
        const condition =
          event === "UPDATE"
            ? ` WHEN ${columns.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ")}`
            : "";
        db.exec(
          `CREATE TRIGGER catalog_${table}_${event} AFTER ${event} ON ${table}${condition} BEGIN UPDATE repository_catalog_clock SET revision=revision+1 WHERE id=1; END`,
        );
      }
    }
    db.exec("PRAGMA user_version=17");
  }).immediate();
}
