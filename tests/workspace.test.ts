import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fixtureResources } from "../scripts/fixture-auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import {
  type Operation,
  operations,
  type Principal,
  type Project,
  type Task,
} from "../shared/contracts.ts";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const d of databases.splice(0)) d.close();
});
export const owner: Principal = { id: "owner", kind: "owner", scopes: ["admin"], inlet: "browser" };
function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  let at = new Date("2026-01-01T00:00:00Z");
  const w = new Workspace(db, () => at);
  const call = <T>(name: Operation, input: Record<string, unknown> = {}, p = owner) =>
    w.execute(
      name,
      { ...(operations[name].write ? { operation_key: randomUUID() } : {}), ...input },
      p,
    ) as T;
  const project = call<Project>("projects_create", { name: "Example" });
  return {
    w,
    db,
    call,
    project,
    task: (title: string, fields = {}) =>
      call<Task>("tasks_create", { project_id: project.id, title, ...fields }),
    tick: (ms: number) => {
      at = new Date(at.getTime() + ms);
    },
  };
}
test("prerequisites and hierarchy are task-owned, reject cycles, and survive arbitrary context labels", () => {
  const { call, task, w } = setup(),
    a = task("A"),
    b = task("B");
  const waiting = call<Task>("tasks_block", {
    waiting_on: "task",
    body: "Required result",
    task_id: b.id,
    waiting_on_task_id: a.id,
    expected_revision: 1,
  });
  expect(waiting.status).toBe("blocked");
  expect(waiting.blocked).toBe(true);
  expect(() => call("tasks_resolve", { task_id: b.id, expected_revision: 2 })).toThrow(
    "prerequisites",
  );
  expect(() =>
    call("tasks_block", {
      waiting_on: "task",
      body: "Required result",
      task_id: a.id,
      waiting_on_task_id: b.id,
      expected_revision: 1,
    }),
  ).toThrow("cycle");
  call("links_add", { source_id: a.id, target_id: b.id, type: "depends_on" });
  expect(w.task(a.id).blocked).toBe(false);
  call("tasks_cancel", { task_id: a.id, expected_revision: 1 });
  expect(w.task(b.id).blocked).toBe(true);
  call("tasks_reopen", { task_id: a.id, expected_revision: 2, reason: "Needed" });
  call("tasks_resolve", { task_id: a.id, expected_revision: 3 });
  expect(w.task(b.id).blocked).toBe(false);
  const c = task("C");
  call("tasks_update", { task_id: c.id, parent_id: b.id, expected_revision: 1 });
  expect(() =>
    call("tasks_update", { task_id: b.id, parent_id: c.id, expected_revision: 2 }),
  ).toThrow("cycle");
  expect(w.task(b.id).revision).toBe(2);
});
test("plain deferral does not hide available work or block completion", () => {
  const { call, task, w } = setup(),
    t = task("Later", { defer_until: "2099-01-01T00:00:00Z", labels: ["P0", "p0"] });
  expect(t.labels).toEqual(["p0"]);
  expect(call<{ total: number }>("tasks_ready").total).toBe(1);
  expect(
    call<{ total: number }>("tasks_ready", { deferred_before: "2026-01-01T00:00:00Z" }).total,
  ).toBe(0);
  call("tasks_update", {
    task_id: t.id,
    expected_revision: 1,
    defer_until: "2100-01-01T00:00:00Z",
  });
  expect(w.task(t.id).status).toBe("open");
  expect(call<Task>("tasks_resolve", { task_id: t.id, expected_revision: 2 }).is_done).toBe(true);
});

test("ready uses explicit assignment filters independent of the caller", () => {
  const { call, task } = setup();
  const role = call<{ id: string }>("roles_create", { name: "Reviewer" });
  call("sessions_declare", { target_session_id: "mine", role_id: role.id });
  call("sessions_declare", { target_session_id: "other" });
  task("unassigned");
  task("mine", { assignee: { kind: "session", id: "mine" } });
  task("other", { assignee: { kind: "session", id: "other" } });
  task("role", { assignee: { kind: "role", id: role.id } });
  task("owner", { assignee: { kind: "owner", id: "owner" } });
  const agent: Principal = {
    id: "reader",
    kind: "client",
    resources: fixtureResources,
    inlet: "mcp",
    scopes: ["tasks:read"],
  };
  const titles = (principal: Principal, input = {}) =>
    call<{ items: Task[] }>("tasks_ready", input, principal)
      .items.map((t) => t.title)
      .sort();
  expect(titles(agent, { session_id: "mine" })).toEqual([
    "mine",
    "other",
    "owner",
    "role",
    "unassigned",
  ]);
  expect(titles(agent, { unassigned: true })).toEqual(["unassigned"]);
  expect(titles(agent, { assignee: { kind: "session", id: "mine" } })).toEqual(["mine"]);
  expect(titles(agent, { assignee: { kind: "role", id: role.id } })).toEqual(["role"]);
  expect(titles(agent, { assignee: { kind: "owner", id: "owner" } })).toEqual(["owner"]);
  expect(titles(owner)).toEqual(titles(agent));
  expect(() =>
    titles(agent, { unassigned: true, assignee: { kind: "owner", id: "owner" } }),
  ).toThrow("either assignee or unassigned");
  expect(Object.keys(operations)).not.toContain("tasks_next");
});
test("sessions contribute without claims and revisions reject stale task edits", () => {
  const { call, task, w } = setup(),
    t = task("Shared");
  const agent: Principal = {
    id: "agent-connection",
    kind: "client",
    resources: fixtureResources,
    scopes: ["tasks:read", "tasks:write"],
    inlet: "mcp",
  };
  call("task_comments_add", { task_id: t.id, body: "A finding", session_id: "one" }, agent);
  call("task_comments_add", { task_id: t.id, body: "Another finding", session_id: "two" }, agent);
  call(
    "tasks_update",
    { task_id: t.id, expected_revision: 1, title: "Updated", session_id: "one" },
    agent,
  );
  expect(() =>
    call("tasks_resolve", { task_id: t.id, expected_revision: 1, session_id: "two" }, agent),
  ).toThrow("revision");
  expect(
    call<Task>("tasks_resolve", { task_id: t.id, expected_revision: 2, session_id: "two" }, agent)
      .is_done,
  ).toBe(true);
  expect(w.tasks.comments(t.id, {}).items.map((c) => c.session_id)).toEqual(["one", "two"]);
});
test("mutations replay exact retries, reject stale edits, and roll back when audit capture fails", () => {
  const { call, task, w, db } = setup(),
    t = task("Work");
  const input = { task_id: t.id, expected_revision: 1, title: "Updated", operation_key: "same" };
  const result = call<Task>("tasks_update", input);
  expect(call<Task>("tasks_update", input)).toEqual(result);
  expect(() => call("tasks_update", { ...input, title: "Different" })).toThrow("different request");
  expect(() => call("tasks_update", { ...input, operation_key: "stale" })).toThrow("task changed");
  db.exec(
    "CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON audit_changes BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
  );
  expect(() =>
    call("tasks_update", { task_id: t.id, expected_revision: 2, body: "Must roll back" }),
  ).toThrow("audit unavailable");
  expect(w.task(t.id).body).toBe("");
  expect(w.task(t.id).revision).toBe(2);
});
test("scope checks apply to both context endpoints and the core interface", () => {
  const { call, task, w, project } = setup(),
    t = task("Work"),
    reader: Principal = {
      id: "reader",
      kind: "client",
      resources: fixtureResources,
      scopes: ["tasks:read"],
    };
  expect(() =>
    w.execute(
      "tasks_create",
      { project_id: project.id, title: "Denied", operation_key: "bad" },
      reader,
    ),
  ).toThrow("Scope");
  const repo = call<{ id: string }>("repositories_create", {
    project_id: project.id,
    name: "Repo",
    upstream_url: "https://example.invalid/repo.git",
  });
  call("links_add", { source_id: t.id, target_id: repo.id, type: "evidence" });
  expect(
    call<{ relations: { total: number } }>("links_context", { entity_id: t.id }, reader).relations
      .total,
  ).toBe(0);
  const writer: Principal = { ...reader, scopes: ["tasks:read", "tasks:write"] };
  expect(() =>
    call("links_add", { source_id: t.id, target_id: repo.id, type: "other" }, writer),
  ).toThrow("readable");
});
test("atomic plans reject invalid structure and compute leaf progress", () => {
  const { call, w, project } = setup();
  expect(() =>
    call("tasks_plan_create", {
      project_id: project.id,
      tasks: [
        { key: "a", title: "A", depends_on_keys: ["b"] },
        { key: "b", title: "B", depends_on_keys: ["a"] },
      ],
    }),
  ).toThrow("cycle");
  expect(w.all("SELECT * FROM tasks")).toHaveLength(0);
  const plan = call<{ mapping: Record<string, string> }>("tasks_plan_create", {
    project_id: project.id,
    tasks: [
      { key: "root", title: "Release" },
      { key: "nested", title: "Part", parent_key: "root" },
      { key: "a", title: "A", parent_key: "nested" },
      { key: "b", title: "B", parent_key: "root" },
    ],
  });
  call("tasks_resolve", { task_id: plan.mapping.a, expected_revision: 1 });
  call("tasks_cancel", { task_id: plan.mapping.b, expected_revision: 1 });
  const progress = w.tasks.progress(plan.mapping.root);
  expect(progress).toMatchObject({
    total: 2,
    done: 1,
    closed_without_completion: 1,
    open: 0,
    percent_done: 50,
  });
  expect(
    call<Task>("tasks_resolve", { task_id: plan.mapping.root, expected_revision: 1 }).is_done,
  ).toBe(true);
  expect(w.task(plan.mapping.nested).status).toBe("open");
});

test("bulk plan keys are opaque strings, including inherited object names", () => {
  const { call, project, w } = setup();
  const input = {
    operation_key: "opaque-plan-keys",
    project_id: project.id,
    tasks: [
      { key: "__proto__", title: "Parent" },
      { key: "constructor", title: "Child", parent_key: "__proto__" },
      { key: "toString", title: "Dependent", depends_on_keys: ["constructor"] },
    ],
  };
  const result = call<{ mapping: Record<string, string>; tasks: Task[] }>(
    "tasks_plan_create",
    input,
  );
  const keys = new Map(Object.entries(result.mapping));
  expect(Object.keys(result.mapping)).toHaveLength(3);
  expect(w.task(keys.get("constructor")!).parent_id).toBe(keys.get("__proto__")!);
  expect(w.task(keys.get("toString")!).dependencies).toEqual([keys.get("constructor")!]);
  expect(call<typeof result>("tasks_plan_create", input)).toEqual(result);
  expect(() =>
    call("tasks_plan_create", {
      ...input,
      operation_key: "duplicate-key",
      tasks: [input.tasks[0], input.tasks[0]],
    }),
  ).toThrow("unique");
  expect(w.all("SELECT id FROM tasks")).toHaveLength(3);
});
