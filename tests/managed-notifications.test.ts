import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { fixtureResources } from "../scripts/fixture-auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Tower, type TowerSocketData } from "../server/tower.ts";
import { Workspace } from "../server/workspace.ts";
import type { Machine, Operation, SessionCommand, SessionRuntime } from "../shared/contracts.ts";
import type { MachineScope } from "../shared/tower-acp.ts";
import { fixtureAgent, fixtureOwner, fullControls } from "./fixtures/tower-controls.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "allgather-notification-test-")),
    db = openDatabase(":memory:");
  let tower!: Tower;
  const w = new Workspace(
    db,
    () => new Date(Date.now()),
    () => tower?.wake(),
    { dataDir: root, managedSessions: true },
  );
  const owner = fixtureOwner(w);
  const agent = await fixtureAgent(w);
  tower = new Tower(w, "http://127.0.0.1:4390");
  const call = <T>(name: Operation, a: Record<string, unknown> = {}) =>
    w.execute(name, { operation_key: randomUUID(), ...a }, owner) as T;
  const artifactCall = <T>(name: Operation, a: Record<string, unknown>, p = owner) =>
    w.dispatch(name, { operation_key: randomUUID(), ...a }, p) as Promise<T>;
  const m = call<Machine>("machines_create", { name: "Notification fixture" });
  const connect = (scopes: MachineScope[] = ["read", "send", "acp:control"]) => {
    const key = w.executions.issueCredential(m.id, "Fixture", scopes),
      frames: Record<string, any>[] = [];
    const socket = {
      data: tower.authenticate(
        new Request("http://127.0.0.1:4390/tower", {
          headers: { authorization: `Bearer ${key.access_key}` },
        }),
      )!,
      send: (body: string) => {
        frames.push(JSON.parse(body));
        return 1;
      },
      close: () => tower.close(socket as unknown as ServerWebSocket<TowerSocketData>),
    } as unknown as ServerWebSocket<TowerSocketData>;
    tower.open(socket);
    const send = (message: unknown) =>
      tower.message(socket, JSON.stringify({ jsonrpc: "2.0", ...(message as object) }));
    send({
      id: "hello",
      method: "hello",
      params: {
        protocol_version: { major: 1, minor: 4 },
        host_id: "fixture-host",
        tower_version: "fixture",
        capabilities: [
          "policy-sync.v1",
          "session-status.v1",
          "managed-acp.v1",
          "command-receipts.v1",
          "session-stream.v1",
        ],
        acp_harnesses: ["fixture"],
        harness_controls: { fixture: fullControls() },
      },
    });
    const policy = frames.find((f) => f.method === "policy.push")!;
    send({
      id: policy.id,
      result: {
        policy_id: "tower",
        previous_revision: null,
        applied_revision: m.policy_revision,
        outcome: "applied",
        changed_rule_ids: [],
        reason: null,
        received_at: Date.now(),
      },
    });
    return { socket, frames, send };
  };
  let connection = connect();
  const launched = call<{ runtime: SessionRuntime; command: SessionCommand }>("session_launch", {
    machine_id: m.id,
    harness: "fixture",
    cwd: "/work/project",
  });
  const r = launched.runtime;
  let sequence = 0;
  const event = (kind: string, payload: unknown, command_id?: string) =>
    connection.send({
      id: `events-${++sequence}`,
      method: "session.events",
      params: {
        runtime_id: r.id,
        generation: r.generation,
        source_key: r.generation,
        events: [
          {
            sequence,
            key: `event-${sequence}`,
            kind,
            payload,
            ...(command_id ? { command_id } : {}),
          },
        ],
      },
    });
  const ready = () =>
    event("runtime_state", {
      state: "idle",
      owner_id: "owner-fixture",
      tower_session_id: "managed-tower-id",
      acp_session_id: "native-acp",
    });
  const accepted = (command: string) =>
    connection.send({
      id: command,
      result: {
        command_id: command,
        runtime_id: r.id,
        generation: r.generation,
        receipt_revision: 1,
        state: "accepted",
        acceptance: { level: "adapter", at: new Date().toISOString() },
        dispatch: { state: "in_flight" },
      },
    });
  accepted(launched.command.id);
  ready();
  const artifact = async () => {
    const a = await artifactCall<{ id: string }>("artifacts_create", {
      kind: "html",
      title: "Review fixture",
    });
    await artifactCall(
      "artifacts_listen",
      { artifact_id: a.id, session_id: r.session_id, operator_kind: "agent" },
      agent,
    );
    await artifactCall("artifact_threads_add", {
      artifact_id: a.id,
      input: { body: "Please inspect the result", target: { kind: "artifact" } },
    });
    return a.id;
  };
  return {
    w,
    owner,
    agent,
    tower,
    call,
    artifactCall,
    artifact,
    r,
    event,
    accepted,
    get connection() {
      return connection;
    },
    reconnect(scopes?: MachineScope[]) {
      connection = connect(scopes);
      ready();
    },
    close() {
      tower.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("managed notifications preserve provenance, serialize turns, and reconcile acceptance without generic injection", async () => {
  const f = await fixture();
  try {
    const artifact = await f.artifact();
    const active = f.call<SessionCommand>("session_prompt", {
      target_session_id: f.r.session_id,
      content: [{ type: "text", text: "Existing work" }],
    });
    const submitted = await f.artifactCall<{ notification: { command_id: string; route: string } }>(
      "artifacts_submit",
      { artifact_id: artifact },
    );
    const id = submitted.notification.command_id;
    expect(submitted.notification.route).toBe("managed");
    expect(f.w.executions.command(id).state).toBe("queued");
    const n = f.w.one<{ id: string; envelope: string }>(
      "SELECT id,envelope FROM artifact_notifications WHERE command_id=?",
      id,
    )!;
    expect(JSON.parse(n.envelope)).toMatchObject({
      id: n.id,
      artifactId: artifact,
      event: "submitted",
    });
    expect(f.w.executions.command(id).payload).toMatchObject({
      source: {
        kind: "artifact_notification",
        notification_id: n.id,
        artifact_id: artifact,
        event: "submitted",
      },
    });
    expect(
      f.connection.frames.some((frame) => frame.id === id || frame.method === "message.send"),
    ).toBe(false);
    f.event("turn_end", { stop_reason: "end_turn" }, active.id);
    expect(f.connection.frames.find((frame) => frame.id === id)).toMatchObject({
      method: "command.execute",
      params: { kind: "prompt", runtime_id: f.r.id },
    });
    expect(f.w.executions.runtime(f.r.session_id)?.active_prompt_id).toBe(id);
    f.reconnect();
    expect(f.w.artifacts!.notifications.latest(artifact)).toMatchObject({
      route: "managed",
      state: "unknown",
      command_id: id,
    });
    expect(
      f.connection.frames.some((frame) => frame.id === id || frame.method === "message.send"),
    ).toBe(false);
    expect(f.connection.frames.some((frame) => frame.id === `receipt:${id}`)).toBe(true);
    f.accepted(id);
    expect(f.w.artifacts!.notifications.latest(artifact)).toMatchObject({
      state: "sent",
      acknowledgement: "adapter",
      dispatch_state: "in_flight",
      turn_state: null,
      message: expect.stringContaining("model processing are unconfirmed"),
    });
    const repeated = await f.artifactCall<{
      notification: { state: string; repeated: boolean; command_id: string };
    }>("artifacts_submit", { artifact_id: artifact });
    expect(repeated.notification).toMatchObject({ state: "sent", repeated: true, command_id: id });
    expect(
      f.w.all("SELECT * FROM artifact_notifications WHERE artifact_id=?", artifact),
    ).toHaveLength(1);
    expect(f.w.artifacts!.conversations.hasPending(artifact)).toBe(true);
    f.event("turn_end", { stop_reason: "end_turn" }, id);
    expect(f.w.artifacts!.notifications.latest(artifact)?.turn_state).toBe("completed");
    expect(f.w.artifacts!.conversations.hasPending(artifact)).toBe(true);
  } finally {
    f.close();
  }
});

test("managed notification needs caller control, machine consent, and a current subscription", async () => {
  const f = await fixture();
  try {
    const artifact = await f.artifact();
    await expect(
      f.artifactCall(
        "artifacts_submit",
        { artifact_id: artifact },
        {
          id: "writer",
          kind: "client",
          resources: fixtureResources,
          inlet: "api",
          scopes: ["artifacts:contribute"],
        },
      ),
    ).rejects.toThrow("session prompt");
    expect(f.w.all("SELECT * FROM artifact_notifications")).toHaveLength(0);
    f.reconnect(["read", "send"]);
    const noConsent = await f.artifactCall<{ notification: { command_id: string } }>(
      "artifacts_submit",
      { artifact_id: artifact },
    );
    expect(f.w.executions.command(noConsent.notification.command_id).state).toBe("failed");
    expect(f.w.artifacts!.notifications.latest(artifact)).toMatchObject({
      state: "failed",
      message: expect.stringContaining("acp:control"),
    });
    expect(
      f.connection.frames.some(
        (frame) =>
          frame.method === "message.send" || frame.id === noConsent.notification.command_id,
      ),
    ).toBe(false);
    f.reconnect();
    const other = await f.artifact();
    const active = f.call<SessionCommand>("session_prompt", {
      target_session_id: f.r.session_id,
      content: [{ type: "text", text: "Hold" }],
    });
    const queued = await f.artifactCall<{ notification: { command_id: string } }>(
      "artifacts_submit",
      { artifact_id: other },
    );
    await f.artifactCall(
      "artifacts_unlisten",
      { artifact_id: other, session_id: f.r.session_id, operator_kind: "agent" },
      f.agent,
    );
    f.event("turn_end", { stop_reason: "end_turn" }, active.id);
    expect(f.w.executions.command(queued.notification.command_id).state).toBe("failed");
    expect(f.connection.frames.some((frame) => frame.id === queued.notification.command_id)).toBe(
      false,
    );
  } finally {
    f.close();
  }
});

test("archive waits for managed admission and retains separate turn outcome", async () => {
  const f = await fixture();
  try {
    const artifact = await f.artifact();
    const archiving = f.artifactCall<{ notification: { acknowledgement: string } }>(
      "artifacts_archive",
      { artifact_id: artifact, comment: "Proceed with review", operation_key: "archive-managed" },
    );
    const n = f.w.one<{ command_id: string; envelope: string }>(
      "SELECT command_id,envelope FROM artifact_notifications WHERE artifact_id=?",
      artifact,
    )!;
    expect(n.command_id).toBeTruthy();
    expect(f.w.artifacts!.store.get(artifact).state).toBe("active");
    expect(f.w.executions.command(n.command_id).payload).toMatchObject({
      source: { event: "archived", lifecycle_event_id: JSON.parse(n.envelope).lifecycleEventId },
    });
    f.accepted(n.command_id);
    expect((await archiving).notification.acknowledgement).toBe("adapter");
    expect(f.w.artifacts!.store.get(artifact).state).toBe("archived");
    expect(f.w.artifacts!.notifications.latest(artifact)?.turn_state).toBeNull();
    expect(
      f.w.one("SELECT 1 FROM audit_operations WHERE operation='artifact_notification_queue'"),
    ).not.toBeNull();
    f.event("turn_end", { stop_reason: "cancelled" }, n.command_id);
    expect(f.w.artifacts!.notifications.latest(artifact)).toMatchObject({
      acknowledgement: "adapter",
      turn_state: "cancelled",
    });
  } finally {
    f.close();
  }
});

test("archive timeout cancels an undispatched managed prompt", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const f = await fixture();
  try {
    const artifact = await f.artifact();
    const active = f.call<SessionCommand>("session_prompt", {
      target_session_id: f.r.session_id,
      content: [{ type: "text", text: "Hold" }],
    });
    const result = f
      .artifactCall("artifacts_archive", {
        artifact_id: artifact,
        comment: "Archive after review",
        operation_key: "archive-timeout",
      })
      .then(
        () => null,
        (error: Error) => error,
      );
    const n = f.w.one<{ command_id: string }>(
      "SELECT command_id FROM artifact_notifications WHERE artifact_id=?",
      artifact,
    )!;
    expect(f.w.executions.command(n.command_id).state).toBe("queued");
    now += 36000;
    expect((await result)?.message).toContain("timed out");
    expect(f.w.executions.command(n.command_id).state).toBe("failed");
    f.event("turn_end", { stop_reason: "end_turn" }, active.id);
    expect(
      f.connection.frames.some(
        (frame) => frame.id === n.command_id || frame.method === "message.send",
      ),
    ).toBe(false);
    expect(f.w.artifacts!.store.get(artifact).state).toBe("active");
  } finally {
    f.close();
    clock.mockRestore();
  }
});

test("managed generation loss and native aliases never fall back to generic messaging", async () => {
  const f = await fixture();
  try {
    const artifact = await f.artifact();
    f.call("session_prompt", {
      target_session_id: f.r.session_id,
      content: [{ type: "text", text: "Hold" }],
    });
    const queued = await f.artifactCall<{ notification: { command_id: string } }>(
      "artifacts_submit",
      { artifact_id: artifact },
    );
    f.w.run("UPDATE session_runtimes SET state='error',fenced=1,connected=0 WHERE id=?", f.r.id);
    f.tower.wake();
    expect(f.w.executions.command(queued.notification.command_id).state).toBe("failed");
    expect(f.w.artifacts!.notifications.target(f.r.session_id)).toBeNull();
    f.call("sessions_declare", {
      target_session_id: "native-alias",
      harness: "fixture",
      source_namespace: "fixture",
      native_session_id: "native-acp",
    });
    f.connection.send({
      method: "state.push",
      params: {
        seq: 0,
        full: true,
        records: [
          {
            id: "managed-tower-id",
            native_session_id: "native-acp",
            harness: "fixture",
            status: "idle",
            caps: { message: "hook" },
          },
        ],
      },
    });
    expect(f.w.artifacts!.notifications.target("native-alias")).toBeNull();
    expect(
      f.connection.frames.some(
        (frame) => frame.id === queued.notification.command_id || frame.method === "message.send",
      ),
    ).toBe(false);
  } finally {
    f.close();
  }
});
