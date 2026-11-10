import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, SCHEMA_VERSION, writeDatabaseSnapshot } from "../server/storage.ts";

test("snapshot gives SQLite a nonexistent private path and publishes complete WAL data", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-snapshot-test-"));
  const db = new Database(join(root, "source.sqlite"));
  const query = db.query.bind(db);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('retained');",
  );
  const probe = spyOn(db, "query").mockImplementation(((sql: string) => {
    if (sql !== "VACUUM INTO ?") return query(sql);
    return {
      run(path: string) {
        if (existsSync(path)) throw new Error("output file already exists");
        expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
        return query(sql).run(path);
      },
    };
  }) as typeof db.query);
  try {
    const path = join(root, "snapshot.sqlite");
    writeDatabaseSnapshot(db, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const copy = new Database(path, { readonly: true });
    try {
      expect(copy.query("SELECT * FROM evidence").all()).toEqual([{ value: "retained" }]);
      expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      copy.close();
    }
    expect(readdirSync(root).filter((name) => name.startsWith(".allgather-snapshot-"))).toEqual([]);
  } finally {
    probe.mockRestore();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot preserves existing destinations, including empty files", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-snapshot-existing-"));
  const db = new Database(":memory:");
  db.exec("CREATE TABLE evidence(value TEXT)");
  try {
    const path = join(root, "snapshot.sqlite");
    for (const contents of ["", "existing evidence"]) {
      writeFileSync(path, contents);
      expect(() => writeDatabaseSnapshot(db, path)).toThrow();
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(readdirSync(root)).toEqual(["snapshot.sqlite"]);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed vacuum removes partial output and preserves the source", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-snapshot-failure-"));
  const db = new Database(":memory:");
  db.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('retained')");
  const query = db.query.bind(db);
  const probe = spyOn(db, "query").mockImplementation(((sql: string) => {
    if (sql !== "VACUUM INTO ?") return query(sql);
    return {
      run(path: string) {
        writeFileSync(path, "partial");
        throw new Error("snapshot failed");
      },
    };
  }) as typeof db.query);
  try {
    expect(() => writeDatabaseSnapshot(db, join(root, "snapshot.sqlite"))).toThrow(
      "snapshot failed",
    );
    expect(readdirSync(root)).toEqual([]);
    expect(query("SELECT * FROM evidence").all()).toEqual([{ value: "retained" }]);
  } finally {
    probe.mockRestore();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const repair of [false, true]) {
  test(`upgrade snapshot failure preserves schema and closes the connection (repair=${repair})`, () => {
    const root = mkdtempSync(join(tmpdir(), "allgather-upgrade-snapshot-"));
    const path = join(root, "source.sqlite");
    const db = openDatabase(path);
    db.exec("INSERT INTO settings VALUES('evidence','retained')");
    db.exec(
      repair ? "DROP TABLE client_activity" : "DROP TABLE project_icons; PRAGMA user_version=37",
    );
    const before = db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
    db.close();
    const query = Database.prototype.query;
    let failedDb: Database | undefined;
    const probe = spyOn(Database.prototype, "query").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      if (sql === "VACUUM INTO ?") {
        failedDb = this;
        throw new Error("snapshot failed");
      }
      return query.call(this, sql);
    } as typeof query);
    try {
      expect(() => openDatabase(path)).toThrow("snapshot failed");
      expect(failedDb).toBeDefined();
      expect(() => failedDb?.exec("SELECT 1")).toThrow();
      const retained = new Database(path);
      try {
        expect(retained.query("PRAGMA user_version").get()).toEqual({
          user_version: repair ? SCHEMA_VERSION : 37,
        });
        expect(
          retained.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(),
        ).toEqual(before);
        expect(retained.query("SELECT value FROM settings WHERE key='evidence'").get()).toEqual({
          value: "retained",
        });
        expect(retained.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        retained.close();
      }
      expect(readdirSync(root).filter((name) => name.includes("before-v"))).toEqual([]);
    } finally {
      probe.mockRestore();
      failedDb?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const repair of [false, true]) {
  test(`upgrade retains a readable pre-migration snapshot (repair=${repair})`, () => {
    const root = mkdtempSync(join(tmpdir(), "allgather-upgrade-backup-"));
    const path = join(root, "source.sqlite");
    let db = openDatabase(path);
    try {
      db.exec("INSERT INTO settings VALUES('evidence','retained')");
      db.exec(
        repair ? "DROP TABLE client_activity" : "DROP TABLE project_icons; PRAGMA user_version=37",
      );
      const before = db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
      db.close();
      db = openDatabase(path);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE name=?")
          .get(repair ? "client_activity" : "project_icons"),
      ).not.toBeNull();
      const backups = readdirSync(root).filter((name) => name.includes("before-v"));
      expect(backups).toHaveLength(1);
      const backupPath = join(root, backups[0]);
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
      const backup = new Database(backupPath, { readonly: true });
      try {
        expect(backup.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).toEqual(
          before,
        );
        expect(backup.query("SELECT value FROM settings WHERE key='evidence'").get()).toEqual({
          value: "retained",
        });
        expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        backup.close();
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
