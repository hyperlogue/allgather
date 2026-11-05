import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import {
  type AgentSession,
  type Machine,
  type Operation,
  operations,
  type Page,
  type Principal,
  type Project,
  type Role,
  type Task,
} from "../shared/contracts.ts";
import { fixtureOwner, fullControls } from "./fixtures/tower-controls.ts";

test("session discovery combines work evidence, machine history, roles and dates without widening task-only access", () => {
  const db = openDatabase(":memory:");
  let now = new Date("2026-01-01T00:00:00Z");
  const w = new Workspace(db, () => now, undefined, { managedSessions: true }),
    owner = fixtureOwner(w),
    call = <T>(name: Operation, input: Record<string, unknown> = {}, p = owner) =>
      w.execute(
        name,
        { ...(operations[name].write ? { operation_key: randomUUID() } : {}), ...input },
        p,
      ) as T;
  try {
    const a = call<Project>("projects_create", { name: "Alpha" }),
      b = call<Project>("projects_create", { name: "Beta" }),
      ta = call<Task>("tasks_create", { project_id: a.id, title: "Alpha work" }),
      tb = call<Task>("tasks_create", { project_id: b.id, title: "Beta work" }),
      role = call<Role>("roles_create", { name: "Reviewer" });
    const machines = ["First", "Second"].map((name) => call<Machine>("machines_create", { name }));
    for (const m of machines)
      w.run(
        "UPDATE machines SET capabilities=?,harnesses=?,harness_controls=? WHERE id=?",
        JSON.stringify(["managed-acp.v1", "command-receipts.v1", "session-stream.v1"]),
        JSON.stringify(["fixture"]),
        JSON.stringify({ fixture: fullControls() }),
        m.id,
      );
    const launch = (machine: Machine, task: Task, label: string) =>
      call<{ session: AgentSession }>("session_launch", {
        machine_id: machine.id,
        task_id: task.id,
        harness: "fixture",
        cwd: "/work/project",
        role_id: role.id,
        label,
      }).session;
    const first = launch(machines[0], ta, "First run");
    expect(first).toMatchObject({ agent_type: "fixture", label: "First run", role_id: role.id });
    expect(() =>
      call("sessions_declare", { target_session_id: first.id, label: "Overwrite" }),
    ).toThrow("declare is for external sessions");
    expect(call<AgentSession>("sessions_get", { target_session_id: first.id }).label).toBe(
      "First run",
    );
    expect(() =>
      call("session_prompt", {
        target_session_id: first.id,
        content: [{ type: "text", text: "Too early" }],
      }),
    ).toThrow("confirm the ACP session");
    now = new Date("2026-01-02T00:00:00Z");
    const second = launch(machines[1], tb, "Second run");
    now = new Date("2026-01-03T00:00:00Z");
    const third = launch(machines[0], ta, "Third run");
    now = new Date("2026-01-04T00:00:00Z");
    call(
      "task_comments_add",
      {
        task_id: ta.id,
        body: "Historical contribution",
        session_id: "imported-run",
        operator_kind: "agent",
      },
      { ...owner, inlet: "api" },
    );
    const search = (input: Record<string, unknown> = {}, p = owner) =>
      call<Page<AgentSession>>("sessions_search", input, p);
    expect(search({ project_id: a.id }).items.map((s) => s.id)).toEqual([
      "imported-run",
      third.id,
      first.id,
    ]);
    expect(search({ task_id: tb.id }).items.map((s) => s.id)).toEqual([second.id]);
    expect(search({ project_id: a.id, task_id: tb.id }).total).toBe(0);
    expect(
      search({ machine_id: machines[0].id, since: "2026-01-02T00:00:00Z" }).items.map((s) => s.id),
    ).toEqual([third.id]);
    expect(
      search({ until: "2026-01-02T00:00:00Z", role_id: role.id }).items.map((s) => s.id),
    ).toEqual([second.id, first.id]);
    expect(search({ query: "THIRD RUN" }).items.map((s) => s.id)).toEqual([third.id]);
    const page = search({ project_id: a.id, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.next_cursor).toBe(1);
    expect(search({ project_id: a.id, limit: 1, cursor: page.next_cursor }).items[0].id).toBe(
      third.id,
    );
    expect(() => search({ since: "2026-02-01T00:00:00Z", until: "2026-01-01T00:00:00Z" })).toThrow(
      "start time",
    );
    const taskOnly: Principal = {
      id: "task-client",
      kind: "client",
      inlet: "mcp",
      scopes: ["tasks:read"],
    };
    expect(() => search({}, taskOnly)).toThrow("Scope sessions:read");
    expect(call<Page<AgentSession>>("sessions_list", {}, taskOnly).total).toBe(4);
    const sessionsOnly: Principal = { ...taskOnly, scopes: ["sessions:read"] };
    expect(search({ machine_id: machines[0].id }, sessionsOnly).total).toBe(2);
    expect(() => search({ project_id: a.id }, sessionsOnly)).toThrow("tasks:read");
    const command = w.one<{ id: string }>(
      "SELECT id FROM session_commands WHERE session_id=? AND kind='launch'",
      first.id,
    )!;
    w.run("UPDATE session_commands SET state='unknown' WHERE id=?", command.id);
    call("session_reconcile", {
      command_id: command.id,
      decision: "failed",
      reason: "Fixture confirms the launch was rejected",
    });
    expect(w.executions.runtime(first.id)?.state).toBe("error");
    const observed = w.one<{ id: string }>(
      "SELECT id FROM session_commands WHERE session_id=? AND kind='launch'",
      second.id,
    )!;
    w.run("UPDATE session_commands SET state='unknown' WHERE id=?", observed.id);
    w.run(
      "UPDATE session_runtimes SET acp_session_id='observed-acp-id' WHERE session_id=?",
      second.id,
    );
    expect(() =>
      call("session_reconcile", {
        command_id: observed.id,
        decision: "failed",
        reason: "Cannot discard an observed execution",
      }),
    ).toThrow("already reported");
    expect(w.executions.command(observed.id).state).toBe("unknown");
  } finally {
    db.close();
  }
});
