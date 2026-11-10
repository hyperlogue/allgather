import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import {
  type Operation,
  operations,
  type Principal,
  type Project,
  type Task,
} from "../shared/contracts.ts";

const owner: Principal = { id: "owner", kind: "owner", scopes: ["admin"], inlet: "browser" };
function setup() {
  const db = openDatabase(":memory:");
  const w = new Workspace(db);
  const call = <T>(name: Operation, input: Record<string, unknown> = {}, principal = owner) =>
    w.execute(
      name,
      { ...(operations[name].write ? { operation_key: randomUUID() } : {}), ...input },
      principal,
    ) as T;
  return { db, w, call };
}

test("fallback is persistent, collision-safe, inferred from context, and retry-safe", () => {
  const { db, call } = setup();
  try {
    const existing = call<Project>("projects_create", { name: "Inbox", slug: "INBOX" });
    const input = { title: "Unsorted", operation_key: randomUUID() };
    const task = call<Task>("tasks_create", input);
    expect(call<Task>("tasks_create", input)).toEqual(task);
    expect(task.project_id).not.toBe(existing.id);
    const inbox = call<Project>("projects_get", { project_id: task.project_id });
    expect(inbox.name).toBe("Inbox 2");
    expect(call<Task>("tasks_create", { title: "Another" }).project_id).toBe(inbox.id);
    expect(call<Task>("tasks_create", { title: "Child", parent_id: task.id }).project_id).toBe(
      inbox.id,
    );
    const explicit = call<Task>("tasks_create", { title: "Explicit", project_id: existing.id });
    expect(
      call<Task>("tasks_create", { title: "Discovered", discovered_from: explicit.id }).project_id,
    ).toBe(existing.id);
    const plan = call<{ tasks: Task[] }>("tasks_plan_create", {
      tasks: [
        { key: "root", title: "Plan" },
        { key: "child", title: "Step", parent_key: "root" },
      ],
    });
    expect(plan.tasks.every((t) => t.project_id === inbox.id)).toBe(true);
    expect(() => call("tasks_create", { title: "Invalid", project_id: "missing" })).toThrow(
      "Project not found",
    );
    call("projects_update", {
      project_id: inbox.id,
      expected_revision: inbox.revision,
      name: "Unsorted",
    });
    expect(call<Task>("tasks_create", { title: "After rename" }).project_id).toBe(inbox.id);
  } finally {
    db.close();
  }
});

test("moving a subtree preserves identity and comments, detaches its parent, and guards revisions", () => {
  const { db, w, call } = setup();
  try {
    const a = call<Project>("projects_create", { name: "Alpha" });
    const b = call<Project>("projects_create", { name: "Beta" });
    const parent = call<Task>("tasks_create", { title: "Parent", project_id: a.id });
    const task = call<Task>("tasks_create", { title: "Move", parent_id: parent.id });
    const child = call<Task>("tasks_create", { title: "Child", parent_id: task.id });
    const comment = call<{ id: string }>("task_comments_add", {
      task_id: child.id,
      body: "Keep this",
    });
    const input = {
      task_id: task.id,
      project_id: b.id,
      expected_revision: task.revision,
      operation_key: randomUUID(),
    };
    const moved = call<Task>("tasks_update", input);
    expect(moved.id).toBe(task.id);
    expect(moved.project_id).toBe(b.id);
    expect(moved.parent_id).toBeNull();
    expect(call<Task>("tasks_update", input)).toEqual(moved);
    const movedChild = call<Task>("tasks_get", { task_id: child.id });
    expect(movedChild.project_id).toBe(b.id);
    expect(movedChild.parent_id).toBe(task.id);
    expect(movedChild.revision).toBe(child.revision + 1);
    expect(w.graph.entity(comment.id).project_id).toBe(b.id);
    expect(w.graph.entity(child.id).project_id).toBe(b.id);
    expect(() => call("tasks_update", { ...input, operation_key: randomUUID() })).toThrow(
      "task changed",
    );
    expect(() =>
      call("tasks_update", {
        task_id: task.id,
        project_id: a.id,
        parent_id: child.id,
        expected_revision: moved.revision,
      }),
    ).toThrow("cycle");
    expect(call<Task>("tasks_get", { task_id: task.id }).project_id).toBe(b.id);
    expect(call<Task>("tasks_get", { task_id: child.id }).revision).toBe(movedChild.revision);
  } finally {
    db.close();
  }
});

test("fallback and moves respect source and destination project grants", () => {
  const { db, call } = setup();
  try {
    const task = call<Task>("tasks_create", { title: "Private" });
    const b = call<Project>("projects_create", { name: "Allowed" });
    const client: Principal = {
      id: "client",
      kind: "client",
      scopes: ["tasks:read", "tasks:write"],
      inlet: "mcp",
      resources: { project_ids: [b.id], machine_ids: [], unassigned: true },
    };
    expect(() => call("tasks_create", { title: "No access" }, client)).toThrow("not granted");
    expect(() =>
      call(
        "tasks_update",
        { task_id: task.id, project_id: b.id, expected_revision: task.revision },
        client,
      ),
    ).toThrow("not granted");
    const allowed = call<Task>("tasks_create", { title: "Allowed", project_id: b.id }, client);
    expect(() =>
      call(
        "tasks_update",
        { task_id: allowed.id, project_id: task.project_id, expected_revision: allowed.revision },
        client,
      ),
    ).toThrow("not granted");
  } finally {
    db.close();
  }
});
