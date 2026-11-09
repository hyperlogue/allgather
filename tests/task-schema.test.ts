import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/storage.ts";
import { migrateTaskSchema } from "../server/task-schema-migration.ts";
import { Workspace } from "../server/workspace.ts";
import {
  type Operation,
  operations,
  type Principal,
  type Project,
  type Task,
  type TaskContext,
} from "../shared/contracts.ts";
import { mcpOperations } from "../shared/mcp-surface.ts";

const owner: Principal = { id: "owner", kind: "owner", scopes: ["admin"], inlet: "browser" };
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const w = new Workspace(db);
  const call = <T>(op: Operation, input: Record<string, unknown> = {}) =>
    w.execute(
      op,
      { ...(operations[op].write ? { operation_key: randomUUID() } : {}), ...input },
      owner,
    ) as T;
  const project = call<Project>("projects_create", { name: "Tasks" });
  const create = (title: string) => call<Task>("tasks_create", { project_id: project.id, title });
  const change = (op: Operation, task: Task, input: Record<string, unknown> = {}) =>
    call<Task>(op, { task_id: task.id, expected_revision: w.task(task.id).revision, ...input });
  const context = (task: Task) => call<TaskContext>("tasks_context", { task_id: task.id });
  return { db, w, call, create, change, context };
}

test("mixed blockers, cancellation, resolution and reopening derive the three statuses", () => {
  const { w, create, change, context, call } = setup();
  const prerequisite = create("Parser"),
    dependent = create("Export"),
    alreadyClosed = create("Old export");
  for (const task of [dependent, alreadyClosed])
    change("tasks_block", task, {
      waiting_on: "task",
      waiting_on_task_id: prerequisite.id,
      body: "Need the parser",
    });
  change("tasks_block", dependent, { waiting_on: "human", body: "Choose a format" });
  expect(w.task(dependent.id)).toMatchObject({
    status: "blocked",
    needs_owner: true,
    is_done: false,
  });
  change("tasks_cancel", prerequisite, { labels: ["done", "duplicate"], comment: "Not delivered" });
  expect(w.task(prerequisite.id)).toMatchObject({ status: "closed", is_done: false });
  expect(w.task(dependent.id).status).toBe("blocked");
  change("tasks_reopen", prerequisite, { reason: "Actually needed" });
  change("tasks_resolve", prerequisite, { comment: "Parser delivered" });
  expect(context(dependent).blockers.find((b) => b.waiting_on === "task")).toMatchObject({
    satisfied: true,
    cleared_at: null,
  });
  expect(w.task(dependent.id).status).toBe("blocked");
  const human = context(dependent).blockers.find((b) => b.waiting_on === "human")!;
  change("tasks_clear_blocker", dependent, { blocker_id: human.id, comment: "CSV" });
  expect(w.task(dependent.id).status).toBe("open");
  change("tasks_resolve", alreadyClosed);
  change("tasks_reopen", prerequisite, { reason: "Parser needs another fix" });
  expect(w.task(prerequisite.id).is_done).toBe(false);
  expect(w.task(dependent.id).status).toBe("blocked");
  expect(w.task(alreadyClosed.id)).toMatchObject({ status: "closed", is_done: true });
  change("tasks_reopen", alreadyClosed, { reason: "Recheck export" });
  expect(w.task(alreadyClosed.id).status).toBe("blocked");
  expect(
    call<{ items: Task[] }>("tasks_search", { status: "blocked" })
      .items.map((t) => t.id)
      .sort(),
  ).toEqual([dependent.id, alreadyClosed.id].sort());
  expect(() => change("tasks_resolve", dependent)).toThrow("blockers");
  change("tasks_cancel", dependent, { labels: ["superseded"] });
  expect(w.task(dependent.id)).toMatchObject({
    status: "closed",
    is_done: false,
    labels: ["superseded"],
  });
});

test("blocker target constraints and cycles cover satisfied references too", () => {
  const { create, change, context, call, db } = setup(),
    a = create("A"),
    b = create("B");
  expect(() => change("tasks_block", a, { waiting_on: "task", body: "Missing ID" })).toThrow(
    "Invalid request",
  );
  expect(() =>
    change("tasks_block", a, {
      waiting_on: "human",
      waiting_on_task_id: b.id,
      body: "Wrong target",
    }),
  ).toThrow("Invalid request");
  expect(() =>
    change("tasks_block", a, { waiting_on: "task", waiting_on_task_id: a.id, body: "Self" }),
  ).toThrow("cycle");
  change("tasks_resolve", b);
  change("tasks_block", a, { waiting_on: "task", waiting_on_task_id: b.id, body: "Required" });
  expect(() =>
    change("tasks_block", a, { waiting_on: "task", waiting_on_task_id: b.id, body: "Duplicate" }),
  ).toThrow("already");
  change("tasks_reopen", b, { reason: "Retry" });
  expect(() =>
    change("tasks_block", b, { waiting_on: "task", waiting_on_task_id: a.id, body: "Cycle" }),
  ).toThrow("cycle");
  const blocker = context(a).blockers[0];
  expect(() =>
    change("tasks_clear_blocker", a, { blocker_id: blocker.id, comment: "Skip" }),
  ).toThrow("automatically");
  expect(() =>
    change("tasks_remove_blocker", b, { blocker_id: blocker.id, comment: "Wrong task" }),
  ).toThrow("not found");
  change("tasks_remove_blocker", a, { blocker_id: blocker.id, comment: "No longer required" });
  expect(context(a).blockers).toEqual([]);
  expect(context(a).comments.items.at(-1)?.body).toBe("No longer required");
  expect(
    db
      .query(
        "SELECT change_kind FROM audit_changes WHERE entity_type='task_blockers' AND entity_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(blocker.id),
  ).toEqual({ change_kind: "delete" });
  expect(() => change("tasks_update", a, { is_done: true })).toThrow();
  expect(() =>
    call("task_comments_add", { task_id: a.id, body: "Answer", resolve_blocker_id: blocker.id }),
  ).toThrow();
  expect([...mcpOperations]).not.toContain("tasks_claim");
  expect([...mcpOperations]).not.toContain("tasks_finish");
  expect([...mcpOperations]).toContain("tasks_resolve");
});

test("resolve and clear are atomic and exact retries do not duplicate comments", () => {
  const { create, change, call, context, w, db } = setup(),
    t = create("Result");
  const input = {
    task_id: t.id,
    expected_revision: 1,
    operation_key: "resolved-once",
    comment: "Delivered",
    labels: ["verified"],
  };
  const first = call<Task>("tasks_resolve", input);
  expect(call<Task>("tasks_resolve", input)).toEqual(first);
  expect(context(t).comments.items).toHaveLength(1);
  expect(() => call("tasks_cancel", input)).toThrow();
  change("tasks_reopen", t, { reason: "Another result" });
  db.exec(
    "CREATE TEMP TRIGGER reject_comment BEFORE INSERT ON task_comments BEGIN SELECT RAISE(ABORT,'comment rejected'); END",
  );
  expect(() =>
    change("tasks_resolve", t, { comment: "Must roll back", labels: ["wrong"] }),
  ).toThrow("comment rejected");
  expect(w.task(t.id)).toMatchObject({ status: "open", is_done: false, labels: ["verified"] });
  db.exec("DROP TRIGGER reject_comment");
  change("tasks_block", t, { waiting_on: "external", body: "Provider unavailable" });
  const blocker = context(t).blockers[0];
  const clear = {
    task_id: t.id,
    expected_revision: w.task(t.id).revision,
    blocker_id: blocker.id,
    comment: "Provider restored",
    operation_key: "clear-once",
  };
  call("tasks_clear_blocker", clear);
  call("tasks_clear_blocker", clear);
  expect(context(t).comments.items.filter((c) => c.body === "Provider restored")).toHaveLength(1);
});

test("physical task targets use indexed joins in both directions", () => {
  const { create, change, db } = setup(),
    a = create("A"),
    b = create("B");
  change("tasks_block", b, { waiting_on: "task", waiting_on_task_id: a.id, body: "Required" });
  const plans = [
    [
      "SELECT t.id FROM task_blockers b JOIN tasks t ON t.id=b.task_id WHERE b.waiting_on='task' AND b.waiting_on_task_id=?",
      a.id,
    ],
    [
      "SELECT t.is_done FROM task_blockers b JOIN tasks t ON t.id=b.waiting_on_task_id WHERE b.waiting_on='task' AND b.task_id=?",
      b.id,
    ],
  ];
  for (const [sql, id] of plans) {
    const plan = db
      .query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(id)
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toContain("INDEX");
    expect(plan).not.toContain("SCAN");
  }
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("schema upgrade retains task results, ordinary waits, comments, and prerequisites", () => {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,status TEXT NOT NULL CHECK(status IN ('open','done','cancelled')),closed_at TEXT,updated_at TEXT,created_at TEXT);
    CREATE INDEX tasks_v5_project ON tasks(project_id,status,updated_at);
    CREATE TABLE task_comments(id TEXT PRIMARY KEY,body TEXT);
    CREATE TABLE task_claims(task_id TEXT PRIMARY KEY REFERENCES tasks(id));
    CREATE TABLE task_prerequisites(task_id TEXT REFERENCES tasks(id),prerequisite_id TEXT REFERENCES tasks(id));
    CREATE TABLE task_blockers(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),waiting_on TEXT,body TEXT,created_at TEXT,resolved_at TEXT,resolved_comment_id TEXT REFERENCES task_comments(id));
    INSERT INTO tasks VALUES('a','p','done','2026-01-01','2026-01-01','2026-01-01'),('b','p','open',NULL,'2026-01-01','2026-01-01'),('c','p','cancelled','2026-01-01','2026-01-01','2026-01-01');
    INSERT INTO task_comments VALUES('answer','Yes');
    INSERT INTO task_blockers VALUES('human','b','owner','Decision','2026-01-01',NULL,NULL),('cleared','b','external','External','2026-01-01','2026-01-02','answer');
    INSERT INTO task_prerequisites VALUES('b','a');
    INSERT INTO task_claims VALUES('b');
    PRAGMA user_version=36;`);
  migrateTaskSchema(db);
  expect(db.query("SELECT id,is_done FROM tasks ORDER BY id").all()).toEqual([
    { id: "a", is_done: 1 },
    { id: "b", is_done: 0 },
    { id: "c", is_done: 0 },
  ]);
  expect(db.query("SELECT waiting_on FROM task_blockers WHERE id='human'").get()).toEqual({
    waiting_on: "human",
  });
  expect(
    db.query("SELECT resolution_comment_id FROM task_blockers WHERE id='cleared'").get(),
  ).toEqual({ resolution_comment_id: "answer" });
  expect(
    db.query("SELECT task_id,waiting_on_task_id FROM task_blockers WHERE waiting_on='task'").all(),
  ).toEqual([{ task_id: "b", waiting_on_task_id: "a" }]);
  expect(
    db
      .query("SELECT name FROM sqlite_master WHERE name IN ('task_claims','task_prerequisites')")
      .all(),
  ).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.exec("UPDATE tasks SET is_done=1 WHERE id='b'")).toThrow();
});
