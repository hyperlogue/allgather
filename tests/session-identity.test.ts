import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import {
  type AgentSession,
  type Operation,
  operations,
  type Page,
  type Principal,
  type Task,
} from "../shared/contracts.ts";
import { fixtureOwner, fullControls } from "./fixtures/tower-controls.ts";

function fixture() {
  const db = openDatabase(":memory:"),
    w = new Workspace(db),
    owner = fixtureOwner(w);
  const call = <T = any>(
    name: Operation,
    input: Record<string, unknown> = {},
    principal: Principal = owner,
  ) =>
    w.execute(
      name,
      { ...(operations[name].write ? { operation_key: randomUUID() } : {}), ...input },
      principal,
    ) as T;
  const project = call("projects_create", { name: "Fixture" });
  return { db, w, owner, call, project };
}

test("CLI activity and later Tower observation share provider/native identity without a managed execution", () => {
  const { db, w, call, project } = fixture();
  try {
    const agent: Principal = {
      id: "fixture-cli",
      kind: "client",
      inlet: "api",
      scopes: ["tasks:write"],
      resources: { project_ids: "*", machine_ids: "*", unassigned: true },
    };
    const task = call<Task>(
      "tasks_create",
      {
        title: "Native identity",
        project_id: project.id,
        operator_kind: "agent",
        agent_type: "codex",
        session_id: "codex:native-one",
        operator_name: "codex:native-one",
      },
      agent,
    );
    const before = call<AgentSession>("sessions_get", { target_session_id: "codex:native-one" });
    expect(before.native_session_id).toBe("native-one");
    const machine = call("machines_create", { name: "First" });
    w.sessions.observe(machine.id, "opaque-tower-id", {
      harness: "codex",
      native_session_id: "native-one",
      display_name: "Fix native identity",
    });
    const sessions = call<Page<AgentSession>>("sessions_list");
    expect(sessions.items).toHaveLength(1);
    expect(sessions.items[0]).toMatchObject({
      id: before.id,
      label: "Fix native identity",
      native_provider: "codex",
    });
    expect(sessions.items[0].observations?.[0].machine_id).toBe(machine.id);
    expect(call("session_runtime_get", { target_session_id: before.id }).runtime).toBeNull();
    expect(
      call("audit_list", { run_id: before.id }).items.some(
        (row: any) => row.operation === "tasks_create",
      ),
    ).toBe(true);
    expect(call("tasks_context", { task_id: task.id }).task.id).toBe(task.id);
  } finally {
    db.close();
  }
});

test("Tower-first observation is reused by later CLI activity and provider aliases match", () => {
  const { db, w, call, project } = fixture();
  try {
    const machine = call("machines_create", { name: "First" });
    w.sessions.observe(machine.id, "opaque-local", {
      harness: "claude-code",
      native_session_id: "native-one",
      display_name: "Existing conversation",
    });
    const canonical = call<Page<AgentSession>>("sessions_list").items[0].id;
    call(
      "tasks_create",
      {
        project_id: project.id,
        title: "Work",
        operator_kind: "agent",
        agent_type: "claude",
        session_id: "claude:native-one",
      },
      {
        id: "agent",
        kind: "client",
        inlet: "api",
        scopes: ["tasks:write"],
        resources: { project_ids: "*", machine_ids: "*", unassigned: true },
      },
    );
    expect(call<Page<AgentSession>>("sessions_list").items).toHaveLength(1);
    expect(call<AgentSession>("sessions_get", { target_session_id: "claude:native-one" }).id).toBe(
      canonical,
    );
    expect(call<Page<AgentSession>>("sessions_search", { query: "native-one" }).items[0].id).toBe(
      canonical,
    );
    expect(
      call<Page<AgentSession>>("sessions_search", { query: "claude:native-one" }).items[0].id,
    ).toBe(canonical);
    const separate = call<AgentSession>("sessions_declare", {
      target_session_id: "codex-record",
      harness: "codex",
      source_namespace: "import",
      native_session_id: "native-one",
    });
    expect(separate.id).not.toBe(canonical);
    expect(call<Page<AgentSession>>("sessions_list").items).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("existing records merge histories and relationships while retaining source identity and conflict evidence", () => {
  const { db, w, call, project } = fixture();
  try {
    const roleA = call("roles_create", { name: "Writer" }),
      roleB = call("roles_create", { name: "Reviewer" });
    const other = call("projects_create", { name: "Other" });
    const first = call<AgentSession>("sessions_declare", {
      target_session_id: "first",
      harness: "claude",
      label: "First label",
      project_id: project.id,
      role_id: roleA.id,
    });
    const second = call<AgentSession>("sessions_declare", {
      target_session_id: "second",
      harness: "claude-code",
      label: "Second label",
      project_id: other.id,
      role_id: roleB.id,
    });
    const task = call<Task>("tasks_create", {
      project_id: other.id,
      title: "Linked",
      assignee: { kind: "session", id: second.id },
    });
    call("links_add", { source_id: second.id, target_id: task.id, type: "works_on" });
    const importTo = (id: string, text: string) =>
      call("session_transcript_import", {
        target_session_id: id,
        source_key: "same-source",
        coverage: "partial",
        events: [{ key: "event-1", kind: "agent_message", payload: { text } }],
      });
    w.run("INSERT INTO session_aliases VALUES(?,?)", "legacy-second", second.id);
    importTo(first.id, "First message");
    importTo("legacy-second", "Second message");
    const immutable = w.all("SELECT * FROM session_events ORDER BY id");
    call("sessions_declare", {
      target_session_id: first.id,
      harness: "claude",
      source_namespace: "first-import",
      native_session_id: "same-native",
    });
    const merged = call<AgentSession>("sessions_declare", {
      target_session_id: second.id,
      harness: "claude-code",
      source_namespace: "second-import",
      native_session_id: "same-native",
    });
    expect(merged.id).toBe(first.id);
    expect(merged.aliases).toContain(second.id);
    expect(merged.identity_warnings?.map((w) => w.field)).toEqual(
      expect.arrayContaining(["label", "role_id", "project_id", "transcript_source"]),
    );
    expect(call<Page<AgentSession>>("sessions_list").items).toHaveLength(1);
    expect(call<Page<AgentSession>>("sessions_search", { project_id: other.id }).items[0].id).toBe(
      first.id,
    );
    expect(
      call("links_context", { entity_id: first.id }).neighbors.some((n: any) => n.id === task.id),
    ).toBe(true);
    for (const id of [first.id, second.id, "legacy-second"]) {
      expect(
        call<Page<Task>>("tasks_search", { assignee: { kind: "session", id } }).items.map(
          (t) => t.id,
        ),
      ).toContain(task.id);
    }
    const audits = call("audit_list", { entity_id: first.id, limit: 100 });
    expect(
      audits.items.some((a: any) => a.changes.some((c: any) => c.entity_id === second.id)),
    ).toBe(true);
    const events = call("session_transcript_events", { target_session_id: second.id });
    expect(events.items.map((e: any) => e.payload.text)).toEqual([
      "First message",
      "Second message",
    ]);
    expect(events.items.map((e: any) => e.sequence)).toEqual([1, 2]);
    expect(events.content_revision).toBeGreaterThan(0);
    expect(w.all("SELECT * FROM session_events ORDER BY id")).toEqual(immutable);
    expect(importTo(second.id, "Second message").added).toBe(0);
    expect(importTo("legacy-second", "Second message").added).toBe(0);
    expect(call("session_transcript_sources", { target_session_id: first.id })).toHaveLength(2);
    const preview = call("transcript_delete_preview", { target_session_id: second.id });
    expect(preview.events).toBe(2);
    call("transcript_delete", {
      target_session_id: second.id,
      through_sequence: preview.through_sequence,
      through_asset_sequence: preview.through_asset_sequence,
    });
    expect(
      call("session_transcript_events", { target_session_id: first.id }).items.every(
        (e: any) => e.payload.deleted,
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});

test("reconciliation never broadens project or machine access", () => {
  const { db, w, call, project } = fixture();
  try {
    const other = call("projects_create", { name: "Other" });
    call("sessions_declare", {
      target_session_id: "a",
      harness: "codex",
      project_id: project.id,
      source_namespace: "one",
      native_session_id: "native",
    });
    call("sessions_declare", {
      target_session_id: "b",
      harness: "codex",
      project_id: other.id,
      source_namespace: "two",
      native_session_id: "native",
    });
    const machine = call("machines_create", { name: "First" });
    w.sessions.observe(machine.id, "tower", { harness: "codex", native_session_id: "native" });
    const limited: Principal = {
      id: "limited",
      kind: "client",
      inlet: "mcp",
      scopes: ["sessions:read"],
      resources: { project_ids: [project.id], machine_ids: "*", unassigned: false },
    };
    expect(call<Page<AgentSession>>("sessions_list", {}, limited).items).toHaveLength(0);
    expect(() => call("sessions_get", { target_session_id: "b" }, limited)).toThrow("not granted");
    for (const alias of ["a", "b", "codex:native"]) {
      expect(w.access.run(limited, () => w.access.entity(alias))).toBe(false);
    }
    const unassignedOnly = {
      ...limited,
      resources: { project_ids: [], machine_ids: "*" as const, unassigned: true },
    };
    expect(
      w.access.run(unassignedOnly, () => w.access.towerRecord(machine.id, { id: "tower" })),
    ).toBe(false);
    const noMachine = {
      ...limited,
      resources: { project_ids: "*" as const, machine_ids: [], unassigned: true },
    };
    expect(call<Page<AgentSession>>("sessions_list", {}, noMachine).items).toHaveLength(0);
    const full = {
      ...limited,
      resources: { project_ids: "*" as const, machine_ids: "*" as const, unassigned: true },
    };
    expect(call<Page<AgentSession>>("sessions_list", {}, full).items).toHaveLength(1);
    expect(() =>
      call(
        "tasks_create",
        {
          project_id: project.id,
          title: "Spoof",
          operator_kind: "agent",
          agent_type: "codex",
          session_id: "codex:native",
        },
        { ...limited, inlet: "api", scopes: ["tasks:write"] },
      ),
    ).toThrow("not granted");
  } finally {
    db.close();
  }
});

test("merged runtime namespaces keep wire ownership and refuse ambiguous control", () => {
  const { db, w, call } = fixture();
  try {
    const machine = call("machines_create", { name: "Runtime fixture" });
    const credential = w.executions.issueCredential(machine.id, "Fixture", [
      "read",
      "send",
      "acp:control",
    ]);
    w.run(
      "UPDATE machines SET connected=1,active_credential_id=?,capabilities=?,harnesses=?,harness_controls=? WHERE id=?",
      credential.id,
      JSON.stringify([
        "managed-acp.v1",
        "command-receipts.v1",
        "session-stream.v1",
        "session-resume.v1",
        "session-force-resume.v1",
      ]),
      JSON.stringify(["codex"]),
      JSON.stringify({ codex: fullControls("codex-app-server") }),
      machine.id,
    );
    const first = call("session_launch", {
      machine_id: machine.id,
      harness: "codex",
      cwd: "/work/one",
    });
    const second = call("session_launch", {
      machine_id: machine.id,
      harness: "codex",
      cwd: "/work/two",
    });
    for (const item of [first, second]) {
      w.run(
        "UPDATE session_runtimes SET state='idle',native_session_id='same-native',owner_id=?,tower_session_id=? WHERE id=?",
        item.runtime.id,
        item.runtime.id,
        item.runtime.id,
      );
      w.recordSessionObservation(machine.id, () => ({
        session_id: w.sessions.identity.register(item.session.id, "codex", "same-native"),
      }));
    }
    const merged = call<AgentSession>("sessions_get", { target_session_id: second.session.id });
    expect(merged.id).toBe(first.session.id);
    expect(merged.identity_warnings?.some((w) => w.field === "execution")).toBe(true);
    expect(call("session_runtime_get", { target_session_id: merged.id }).runtime).toBeNull();
    const before = w.one<{ n: number }>("SELECT COUNT(*) n FROM session_commands")!.n;
    expect(() =>
      call("session_prompt", {
        target_session_id: merged.id,
        content: [{ type: "text", text: "Do not route ambiguously" }],
      }),
    ).toThrow("different control namespaces");
    expect(w.one<{ n: number }>("SELECT COUNT(*) n FROM session_commands")!.n).toBe(before);
    w.run(
      "UPDATE session_runtimes SET state='ended',fenced=1,termination='confirmed' WHERE id=?",
      second.runtime.id,
    );
    const prompt = call("session_prompt", {
      target_session_id: second.session.id,
      content: [{ type: "text", text: "Explicit surviving execution" }],
    });
    expect(prompt.session_id).toBe(first.runtime.session_id);
    expect(prompt.runtime_id).toBe(first.runtime.id);
    w.run(
      "UPDATE session_runtimes SET state='ended',fenced=1,termination='confirmed' WHERE id=?",
      first.runtime.id,
    );
    const resumed = call("session_resume", {
      target_session_id: merged.id,
      machine_id: machine.id,
      cwd: "/work/two",
    });
    expect(resumed.session.id).toBe(merged.id);
    expect(resumed.runtime.session_id).toBe(second.runtime.session_id);
    expect(resumed.command.session_id).toBe(second.runtime.session_id);
    expect(resumed.command.payload.resume_session_id).toBe("same-native");
  } finally {
    db.close();
  }
});

test("metadata conflicts are warnings, native IDs stay case-sensitive, and repeated observations stay quiet", () => {
  const { db, w, call, project } = fixture();
  try {
    const first = call<AgentSession>("sessions_declare", {
      target_session_id: "one",
      harness: "codex",
      project_id: project.id,
      label: "Original",
      source_namespace: "import",
      native_session_id: "Native",
    });
    const second = call<AgentSession>("sessions_declare", {
      target_session_id: "two",
      harness: "codex",
      project_id: project.id,
      source_namespace: "import",
      native_session_id: "native",
    });
    expect(first.id).not.toBe(second.id);
    const warned = call<AgentSession>("sessions_declare", {
      target_session_id: first.id,
      harness: "codex",
      source_namespace: "import",
      native_session_id: "native",
    });
    expect(warned.native_session_id).toBe("Native");
    expect(warned.identity_warnings?.some((w) => w.field === "native_identity")).toBe(true);
    expect(call<Page<AgentSession>>("sessions_list").items).toHaveLength(2);
    const machine = call("machines_create", { name: "Observer" });
    const record = {
      harness: "codex",
      native_session_id: "Native",
      display_name: "Conflicting label",
    };
    w.sessions.observe(machine.id, "local", record);
    const count = w.one<{ n: number }>("SELECT COUNT(*) n FROM audit_operations")!.n;
    w.sessions.observe(machine.id, "local", { ...record, status: "working", pid: 123 });
    expect(w.one<{ n: number }>("SELECT COUNT(*) n FROM audit_operations")!.n).toBe(count);
    const agent: Principal = {
      id: "agent",
      kind: "client",
      inlet: "api",
      scopes: ["tasks:write"],
      resources: { project_ids: "*", machine_ids: "*", unassigned: true },
    };
    const changed = call(
      "tasks_create",
      {
        project_id: project.id,
        title: "Work",
        operator_kind: "agent",
        agent_type: "codex",
        session_id: "codex:Native",
      },
      agent,
    );
    expect(changed.warnings.some((warning: any) => warning.code === "session_merge_conflict")).toBe(
      true,
    );
  } finally {
    db.close();
  }
});
