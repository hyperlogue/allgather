import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import {
  type AgentSession,
  type Operation,
  operations,
  type Principal,
  type Project,
  type Role,
  type Task,
  type TaskContext,
} from "../shared/contracts.ts";

const owner: Principal = { id: "owner", kind: "owner", scopes: ["admin"], inlet: "browser" },
  agent: Principal = {
    id: "client",
    kind: "client",
    scopes: ["tasks:read", "tasks:write"],
    inlet: "mcp",
  };
test("one role per stable session, immutable role snapshots, and atomic handoff without a separate lifecycle", () => {
  const db = openDatabase(":memory:"),
    w = new Workspace(db);
  const call = <T>(name: Operation, input: Record<string, unknown> = {}, p = owner) =>
    w.execute(
      name,
      { ...(operations[name].write ? { operation_key: randomUUID() } : {}), ...input },
      p,
    ) as T;
  try {
    const project = call<Project>("projects_create", { name: "Example" }),
      role = call<Role>("roles_create", { name: "Reviewer" }),
      other = call<Role>("roles_create", { name: "Builder" }),
      task = call<Task>("tasks_create", { project_id: project.id, title: "Review" });
    const early = call<{ id: string }>(
      "task_comments_add",
      { task_id: task.id, body: "Initial context", session_id: "run", operator_name: "First name" },
      agent,
    );
    let session = call<AgentSession>("sessions_get", { target_session_id: "run" });
    expect(session.role_id).toBeNull();
    session = call("sessions_bind_role", {
      target_session_id: "run",
      role_id: role.id,
      expected_revision: session.revision,
    });
    expect(session.role_id).toBe(role.id);
    expect(
      call<AgentSession>("sessions_bind_role", {
        target_session_id: "run",
        role_id: role.id,
        expected_revision: 1,
      }).role_id,
    ).toBe(role.id);
    expect(() =>
      call("sessions_bind_role", {
        target_session_id: "run",
        role_id: other.id,
        expected_revision: session.revision,
      }),
    ).toThrow("already has a role");
    const comment = call<{ role_id: string; operator_name: string }>(
      "task_comments_add",
      { task_id: task.id, body: "Reviewed", session_id: "run", operator_name: "New name" },
      agent,
    );
    expect(comment.role_id).toBe(role.id);
    expect(
      w.one<{ role_id: null }>("SELECT role_id FROM task_comments WHERE id=?", early.id)!.role_id,
    ).toBeNull();
    expect(w.all("SELECT * FROM agent_sessions")).toHaveLength(1);
    call("tasks_claim", { task_id: task.id, expected_revision: 1, session_id: "run" }, agent);
    const stale = call<TaskContext>("tasks_context", { task_id: task.id });
    call("task_comments_add", { task_id: task.id, body: "New evidence" });
    expect(() =>
      call(
        "tasks_handoff",
        {
          task_id: task.id,
          expected_revision: 2,
          expected_log_sequence: stale.log_sequence,
          assignee: { kind: "role", id: other.id },
          comment: "Handoff",
          session_id: "run",
        },
        agent,
      ),
    ).toThrow("latest work log");
    const current = call<TaskContext>("tasks_context", { task_id: task.id });
    const handed = call<Task>(
      "tasks_handoff",
      {
        task_id: task.id,
        expected_revision: 2,
        expected_log_sequence: current.log_sequence,
        assignee: { kind: "role", id: other.id },
        comment: "Please implement this finding",
        session_id: "run",
      },
      agent,
    );
    expect(handed.claim).toBeNull();
    expect(handed.assignee).toEqual({ kind: "role", id: other.id });
    expect(handed.status).toBe("open");
    expect(w.one<{ n: number }>("SELECT COUNT(*) n FROM legacy_handoffs")!.n).toBe(0);
    expect(() =>
      call("roles_delete", { role_id: role.id, expected_revision: role.revision }),
    ).toThrow("Referenced roles");
    expect(() =>
      db.query("UPDATE task_comments SET body=? WHERE id=?").run("tampered", early.id),
    ).toThrow();
    const comments = call<TaskContext>("tasks_context", { task_id: task.id }).comments.items;
    expect(comments.at(-1)?.body).toBe("Please implement this finding");
    expect(comments.at(-1)?.role_name).toBe("Reviewer");
  } finally {
    db.close();
  }
});
