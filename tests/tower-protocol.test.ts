import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { fixtureResources } from "../scripts/fixture-auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Tower, type TowerSocketData } from "../server/tower.ts";
import { Workspace } from "../server/workspace.ts";
import type { Machine, Operation, SessionCommand } from "../shared/contracts.ts";
import {
  type HarnessControls,
  lossSchema,
  receiptSchema,
  resumeCleanupSchema,
} from "../shared/tower-acp.ts";
import { fixtureOwner, fullControls } from "./fixtures/tower-controls.ts";
import forceReceipts from "./fixtures/tower-force-receipts.json";

function fixture() {
  const db = openDatabase(":memory:");
  let tower: Tower;
  const w = new Workspace(db, undefined, () => tower?.wake(), { managedSessions: true });
  const owner = fixtureOwner(w);
  tower = new Tower(w, "http://127.0.0.1:4390", "127.0.0.1:4390");
  const call = <T>(name: Operation, input: Record<string, unknown>) =>
      w.execute(name, { operation_key: randomUUID(), ...input }, owner) as T,
    m = call<Machine>("machines_create", { name: "Fixture" }),
    credential = w.executions.issueCredential(m.id, "Test", ["read", "send", "acp:control"]);
  const connect = (
    major = 1,
    autoPolicy = true,
    controls: Record<string, HarnessControls> = {
      fixture: fullControls(),
      codex: fullControls("codex-app-server"),
    },
  ) => {
    const frames: Record<string, unknown>[] = [],
      closed: number[] = [];
    const data = tower.authenticate(
      new Request("http://127.0.0.1:4390/tower", {
        headers: { authorization: `Bearer ${credential.access_key}` },
      }),
    )!;
    const socket = {
      data,
      send: (text: string) => {
        frames.push(JSON.parse(text));
        return 1;
      },
      close: (code: number) => {
        closed.push(code);
        tower.close(socket as unknown as ServerWebSocket<TowerSocketData>);
      },
    } as unknown as ServerWebSocket<TowerSocketData>;
    tower.open(socket);
    const send = (message: Record<string, unknown>) =>
      tower.message(socket, JSON.stringify({ jsonrpc: "2.0", ...message }));
    send({
      id: "hello",
      method: "hello",
      params: {
        protocol_version: { major, minor: 4 },
        tower_version: "fixture",
        host_id: "fixture-host",
        capabilities: [
          "policy-sync.v1",
          "session-status.v1",
          "session-status-delta.v1",
          "policy-delta.v1",
          "managed-acp.v1",
          "command-receipts.v1",
          "session-stream.v1",
          "session-resume.v1",
          "session-force-resume.v1",
        ],
        acp_harnesses: ["fixture", "codex", "antigravity"],
        harness_controls: controls,
        policy_revision: null,
      },
    });
    if (major === 1 && autoPolicy) {
      const policy = frames.find((m) => m.method === "policy.push")!;
      send({
        id: policy.id,
        result: {
          policy_id: "tower",
          previous_revision: null,
          applied_revision: 1,
          outcome: "applied",
          changed_rule_ids: [],
          reason: null,
          received_at: Date.now(),
        },
      });
    }
    return { socket, send, frames, closed };
  };
  return {
    w,
    tower,
    m,
    call,
    connect,
    close: () => {
      tower.stop();
      db.close();
    },
  };
}
test("policy validation, correlated application reports, and stale ACKs preserve desired versus applied state", () => {
  const f = fixture();
  try {
    const c = f.connect(1, false);
    expect(c.frames[0]).toMatchObject({
      result: { capabilities: expect.arrayContaining(["session-status.v1"]) },
    });
    const policy = () => c.frames.filter((m) => m.method === "policy.push").at(-1)!;
    const ack = (frame: Record<string, unknown>, revision: number, outcome = "applied") =>
      c.send({
        id: frame.id,
        result: {
          policy_id: "tower",
          previous_revision: revision - 1 || null,
          applied_revision: outcome === "applied" ? revision : revision - 1,
          outcome,
          changed_rule_ids: [],
          reason: outcome === "applied" ? null : "policy_conflict",
          received_at: Date.now(),
        },
      });
    expect(f.w.executions.machine(f.m.id).policy_status).toBe("pending");
    ack(policy(), 1);
    expect(f.w.executions.machine(f.m.id).policy_status).toBe("applied");
    const rule = {
      id: "remote.rule",
      from: "*",
      to: "harness:fixture",
      action: "deny",
      created_by: "owner",
      created_at: 1,
    };
    expect(() =>
      f.call("machines_update", {
        machine_id: f.m.id,
        expected_revision: 1,
        policy: [{ ...rule, id: "invalid id" }],
      }),
    ).toThrow("Invalid");
    expect(() =>
      f.call("machines_update", { machine_id: f.m.id, expected_revision: 1, policy: [rule, rule] }),
    ).toThrow("Invalid");
    expect(f.w.executions.machine(f.m.id).policy_revision).toBe(1);
    f.call("machines_update", { machine_id: f.m.id, expected_revision: 1, policy: [rule] });
    const rejected = policy();
    ack(rejected, 2, "rejected");
    expect(f.w.executions.machine(f.m.id)).toMatchObject({
      policy_status: "rejected",
      policy_report: { requested_revision: 2, applied_revision: 1, reason: "policy_conflict" },
    });
    f.call("machines_update", { machine_id: f.m.id, expected_revision: 2, policy: [] });
    ack(policy(), 3);
    ack(rejected, 2);
    expect(f.w.executions.machine(f.m.id)).toMatchObject({
      policy_status: "applied",
      policy_report: { requested_revision: 3, applied_revision: 3 },
    });
  } finally {
    f.close();
  }
});
test("status snapshots cannot roll back across sequence replay or superseded connections", () => {
  const f = fixture();
  try {
    const a = f.connect(),
      snapshot = (seq: number, status: string) => ({
        method: "state.push",
        params: { seq, full: true, records: [{ id: "record", status }] },
      });
    a.send(snapshot(2, "running"));
    a.send(snapshot(1, "old"));
    a.send(snapshot(2, "running"));
    expect(
      JSON.parse(
        f.w.one<{ record: string }>("SELECT record FROM tower_records WHERE tower_id=?", "record")!
          .record,
      ).status,
    ).toBe("running");
    const command = f.call<{ command: SessionCommand }>("session_launch", {
      machine_id: f.m.id,
      harness: "fixture",
      cwd: "/work/project",
    }).command;
    expect(f.w.executions.command(command.id).state).toBe("sent");
    const b = f.connect();
    expect(f.w.executions.command(command.id).state).toBe("unknown");
    expect(b.frames.some((m) => m.method === "command.status")).toBe(true);
    expect(a.closed).toContain(4001);
    b.send(snapshot(0, "new connection"));
    a.send(snapshot(3, "late old socket"));
    expect(
      JSON.parse(
        f.w.one<{ record: string }>("SELECT record FROM tower_records WHERE tower_id=?", "record")!
          .record,
      ).status,
    ).toBe("new connection");
    b.send(snapshot(0, "changed replay"));
    expect(b.closed).toContain(4002);
    expect(f.w.executions.machine(f.m.id).connected).toBe(false);
    const incompatible = f.connect(2);
    expect(incompatible.frames[0]).toMatchObject({
      error: { data: { code: "protocol_incompatible" } },
    });
  } finally {
    f.close();
  }
});

test("late acceptance receipts remain history and cannot revive an ended execution", () => {
  const f = fixture();
  try {
    const c = f.connect(),
      launch = f.call<{ command: SessionCommand }>("session_launch", {
        machine_id: f.m.id,
        harness: "fixture",
        cwd: "/work/project",
      }).command;
    f.w.run("UPDATE session_runtimes SET state='ended',connected=0 WHERE id=?", launch.runtime_id);
    c.send({
      id: launch.id,
      result: {
        command_id: launch.id,
        runtime_id: launch.runtime_id,
        generation: f.w.executions.runtime(launch.session_id)!.generation,
        receipt_revision: 1,
        state: "accepted",
        acceptance: { level: "adapter", at: new Date().toISOString() },
        dispatch: { state: "in_flight" },
        result: { tower_session_id: "late-tower", acp_session_id: "late-acp" },
      },
    });
    expect(f.w.executions.command(launch.id).state).toBe("acknowledged");
    expect(f.w.executions.runtime(launch.session_id)).toMatchObject({
      state: "ended",
      connected: false,
      acp_session_id: null,
    });
  } finally {
    f.close();
  }
});

test("status deltas preserve null, remove fields and records, replay exactly, and recover atomically", () => {
  const f = fixture();
  try {
    const c = f.connect();
    c.send({
      method: "state.push",
      params: {
        seq: 0,
        full: true,
        records: [{ id: "a", pid: 12, status: "running" }, { id: "b" }],
      },
    });
    const change = {
      seq: 1,
      base_seq: 0,
      upserts: [
        { id: "a", set: { status: "idle", status_detail: null }, unset: ["pid"] },
        { id: "c", set: { cwd: "/work/project" }, unset: [] },
      ],
      removed: ["b"],
    };
    c.send({ method: "state.delta", params: change });
    c.send({ method: "state.delta", params: change });
    const records = () =>
      f.w
        .all<{ record: string }>("SELECT record FROM tower_records ORDER BY tower_id")
        .map((r) => JSON.parse(r.record));
    expect(records()).toEqual([
      { id: "a", status: "idle", status_detail: null },
      { id: "c", cwd: "/work/project" },
    ]);
    expect(c.frames.at(-1)).toMatchObject({
      method: "sync.ack",
      params: { cursor: 1, rejected: [] },
    });
    c.send({ method: "state.delta", params: { ...change, seq: 2 } });
    expect(c.frames.at(-1)).toMatchObject({ method: "sync.resync" });
    expect(records()).toHaveLength(2);
    c.send({ method: "state.delta", params: { seq: 3, base_seq: 1, upserts: [], removed: ["a"] } });
    expect(records()).toHaveLength(2); // A requested full reset cannot be bypassed by another delta.
    c.send({ method: "state.push", params: { seq: 3, full: true, records: [{ id: "restored" }] } });
    c.send({
      method: "state.delta",
      params: {
        seq: 4,
        base_seq: 3,
        upserts: [{ id: "restored", set: { approvals: "private" }, unset: [] }],
        removed: [],
      },
    });
    expect(records()).toEqual([{ id: "restored" }]);
    const reconnected = f.connect();
    reconnected.send({
      method: "state.delta",
      params: { seq: 1, base_seq: 0, upserts: [], removed: ["restored"] },
    });
    expect(reconnected.frames.at(-1)).toMatchObject({ method: "sync.resync" });
    expect(records()).toEqual([{ id: "restored" }]);
  } finally {
    f.close();
  }
});

test("policy delta uses the acknowledged ordered base, coalesces, and falls back to full without stale ACK interference", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const rules = Array.from({ length: 20 }, (_, i) => ({
      id: `rule-${i}`,
      from: "*",
      to: `harness:fixture-${i}`,
      action: "deny",
      created_by: "owner",
      created_at: 1,
    }));
    const policy = () =>
      c.frames.filter((m) => ["policy.push", "policy.delta"].includes(String(m.method))).at(-1)!;
    const ack = (m: Record<string, unknown>, revision: number, outcome = "applied") =>
      c.send({
        id: m.id,
        result: {
          policy_id: "tower",
          previous_revision: revision - 1,
          applied_revision: outcome === "applied" ? revision : revision - 1,
          outcome,
          changed_rule_ids: [],
          reason: outcome === "applied" ? null : "base_mismatch",
          received_at: Date.now(),
        },
      });
    f.call("machines_update", { machine_id: f.m.id, expected_revision: 1, policy: rules });
    const full = policy();
    expect(full.method).toBe("policy.push");
    ack(full, 2);
    const updated = rules.map((r, i) => (i ? r : { ...r, action: "allow" }));
    f.call("machines_update", { machine_id: f.m.id, expected_revision: 2, policy: updated });
    const delta = policy();
    expect(delta).toMatchObject({
      method: "policy.delta",
      params: {
        base_revision: 2,
        revision: 3,
        upserts: [updated[0]],
        removed: [],
        order: updated.map((r) => r.id),
      },
    });
    f.call("machines_update", {
      machine_id: f.m.id,
      expected_revision: 3,
      policy: [...updated].reverse(),
    });
    expect(policy().id).toBe(delta.id);
    ack(delta, 3, "rejected");
    const recovery = policy();
    expect(recovery).toMatchObject({
      method: "policy.push",
      params: { revision: 4, rules: [...updated].reverse() },
    });
    ack(delta, 3, "rejected");
    expect(policy().id).toBe(recovery.id);
    ack(recovery, 4);
    expect(f.w.executions.machine(f.m.id).policy_status).toBe("applied");
  } finally {
    f.close();
  }
});

test("managed receipts cannot unlock an active turn; private control and cancellation progress independently", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const launched = f.call<{
      command: SessionCommand;
      runtime: import("../shared/contracts.ts").SessionRuntime;
    }>("session_launch", { machine_id: f.m.id, harness: "codex", cwd: "/work/project" });
    const r = launched.runtime;
    const base = { runtime_id: r.id, generation: r.generation, source_key: r.generation };
    const result = (
      command: SessionCommand,
      revision: number,
      state: string,
      dispatch = "in_flight",
    ) => ({
      command_id: command.id,
      runtime_id: r.id,
      generation: r.generation,
      receipt_revision: revision,
      state,
      ...(state === "accepted"
        ? { acceptance: { level: "adapter", at: "2030-01-01T00:00:00Z" } }
        : {}),
      dispatch: { state: dispatch },
    });
    expect(c.frames.find((m) => m.id === launched.command.id)).toMatchObject({
      params: { payload: { protocol: "codex-app-server" }, expires_at: expect.any(String) },
    });
    c.send({ id: launched.command.id, result: result(launched.command, 1, "accepted") });
    expect(() =>
      f.call("session_prompt", {
        target_session_id: r.session_id,
        content: [{ type: "text", text: "too early" }],
      }),
    ).toThrow("confirm");
    c.send({
      id: "ready",
      method: "session.events",
      params: {
        ...base,
        events: [
          {
            sequence: 1,
            key: "ready",
            kind: "runtime_state",
            command_id: launched.command.id,
            payload: {
              state: "idle",
              native_session_id: "native-thread",
              tower_session_id: "managed-record",
              owner_id: "durable-owner",
            },
          },
        ],
      },
    });
    const prompt = f.call<SessionCommand>("session_prompt", {
      target_session_id: r.session_id,
      content: [{ type: "text", text: "first" }],
    });
    c.send({ id: prompt.id, result: result(prompt, 1, "pending", "not_started") });
    const next = f.call<SessionCommand>("session_prompt", {
      target_session_id: r.session_id,
      content: [{ type: "text", text: "second" }],
    });
    expect(f.w.executions.command(next.id).state).toBe("queued");
    c.send({
      id: "private",
      method: "session.request",
      params: {
        runtime_id: r.id,
        generation: r.generation,
        owner_id: "durable-owner",
        source_request_id: "private-occurrence",
        request_revision: 1,
        native_request_id: 7,
        kind: "elicitation",
        state: "pending",
        payload: {
          mode: "form",
          message: "private-secret",
          requestedSchema: {
            type: "object",
            properties: { token: { type: "string" } },
            required: ["token"],
            additionalProperties: false,
          },
        },
      },
    });
    const request = f.w.one<{ id: string; revision: number }>(
      "SELECT id,revision FROM session_requests",
    )!;
    const reply = f.call<SessionCommand>("session_reply", {
      request_id: request.id,
      expected_revision: request.revision,
      response: { action: "accept", content: { token: "sensitive-reply" } },
    });
    expect(c.frames.find((m) => m.id === reply.id)).toMatchObject({
      params: { payload: { response: { content: { token: "sensitive-reply" } } } },
    });
    const durable =
      JSON.stringify(f.w.all("SELECT * FROM session_requests")) +
      JSON.stringify(f.w.all("SELECT * FROM session_commands")) +
      JSON.stringify(f.w.all("SELECT * FROM operations")) +
      JSON.stringify(f.w.all("SELECT * FROM audit_changes"));
    expect(durable).not.toContain("private-secret");
    expect(durable).not.toContain("sensitive-reply");
    c.send({
      id: "url-consent",
      method: "session.request",
      params: {
        runtime_id: r.id,
        generation: r.generation,
        owner_id: "durable-owner",
        source_request_id: "url-occurrence",
        request_revision: 1,
        native_request_id: 8,
        kind: "elicitation",
        state: "pending",
        payload: { mode: "url", url: "https://example.invalid/consent?private-url" },
      },
    });
    const urlRequest = f.w.one<{ id: string; revision: number }>(
      "SELECT id,revision FROM session_requests WHERE source_request_id='url-occurrence'",
    )!;
    expect(() =>
      f.call("session_reply", {
        request_id: urlRequest.id,
        expected_revision: urlRequest.revision,
        response: { action: "accept", content: { token: "do-not-return-credentials" } },
      }),
    ).toThrow("URL consent");
    const consent = f.call<SessionCommand>("session_reply", {
      request_id: urlRequest.id,
      expected_revision: urlRequest.revision,
      response: { action: "accept" },
    });
    expect(c.frames.find((frame) => frame.id === consent.id)).toMatchObject({
      params: { payload: { response: { action: "accept" } } },
    });
    c.send({ id: prompt.id, result: result(prompt, 2, "accepted") });
    expect(f.w.executions.command(next.id).state).toBe("queued");
    c.send({
      id: "bad-regression",
      method: "command.receipt",
      params: result(prompt, 3, "pending", "not_started"),
    });
    expect(c.frames.at(-1)).toMatchObject({ error: { data: { code: "receipt_regression" } } });
    expect(f.w.executions.command(prompt.id).state).toBe("acknowledged");
    c.send({
      id: "turn",
      method: "session.events",
      params: {
        ...base,
        events: [
          {
            sequence: 2,
            key: "turn-ended",
            kind: "turn_end",
            command_id: prompt.id,
            payload: { stop_reason: "end_turn" },
          },
        ],
      },
    });
    expect(f.w.executions.command(next.id).state).toBe("sent");
    const cancel = f.call<SessionCommand>("session_cancel", { target_session_id: r.session_id });
    expect(f.w.executions.command(cancel.id).state).toBe("sent");
    c.send({ id: "cursor", method: "session.cursor", params: base });
    expect(c.frames.find((m) => m.id === "cursor")).toMatchObject({
      result: { ...base, cursor: 2, last_event_key: "turn-ended" },
    });
    const loss = {
      runtime_id: r.id,
      generation: r.generation,
      owner_id: "durable-owner",
      loss_id: "loss-test",
      report_revision: 1,
      termination: "unknown",
      reason: "owner_unreachable",
      observed_at: "2030-01-01T00:00:00Z",
    };
    c.send({ id: "loss", method: "runtime.lost", params: loss });
    c.send({ id: "loss-again", method: "runtime.lost", params: loss });
    expect(f.w.executions.runtime(r.session_id)).toMatchObject({
      fenced: 1,
      termination: "unknown",
      loss_revision: 1,
    });
    expect(() =>
      f.call("session_resume", {
        target_session_id: r.session_id,
        machine_id: f.m.id,
        cwd: "/work/project",
      }),
    ).toThrow("termination");
    c.send({
      id: "late",
      method: "session.events",
      params: {
        ...base,
        events: [{ sequence: 3, key: "late", kind: "runtime_state", payload: { state: "idle" } }],
      },
    });
    expect(f.w.executions.runtime(r.session_id)?.fenced).toBe(1);
    c.send({
      id: "loss-confirmed",
      method: "runtime.lost",
      params: { ...loss, report_revision: 2, termination: "confirmed" },
    });
    const resumed = f.call<{ runtime: { generation: string } }>("session_resume", {
      target_session_id: r.session_id,
      machine_id: f.m.id,
      cwd: "/work/project",
    });
    expect(resumed.runtime.generation).not.toBe(r.generation);
  } finally {
    f.close();
  }
});

test("cursor reads and replay conflicts preserve committed history and exact ownership", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const launched = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
      "session_launch",
      { machine_id: f.m.id, harness: "fixture", cwd: "/work/project" },
    );
    const r = launched.runtime,
      base = { runtime_id: r.id, generation: r.generation, source_key: r.generation };
    c.send({ id: "empty", method: "session.cursor", params: base });
    expect(c.frames.find((m) => m.id === "empty")).toMatchObject({
      result: { cursor: 0, last_event_key: null, source_id: null },
    });
    expect(f.w.all("SELECT * FROM transcript_sources")).toHaveLength(0);
    const event = {
      sequence: 1,
      key: "first",
      kind: "agent_message",
      payload: { text: "Retained" },
      at: "2030-01-01T00:00:00Z",
    };
    c.send({ id: "event", method: "session.events", params: { ...base, events: [event] } });
    const asset = f.w.executions.attachAsset(
      r.session_id,
      null,
      { hash: "1".repeat(64), byteLength: 1 },
      "text/plain",
      "active.txt",
    );
    f.call("transcript_delete", {
      target_session_id: r.session_id,
      through_sequence: 1,
      through_asset_sequence: 100,
    });
    expect(f.w.one("SELECT * FROM session_assets WHERE id=?", asset.id)).not.toBeNull();
    expect(
      f.w.one<{ payload: string | null }>("SELECT payload FROM session_event_content")?.payload,
    ).toBeNull();
    c.send({
      id: "deleted-replay",
      method: "session.events",
      params: { ...base, events: [event] },
    });
    expect(c.frames.at(-1)).toMatchObject({ result: { cursor: 1 } });
    expect(
      f.w.one<{ payload: string | null }>("SELECT payload FROM session_event_content")?.payload,
    ).toBeNull();

    c.send({
      id: "changed",
      method: "session.events",
      params: { ...base, events: [{ ...event, at: "2030-01-02T00:00:00Z" }] },
    });
    expect(c.frames.at(-1)).toMatchObject({ error: { data: { code: "event_conflict" } } });
    c.send({
      id: "gap-overwrite",
      method: "session.events",
      params: {
        ...base,
        events: [
          {
            sequence: 1,
            key: "gap",
            kind: "gap",
            payload: {
              reason: "native_output_dropped",
              coverage: "partial",
              native_range: { from: null, to: null, count: null },
              time_range: { from: null, to: null },
            },
          },
        ],
      },
    });
    expect(c.frames.at(-1)).toMatchObject({ error: { data: { code: "sequence_conflict" } } });
    c.send({
      id: "wrong",
      method: "session.cursor",
      params: { ...base, generation: "old-generation" },
    });
    expect(c.frames.at(-1)).toMatchObject({ error: { data: { code: "runtime_conflict" } } });
    expect(() => f.w.executions.managed.cursor("another-machine", base)).toThrow("owned");
    const gap = {
      sequence: 2,
      key: "gap",
      kind: "gap",
      payload: {
        reason: "native_output_dropped",
        coverage: "partial",
        native_range: { from: null, to: null, count: 5 },
        time_range: { from: null, to: null },
      },
    };
    c.send({ id: "gap", method: "session.events", params: { ...base, events: [gap] } });
    c.send({ id: "current", method: "session.cursor", params: base });
    expect(c.frames.at(-1)).toMatchObject({
      result: { cursor: 2, last_event_key: "gap", coverage: "partial" },
    });
    expect(f.w.all("SELECT * FROM session_events")).toHaveLength(2);
  } finally {
    f.close();
  }
});

test("reconnect needs private request reannouncement and expired queued authority cannot dispatch", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const launched = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
      "session_launch",
      { machine_id: f.m.id, harness: "fixture", cwd: "/work/project" },
    );
    const r = launched.runtime,
      base = { runtime_id: r.id, generation: r.generation, source_key: r.generation };
    // Positive readiness is native execution evidence, independent of a lost launch receipt.
    c.send({
      id: "ready",
      method: "session.events",
      params: {
        ...base,
        events: [
          {
            sequence: 1,
            key: "ready",
            kind: "runtime_state",
            payload: {
              state: "idle",
              owner_id: "owner",
              tower_session_id: "tower",
              acp_session_id: "acp",
            },
          },
        ],
      },
    });
    const first = f.call<SessionCommand>("session_prompt", {
      target_session_id: r.session_id,
      content: [{ type: "text", text: "first" }],
    });
    const next = f.call<SessionCommand>("session_prompt", {
      target_session_id: r.session_id,
      content: [{ type: "text", text: "next" }],
    });
    const q = {
      runtime_id: r.id,
      generation: r.generation,
      owner_id: "owner",
      source_request_id: "occurrence",
      request_revision: 1,
      native_request_id: 1,
      kind: "permission",
      state: "pending",
      payload: { options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
    };
    c.send({ id: "request", method: "session.request", params: q });
    const old = f.w.one<{ id: string; revision: number }>(
      "SELECT id,revision FROM session_requests",
    )!;
    const b = f.connect();
    expect(f.w.executions.managed.request(old.id)).toBeUndefined();
    expect(() =>
      f.call("session_reply", {
        request_id: old.id,
        expected_revision: old.revision,
        response: { outcome: { outcome: "selected", optionId: "allow" } },
      }),
    ).toThrow("no longer live");
    b.send({
      id: "alive",
      method: "session.events",
      params: {
        ...base,
        events: [
          {
            sequence: 2,
            key: "alive",
            kind: "runtime_state",
            payload: { state: "waiting", owner_id: "owner" },
          },
        ],
      },
    });
    b.send({ id: "reannounce", method: "session.request", params: q });
    expect(f.w.executions.managed.request(old.id)).toBeDefined();
    f.w.run(
      "UPDATE command_authority SET expires_at='2000-01-01T00:00:00Z' WHERE command_id=?",
      next.id,
    );
    b.send({
      id: "turn",
      method: "session.events",
      params: {
        ...base,
        events: [{ sequence: 3, key: "end", kind: "turn_end", command_id: first.id, payload: {} }],
      },
    });
    expect(f.w.executions.command(next.id).state).toBe("failed");
    expect(b.frames.some((m) => m.id === next.id)).toBe(false);
    b.send({ id: "retired", method: "session.request", params: q });
    expect(b.frames.at(-1)).toMatchObject({ error: { data: { code: "stale_request" } } });
  } finally {
    f.close();
  }
});

test("text-only runtime adapters reject unsupported controls and stop without implicit continuation", () => {
  const f = fixture();
  try {
    const controls: HarnessControls = {
      protocol: "acp",
      capabilities: ["prompt", "resume"],
      cancel_mode: "runtime",
    };
    const c = f.connect(1, true, { antigravity: controls });
    expect(() =>
      f.call("session_launch", { machine_id: f.m.id, harness: "fixture", cwd: "/work/project" }),
    ).toThrow("advertised");
    const launched = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
      "session_launch",
      { machine_id: f.m.id, harness: "antigravity", cwd: "/work/project" },
    );
    const r = launched.runtime,
      base = { runtime_id: r.id, generation: r.generation, source_key: r.generation };
    c.send({
      id: "ready",
      method: "session.events",
      params: {
        ...base,
        events: [
          {
            sequence: 1,
            key: "ready",
            kind: "runtime_state",
            payload: {
              state: "idle",
              owner_id: "bridge",
              tower_session_id: "tower",
              acp_session_id: "bridge-acp",
              native_session_id: "native-conversation",
            },
          },
        ],
      },
    });
    expect(() =>
      f.call("session_configure", {
        target_session_id: r.session_id,
        config: { model: "example" },
      }),
    ).toThrow("does not support");
    expect(() =>
      f.call("session_prompt", {
        target_session_id: r.session_id,
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      }),
    ).toThrow("does not support");
    const prompt = f.call<SessionCommand>("session_prompt", {
      target_session_id: r.session_id,
      content: [{ type: "text", text: "Inspect" }],
    });
    expect(prompt.state).toBe("queued");
    expect(f.w.executions.command(prompt.id).state).toBe("sent");
    c.send({
      id: "unsupported-permission",
      method: "session.request",
      params: {
        runtime_id: r.id,
        generation: r.generation,
        owner_id: "bridge",
        source_request_id: "request",
        request_revision: 1,
        native_request_id: 1,
        kind: "permission",
        state: "pending",
        payload: { options: [] },
      },
    });
    expect(c.frames.at(-1)).toMatchObject({ error: { data: { code: "unsupported_control" } } });
    f.call("session_cancel", { target_session_id: r.session_id });
    expect(f.w.executions.runtime(r.session_id)?.stop_requested).toBe(true);
    expect(() =>
      f.call("session_prompt", {
        target_session_id: r.session_id,
        content: [{ type: "text", text: "Do not start after stop" }],
      }),
    ).toThrow("does not support");
    c.send({
      id: "end",
      method: "session.events",
      params: {
        ...base,
        events: [
          {
            sequence: 2,
            key: "end",
            kind: "runtime_state",
            payload: { state: "ended", termination: "confirmed" },
          },
        ],
      },
    });
    expect(f.w.all("SELECT * FROM session_runtimes")).toHaveLength(1);
    f.w.run(
      "UPDATE machines SET harness_controls=? WHERE id=?",
      JSON.stringify({ antigravity: { ...controls, protocol: "codex-app-server" } }),
      f.m.id,
    );
    expect(() =>
      f.call("session_resume", {
        target_session_id: r.session_id,
        machine_id: f.m.id,
        cwd: "/work/project",
      }),
    ).toThrow("different backend protocol");
    f.w.run(
      "UPDATE machines SET harness_controls=? WHERE id=?",
      JSON.stringify({ antigravity: controls }),
      f.m.id,
    );
    const resumed = f.call<{ command: SessionCommand }>("session_resume", {
      target_session_id: r.session_id,
      machine_id: f.m.id,
      cwd: "/work/project",
    });
    expect(resumed.command.payload.resume_session_id).toBe("bridge-acp");
  } finally {
    f.close();
  }
});

test("native Codex execution identity guards reconciliation without an ACP identity", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const launched = f.call<{
      runtime: import("../shared/contracts.ts").SessionRuntime;
      command: SessionCommand;
    }>("session_launch", { machine_id: f.m.id, harness: "codex", cwd: "/work/project" });
    const r = launched.runtime;
    c.send({
      id: "native-ready",
      method: "session.events",
      params: {
        runtime_id: r.id,
        generation: r.generation,
        source_key: r.generation,
        events: [
          {
            sequence: 1,
            key: "ready",
            kind: "runtime_state",
            payload: {
              state: "idle",
              owner_id: "owner",
              tower_session_id: "tower",
              native_session_id: "app-server-thread",
            },
          },
        ],
      },
    });
    f.connect(); // Losing the connection before the launch receipt leaves acceptance unknown.
    expect(f.w.executions.command(launched.command.id).state).toBe("unknown");
    expect(() =>
      f.call("session_reconcile", {
        command_id: launched.command.id,
        decision: "failed",
        reason: "Receipt was lost",
      }),
    ).toThrow("already reported");
    expect(f.w.executions.runtime(r.session_id)?.acp_session_id).toBeNull();
  } finally {
    f.close();
  }
});

test("native negotiation can narrow controls and queued commands recheck them", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const r = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
      "session_launch",
      { machine_id: f.m.id, harness: "fixture", cwd: "/work/project" },
    ).runtime;
    const base = { runtime_id: r.id, generation: r.generation, source_key: r.generation };
    const ready = {
      sequence: 1,
      key: "ready",
      kind: "runtime_state",
      payload: {
        state: "idle",
        owner_id: "owner",
        tower_session_id: "tower",
        acp_session_id: "acp",
        controls: fullControls(),
      },
    };
    c.send({ id: "ready", method: "session.events", params: { ...base, events: [ready] } });
    f.call("session_prompt", {
      target_session_id: r.session_id,
      content: [{ type: "text", text: "first" }],
    });
    const queued = f.call<SessionCommand>("session_prompt", {
      target_session_id: r.session_id,
      content: [{ type: "text", text: "second" }],
    });
    c.send({
      id: "narrow",
      method: "session.events",
      params: {
        ...base,
        events: [
          {
            sequence: 2,
            key: "narrow",
            kind: "runtime_state",
            payload: {
              state: "running",
              controls: { protocol: "acp", capabilities: ["resume"], cancel_mode: null },
            },
          },
        ],
      },
    });
    expect(f.w.executions.command(queued.id).state).toBe("failed");
    expect(c.frames.some((m) => m.id === queued.id)).toBe(false);
    const count = f.w.one<{ n: number }>("SELECT COUNT(*) n FROM session_commands")!.n;
    try {
      f.call("session_prompt", {
        target_session_id: r.session_id,
        content: [{ type: "text", text: "Unsupported prompt" }],
      });
      throw new Error("Unsupported prompt was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "unsupported_control", status: 409 });
    }
    expect(f.w.one<{ n: number }>("SELECT COUNT(*) n FROM session_commands")!.n).toBe(count);
    c.send({ id: "replay", method: "session.events", params: { ...base, events: [ready] } });
    expect(c.frames.at(-1)).toMatchObject({ result: { added: 0 } });
    c.send({
      id: "widen",
      method: "session.events",
      params: {
        ...base,
        events: [
          {
            sequence: 3,
            key: "widen",
            kind: "runtime_state",
            payload: { state: "idle", controls: fullControls() },
          },
        ],
      },
    });
    expect(c.frames.at(-1)).toMatchObject({ error: { data: { code: "control_conflict" } } });
    expect(f.w.executions.runtime(r.session_id)?.controls?.capabilities).toEqual(["resume"]);
    const b = f.connect(1, true, {});
    expect(() =>
      f.call("session_configure", { target_session_id: r.session_id, config: {} }),
    ).toThrow("does not support");
    expect(b.frames.some((m) => m.method === "command.execute")).toBe(false);
  } finally {
    f.close();
  }
});

test("force resume captures exact cleanup targets, fences controls, and preserves history and retry identity", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const r = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
      "session_launch",
      { machine_id: f.m.id, harness: "codex", cwd: "/work/project" },
    ).runtime;
    c.send({
      id: "ready",
      method: "session.events",
      params: {
        runtime_id: r.id,
        generation: r.generation,
        source_key: r.generation,
        events: [
          {
            sequence: 1,
            key: "ready",
            kind: "runtime_state",
            payload: {
              state: "idle",
              owner_id: "owner-native",
              tower_session_id: "tower",
              native_session_id: "native-history",
            },
          },
        ],
      },
    });
    const args = { target_session_id: r.session_id, machine_id: f.m.id, cwd: "/work/project" };
    expect(() => f.call("session_resume", args)).toThrow("resume --force");
    expect(() => f.call("session_resume", { ...args, force: false })).toThrow("resume --force");
    expect(() =>
      f.w.execute(
        "session_resume",
        { ...args, force: true, operation_key: "remote-force" },
        {
          id: "remote-agent",
          kind: "client",
          resources: fixtureResources,
          inlet: "mcp",
          scopes: ["admin"],
        },
      ),
    ).toThrow("private CLI");
    f.call("session_launch", { machine_id: f.m.id, harness: "codex", cwd: "/work/project" });
    const replacement = f.call<{
      command: SessionCommand;
      runtime: import("../shared/contracts.ts").SessionRuntime;
    }>("session_resume", { ...args, force: true, operation_key: "replacement" });
    expect(replacement.command.payload).toMatchObject({
      force: true,
      cleanup: [{ runtime_id: r.id, generation: r.generation }],
      resume_session_id: "native-history",
    });
    expect(replacement.command.payload).not.toHaveProperty("takeover");
    expect(c.frames.find((m) => m.id === replacement.command.id)).toMatchObject({
      params: { payload: replacement.command.payload },
    });
    expect(
      f.w.one<{ fenced: number; state: string; termination: string }>(
        "SELECT fenced,state,termination FROM session_runtimes WHERE id=?",
        r.id,
      ),
    ).toEqual({ fenced: 1, state: "error", termination: "unknown" });
    expect(f.w.all("SELECT * FROM session_events WHERE runtime_id=?", r.id)).toHaveLength(1);
    expect(f.w.executions.replacementError(replacement.command, replacement.runtime)).toBeNull();
    expect(
      f.w.executions.replacementError(replacement.command, {
        ...replacement.runtime,
        machine_id: "other-machine",
      }),
    ).toBe("cleanup_target_conflict");
    const replay = f.call<{ command: SessionCommand }>("session_resume", {
      ...args,
      force: true,
      operation_key: "replacement",
    });
    expect(replay.command.id).toBe(replacement.command.id);
    expect(c.frames.filter((m) => m.id === replacement.command.id)).toHaveLength(1);
    expect(() =>
      f.call("session_resume", { ...args, force: false, operation_key: "replacement" }),
    ).toThrow("different request");
    c.send({
      id: "replacement-too-soon",
      method: "session.events",
      params: {
        runtime_id: replacement.runtime.id,
        generation: replacement.runtime.generation,
        source_key: replacement.runtime.generation,
        events: [
          {
            sequence: 1,
            key: "ready",
            kind: "runtime_state",
            payload: {
              state: "idle",
              owner_id: "replacement-owner",
              tower_session_id: "tower",
              native_session_id: "native-history",
            },
          },
        ],
      },
    });
    expect(c.frames.find((m) => m.id === "replacement-too-soon")).toMatchObject({
      error: { data: { code: "cleanup_unconfirmed" } },
    });
    c.send({
      id: "cleaned",
      method: "runtime.lost",
      params: {
        runtime_id: r.id,
        generation: r.generation,
        owner_id: "owner-native",
        loss_id: "cleanup",
        report_revision: 1,
        termination: "confirmed",
        reason: "force_resume_cleanup",
        observed_at: "2030-01-01T00:00:00Z",
      },
    });
    expect(f.w.executions.replacementError(replacement.command, replacement.runtime)).toBeNull();
    expect(
      f.w.executions.replacementError(
        { ...replacement.command, payload: { ...replacement.command.payload, cleanup: [] } },
        replacement.runtime,
      ),
    ).toBe("cleanup_target_conflict");
    c.send({
      id: "replacement-ready",
      method: "session.events",
      params: {
        runtime_id: replacement.runtime.id,
        generation: replacement.runtime.generation,
        source_key: replacement.runtime.generation,
        events: [
          {
            sequence: 1,
            key: "ready",
            kind: "runtime_state",
            payload: {
              state: "idle",
              owner_id: "replacement-owner",
              tower_session_id: "tower",
              native_session_id: "native-history",
            },
          },
        ],
      },
    });
    expect(f.w.executions.runtime(r.session_id)).toMatchObject({
      id: replacement.runtime.id,
      state: "idle",
      connected: true,
    });
    expect(f.w.all("SELECT * FROM session_events WHERE runtime_id=?", r.id)).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("force cleanup requires negotiation and rechecks exact identities before dispatch", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const r = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
      "session_launch",
      { machine_id: f.m.id, harness: "codex", cwd: "/work/project" },
    ).runtime;
    f.w.run(
      "UPDATE session_runtimes SET native_session_id='native-history',state='error',fenced=1 WHERE id=?",
      r.id,
    );
    const args = {
      target_session_id: r.session_id,
      machine_id: f.m.id,
      cwd: "/work/project",
      force: true,
    };
    const caps = f.w.executions.machine(f.m.id).capabilities;
    f.w.run(
      "UPDATE machines SET capabilities=? WHERE id=?",
      JSON.stringify(caps.filter((c) => c !== "session-force-resume.v1")),
      f.m.id,
    );
    expect(() => f.call("session_resume", args)).toThrow("does not support force resume");
    expect(f.w.all("SELECT * FROM session_runtimes")).toHaveLength(1);
    f.w.run("UPDATE machines SET capabilities=? WHERE id=?", JSON.stringify(caps), f.m.id);
    f.call("machines_update", { machine_id: f.m.id, expected_revision: 1, policy: [] });
    const queued = f.call<{
      command: SessionCommand;
      runtime: import("../shared/contracts.ts").SessionRuntime;
    }>("session_resume", args);
    expect(f.w.executions.command(queued.command.id).state).toBe("queued");
    expect(
      f.w.executions.replacementError(
        { ...queued.command, payload: { ...queued.command.payload, cleanup: [] } },
        queued.runtime,
      ),
    ).toBe("cleanup_target_conflict");
    const targets = [{ runtime_id: r.id, generation: r.generation }];
    for (const payload of [
      { force: true },
      { cleanup: targets },
      { force: false, cleanup: targets },
      { force: true, cleanup: [...targets, ...targets] },
      { force: true, cleanup: [{ runtime_id: r.id, generation: "wrong-generation" }] },
      {
        force: true,
        cleanup: [{ runtime_id: queued.runtime.id, generation: queued.runtime.generation }],
      },
      { force: true, cleanup: [{ runtime_id: "absent-runtime", generation: r.generation }] },
      { force: true, cleanup: targets, takeover: {} },
    ])
      expect(f.w.executions.replacementError({ ...queued.command, payload }, queued.runtime)).toBe(
        "cleanup_target_conflict",
      );
    for (const kind of ["launch", "prompt", "cancel", "reply", "configure"] as const)
      expect(f.w.executions.replacementError({ ...queued.command, kind }, queued.runtime)).toBe(
        "cleanup_target_conflict",
      );
    expect(
      f.w.executions.replacementError(queued.command, { ...queued.runtime, protocol: "terminal" }),
    ).toBe("cleanup_target_conflict");
    expect(
      f.w.executions.replacementError({ ...queued.command, payload: {} }, queued.runtime),
    ).toBe("cleanup_unconfirmed");
    expect(resumeCleanupSchema.safeParse([]).success).toBe(false);
    expect(
      resumeCleanupSchema.safeParse(
        Array.from({ length: 32 }, (_, i) => ({
          runtime_id: `runtime-${i}`,
          generation: `generation-${i}`,
        })),
      ).success,
    ).toBe(true);
    expect(
      resumeCleanupSchema.safeParse(
        Array.from({ length: 33 }, (_, i) => ({
          runtime_id: `runtime-${i}`,
          generation: `generation-${i}`,
        })),
      ).success,
    ).toBe(false);
    f.w.run("UPDATE session_runtimes SET generation='unexpected-generation' WHERE id=?", r.id);
    f.tower.wake();
    expect(f.w.executions.command(queued.command.id)).toMatchObject({
      state: "failed",
      result: { code: "cleanup_target_conflict", stage: "dispatch", may_have_effect: false },
    });
    expect(c.frames.some((m) => m.id === queued.command.id)).toBe(false);
    expect(f.w.executions.runtime(r.session_id)).toMatchObject({
      state: "error",
      termination: "confirmed",
    });
    expect(
      f.w.one<{ termination: string }>("SELECT termination FROM session_runtimes WHERE id=?", r.id),
    ).toEqual({ termination: "unknown" });
  } finally {
    f.close();
  }
});

test("force requested after confirmed stop emits ordinary resume and retries never reselect cleanup", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const r = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
      "session_launch",
      { machine_id: f.m.id, harness: "codex", cwd: "/work/project" },
    ).runtime;
    f.w.run(
      "UPDATE session_runtimes SET native_session_id='native-history',state='ended',termination='confirmed',fenced=1 WHERE id=?",
      r.id,
    );
    const caps = f.w.executions.machine(f.m.id).capabilities;
    f.w.run(
      "UPDATE machines SET capabilities=? WHERE id=?",
      JSON.stringify(caps.filter((cap) => cap !== "session-force-resume.v1")),
      f.m.id,
    );
    const args = {
      target_session_id: r.session_id,
      machine_id: f.m.id,
      cwd: "/work/project",
      force: true,
      operation_key: "already-stopped",
    };
    const result = f.call<{
      command: SessionCommand;
      runtime: import("../shared/contracts.ts").SessionRuntime;
    }>("session_resume", args);
    expect(result.command.payload).not.toHaveProperty("force");
    expect(result.command.payload).not.toHaveProperty("cleanup");
    expect(result.command.payload.resume_session_id).toBe("native-history");
    expect(f.call<{ command: SessionCommand }>("session_resume", args).command.id).toBe(
      result.command.id,
    );
    expect(c.frames.filter((frame) => frame.id === result.command.id)).toHaveLength(1);
    expect(f.w.executions.runtime(r.session_id)?.id).toBe(result.runtime.id);
  } finally {
    f.close();
  }
});

test("replacing an undispatched resume retires it locally and cleanup still covers every remote uncertainty", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const first = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
      "session_launch",
      { machine_id: f.m.id, harness: "codex", cwd: "/work/project" },
    ).runtime;
    f.w.run(
      "UPDATE session_runtimes SET native_session_id='native-history',state='error',fenced=1 WHERE id=?",
      first.id,
    );
    const args = {
      target_session_id: first.session_id,
      machine_id: f.m.id,
      cwd: "/work/project",
      force: true,
    };
    const dispatched = f.call<{
      runtime: import("../shared/contracts.ts").SessionRuntime;
      command: SessionCommand;
    }>("session_resume", args);
    expect(f.w.executions.command(dispatched.command.id).state).toBe("sent");
    f.w.run("UPDATE session_runtimes SET state='error',fenced=1 WHERE id=?", dispatched.runtime.id);
    f.call("machines_update", { machine_id: f.m.id, expected_revision: 1, policy: [] });
    const queued = f.call<{
      runtime: import("../shared/contracts.ts").SessionRuntime;
      command: SessionCommand;
    }>("session_resume", { ...args, operation_key: "superseded-resume" });
    expect(f.w.executions.command(queued.command.id).state).toBe("queued");
    const replacement = f.call<{
      runtime: import("../shared/contracts.ts").SessionRuntime;
      command: SessionCommand;
    }>("session_resume", args);
    const expected = [first, dispatched.runtime].map((r) => ({
      runtime_id: r.id,
      generation: r.generation,
    }));
    expect(replacement.command.payload.cleanup).toEqual(expected);
    expect(
      f.w.one<{ fenced: number; termination: string }>(
        "SELECT fenced,termination FROM session_runtimes WHERE id=?",
        queued.runtime.id,
      ),
    ).toEqual({ fenced: 1, termination: "confirmed" });
    expect(f.w.executions.command(queued.command.id).state).toBe("failed");
    expect(
      f.w.one<{ termination: string }>(
        "SELECT termination FROM session_runtimes WHERE id=?",
        dispatched.runtime.id,
      ),
    ).toEqual({ termination: "unknown" });
    expect(c.frames.some((frame) => frame.id === queued.command.id)).toBe(false);
    expect(f.w.executions.replacementError(replacement.command, replacement.runtime)).toBeNull();
    expect(
      f.w.executions.replacementError(
        {
          ...replacement.command,
          payload: { ...replacement.command.payload, cleanup: [expected[0]] },
        },
        replacement.runtime,
      ),
    ).toBe("cleanup_target_conflict");
    expect(
      f.call<{ command: SessionCommand }>("session_resume", {
        ...args,
        operation_key: "superseded-resume",
      }).command.id,
    ).toBe(queued.command.id);
    expect(f.w.executions.runtime(first.session_id)?.id).toBe(replacement.runtime.id);
  } finally {
    f.close();
  }
});

for (const { name, dispatched, lossFirst } of [
  { name: "cleanup: receipt first", dispatched: false, lossFirst: false },
  { name: "cleanup: loss first", dispatched: false, lossFirst: true },
  { name: "uncertain dispatch: receipt first", dispatched: true, lossFirst: false },
  { name: "uncertain dispatch: loss first", dispatched: true, lossFirst: true },
])
  test(`force recovery preserves independent evidence across reconnect (${name})`, () => {
    const f = fixture();
    try {
      const c = f.connect();
      const old = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
        "session_launch",
        { machine_id: f.m.id, harness: "codex", cwd: "/work/project" },
      ).runtime;
      f.w.run("UPDATE session_runtimes SET native_session_id='native-history' WHERE id=?", old.id);
      const oldLoss = {
        runtime_id: old.id,
        generation: old.generation,
        owner_id: "previous-owner",
        loss_id: "previous-execution-loss",
        report_revision: 1,
        termination: "unknown",
        reason: "owner_unreachable",
        observed_at: "2030-01-01T00:00:00Z",
      };
      c.send({ id: "old-loss", method: "runtime.lost", params: oldLoss });
      const args = {
        target_session_id: old.session_id,
        machine_id: f.m.id,
        cwd: "/work/project",
        force: true,
      };
      const replacement = f.call<{
        runtime: import("../shared/contracts.ts").SessionRuntime;
        command: SessionCommand;
      }>("session_resume", { ...args, operation_key: "original-force" });
      const admission = {
        runtime_id: replacement.runtime.id,
        generation: replacement.runtime.generation,
        command_id: replacement.command.id,
        receipt_revision: 1,
        state: "accepted",
        acceptance: { level: "adapter", at: "2030-01-01T00:00:00Z" },
        dispatch: { state: "not_started" },
      };
      c.send({ id: "admitted-cleanup", method: "command.receipt", params: admission });
      if (dispatched) {
        c.send({
          id: "old-cleaned",
          method: "runtime.lost",
          params: { ...oldLoss, report_revision: 2, termination: "confirmed" },
        });
        c.send({
          id: "replacement-dispatched",
          method: "command.receipt",
          params: {
            ...admission,
            receipt_revision: 2,
            dispatch: { state: "in_flight", transport_written: true },
          },
        });
      }
      const receipt = {
        ...admission,
        receipt_revision: dispatched ? 3 : 2,
        dispatch: { state: dispatched ? "unknown" : "finished", transport_written: dispatched },
        error: {
          code: dispatched ? "dispatch_unknown" : "cleanup_unconfirmed",
          message: dispatched
            ? "Native acceptance is uncertain"
            : "Force resume did not complete; no replacement was dispatched",
          stage: dispatched ? "recovery" : "execution",
          may_have_effect: true,
        },
      };
      const loss = {
        runtime_id: replacement.runtime.id,
        generation: replacement.runtime.generation,
        owner_id: "reserved-owner",
        loss_id: "replacement-loss",
        report_revision: 1,
        termination: dispatched ? "unknown" : "confirmed",
        reason: receipt.error.code,
        observed_at: "2030-01-01T00:00:00Z",
      };
      const receiptReport = { id: "force-outcome", method: "command.receipt", params: receipt };
      const lossReport = { id: "replacement-loss", method: "runtime.lost", params: loss };
      c.send(lossFirst ? lossReport : receiptReport);
      expect(f.w.executions.runtime(old.session_id)).toMatchObject({
        state: lossFirst ? "error" : "starting",
        termination: lossFirst ? loss.termination : "unknown",
        native_session_id: null,
      });
      c.send(lossFirst ? receiptReport : lossReport);
      expect(c.frames.find((frame) => frame.id === "force-outcome")).toMatchObject({
        result: { command_id: replacement.command.id, receipt_revision: receipt.receipt_revision },
      });
      expect(c.frames.find((frame) => frame.id === "replacement-loss")).toMatchObject({
        result: {
          runtime_id: replacement.runtime.id,
          loss_id: loss.loss_id,
          applied_revision: 1,
          fenced: true,
          termination: loss.termination,
        },
      });
      const reconnected = f.connect();
      reconnected.send({ id: "replayed-receipt", method: "command.receipt", params: receipt });
      reconnected.send({ id: "replayed-loss", method: "runtime.lost", params: loss });
      reconnected.send({ id: "stale-admission", method: "command.receipt", params: admission });
      expect(reconnected.frames.find((frame) => frame.id === "stale-admission")).toMatchObject({
        result: {
          command_id: replacement.command.id,
          receipt_revision: receipt.receipt_revision,
        },
      });
      expect(f.w.executions.runtime(old.session_id)).toMatchObject({
        id: replacement.runtime.id,
        state: "error",
        fenced: 1,
        termination: loss.termination,
        resume_requires_force: true,
        native_session_id: null,
      });
      const retained = f.w.executions.command(replacement.command.id);
      expect(retained).toMatchObject({
        state: "acknowledged",
        result: {
          acceptance: admission.acceptance,
          dispatch: receipt.dispatch,
          error: { code: receipt.error.code, stage: receipt.error.stage, may_have_effect: true },
        },
      });
      expect(retained.result).not.toHaveProperty("result");
      expect(
        f.w.one<{ termination: string; fenced: number; loss_revision: number }>(
          "SELECT termination,fenced,loss_revision FROM session_runtimes WHERE id=?",
          old.id,
        ),
      ).toEqual({
        termination: dispatched ? "confirmed" : "unknown",
        fenced: 1,
        loss_revision: dispatched ? 2 : 1,
      });
      expect(
        f.w.all<{ loss_id: string }>(
          "SELECT DISTINCT loss_id FROM runtime_losses WHERE runtime_id=?",
          old.id,
        ),
      ).toEqual([{ loss_id: oldLoss.loss_id }]);
      expect(
        f.w.all("SELECT * FROM command_receipts WHERE command_id=?", replacement.command.id),
      ).toHaveLength(1);
      expect(
        f.w.all("SELECT * FROM runtime_losses WHERE runtime_id=?", replacement.runtime.id),
      ).toHaveLength(1);
      expect(
        f.call<{ command: SessionCommand }>("session_resume", {
          ...args,
          operation_key: "original-force",
        }).command.id,
      ).toBe(replacement.command.id);
      f.tower.wake();
      expect(
        [...c.frames, ...reconnected.frames].filter(
          (frame) => frame.method === "command.execute" && frame.id === replacement.command.id,
        ),
      ).toHaveLength(1);
      expect(
        reconnected.frames.some(
          (frame) =>
            frame.method === "command.status" && frame.id === `receipt:${replacement.command.id}`,
        ),
      ).toBe(dispatched);
      expect(() => f.call("session_resume", { ...args, force: false })).toThrow(
        "termination is unconfirmed",
      );
      const next = f.call<{ command: SessionCommand }>("session_resume", args);
      const unresolved = dispatched ? replacement.runtime : old;
      expect(next.command.payload.cleanup).toEqual([
        { runtime_id: unresolved.id, generation: unresolved.generation },
      ]);
    } finally {
      f.close();
    }
  });

for (const outcome of ["partial", "recovered", "uncertain"] as const) {
  for (const lossFirst of [false, true]) {
    test(`Tower receipt fixture ${outcome}, loss first=${lossFirst}, skipped revisions and replay`, () => {
      const f = fixture();
      try {
        let c = f.connect();
        const frames = c.frames;
        const identities = new Map<string, string>();
        const remap = (value: unknown): unknown => {
          if (typeof value === "string") return identities.get(value) ?? value;
          if (Array.isArray(value)) return value.map(remap);
          if (value && typeof value === "object")
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)]));
          return value;
        };
        const send = (value: unknown) => c.send(remap(value) as Record<string, unknown>);
        const first = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
          "session_launch",
          { machine_id: f.m.id, harness: "codex", cwd: "/work/project" },
        ).runtime;
        identities.set("logical-session", first.session_id);
        identities.set("previous-a", first.id);
        identities.set("generation-a", first.generation);
        f.w.run(
          "UPDATE session_runtimes SET native_session_id='native-thread' WHERE id=?",
          first.id,
        );
        const resume = {
          target_session_id: first.session_id,
          machine_id: f.m.id,
          cwd: "/work/project",
          force: true,
        };
        const second = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
          "session_resume",
          resume,
        ).runtime;
        identities.set("previous-b", second.id);
        identities.set("generation-b", second.generation);
        send({
          id: "previous-b-loss",
          method: "runtime.lost",
          params: forceReceipts.recovered_cleanup_uncertainty.old_target_b,
        });
        const replacement = f.call<{
          runtime: import("../shared/contracts.ts").SessionRuntime;
          command: SessionCommand;
        }>("session_resume", { ...resume, operation_key: "fixture-force" });
        identities.set("replacement", replacement.runtime.id);
        identities.set("replacement-generation", replacement.runtime.generation);
        identities.set("force-command", replacement.command.id);
        identities.set("execute-force", replacement.command.id);
        expect(replacement.command.payload.cleanup).toEqual(
          remap(forceReceipts.force_request.params.payload.cleanup),
        );
        const recovered = forceReceipts.recovered_cleanup_uncertainty;
        let reports: unknown[];
        if (outcome === "partial") {
          for (const report of forceReceipts.partial_cleanup_failure.slice(0, -2)) send(report);
          reports = forceReceipts.partial_cleanup_failure.slice(-2);
        } else {
          send({
            id: "target-a-confirmed",
            method: "runtime.lost",
            params: recovered.old_target_a,
          });
          send({
            id: "target-b-current",
            method: "runtime.lost",
            params:
              outcome === "uncertain"
                ? {
                    ...recovered.old_target_b,
                    report_revision: 2,
                    termination: "confirmed",
                  }
                : recovered.old_target_b,
          });
          if (outcome === "recovered") {
            send({
              id: "waiting-for-authority",
              method: "command.receipt",
              params: recovered.retained_receipt_while_waiting_for_authority,
            });
            expect(f.w.executions.runtime(first.session_id)).toMatchObject({
              state: "starting",
              termination: "unknown",
              native_session_id: null,
            });
            c = f.connect();
            reports = recovered.on_unverifiable_cleanup;
          } else reports = forceReceipts.after_replacement_dispatch_uncertainty;
        }
        const mapped = reports.map(
          (report) => remap(report) as { id: string; method: string; params: unknown },
        );
        const receipt = receiptSchema.parse(
          mapped.find((report) => report.method === "command.receipt")?.params,
        );
        const loss = lossSchema.parse(
          mapped.find((report) => report.method === "runtime.lost")?.params,
        );
        if (lossFirst) mapped.reverse();
        for (const report of mapped) c.send(report);
        expect(f.w.executions.command(replacement.command.id)).toMatchObject({
          state: "acknowledged",
          result: {
            acceptance: receipt.acceptance,
            receipt_revision: receipt.receipt_revision,
            dispatch: receipt.dispatch,
            error: {
              code: receipt.error?.code,
              stage: receipt.error?.stage,
              may_have_effect: true,
            },
          },
        });
        expect(f.w.executions.command(replacement.command.id).result).not.toHaveProperty("result");
        expect(f.w.executions.runtime(first.session_id)).toMatchObject({
          id: replacement.runtime.id,
          owner_id: loss.owner_id,
          state: "error",
          fenced: 1,
          termination: loss.termination,
          native_session_id: null,
          acp_session_id: null,
          tower_session_id: null,
        });
        expect(
          f.w.all("SELECT * FROM session_events WHERE runtime_id=?", replacement.runtime.id),
        ).toHaveLength(0);
        expect(
          f.w.one<{ loss_revision: number; termination: string }>(
            "SELECT loss_revision,termination FROM session_runtimes WHERE id=?",
            first.id,
          ),
        ).toEqual({ loss_revision: 2, termination: "confirmed" });
        expect(
          f.w.one<{ termination: string }>(
            "SELECT termination FROM session_runtimes WHERE id=?",
            second.id,
          ),
        ).toEqual({ termination: outcome === "uncertain" ? "confirmed" : "unknown" });
        const reconnect = f.connect();
        for (const report of mapped) reconnect.send(report);
        reconnect.send({
          id: "late-admission",
          method: "command.receipt",
          params: remap(recovered.retained_receipt_while_waiting_for_authority),
        });
        expect(reconnect.frames.find((frame) => frame.id === "late-admission")).toMatchObject({
          result: {
            command_id: replacement.command.id,
            receipt_revision: receipt.receipt_revision,
          },
        });
        expect(
          f.w.all("SELECT * FROM runtime_losses WHERE runtime_id=?", replacement.runtime.id),
        ).toHaveLength(1);
        expect(
          receiptSchema.parse(f.w.executions.command(replacement.command.id).result).dispatch,
        ).toEqual(receipt.dispatch);
        expect(
          f.call<{ command: SessionCommand }>("session_resume", {
            ...resume,
            operation_key: "fixture-force",
          }).command.id,
        ).toBe(replacement.command.id);
        expect(
          [...new Set([frames, c.frames, reconnect.frames])]
            .flat()
            .filter(
              (frame) => frame.method === "command.execute" && frame.id === replacement.command.id,
            ),
        ).toHaveLength(1);
        const next = f.call<{ command: SessionCommand }>("session_resume", resume);
        const unresolved = outcome === "uncertain" ? replacement.runtime : second;
        expect(next.command.payload.cleanup).toEqual([
          { runtime_id: unresolved.id, generation: unresolved.generation },
        ]);
      } finally {
        f.close();
      }
    });
  }
}

test("private retirement needs no payload and cannot resurrect controls after turn end or loss", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const r = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
      "session_launch",
      { machine_id: f.m.id, harness: "fixture", cwd: "/work/project" },
    ).runtime;
    const base = { runtime_id: r.id, generation: r.generation, source_key: r.generation };
    c.send({
      id: "ready",
      method: "session.events",
      params: {
        ...base,
        events: [
          {
            sequence: 1,
            key: "ready",
            kind: "runtime_state",
            payload: {
              state: "idle",
              owner_id: "owner-native",
              tower_session_id: "tower",
              acp_session_id: "acp",
            },
          },
        ],
      },
    });
    const prompt = f.call<SessionCommand>("session_prompt", {
      target_session_id: r.session_id,
      content: [{ type: "text", text: "Inspect" }],
    });
    const request = {
      runtime_id: r.id,
      generation: r.generation,
      owner_id: "owner-native",
      source_request_id: "occurrence",
      request_revision: 1,
      native_request_id: 42,
      kind: "permission",
      state: "pending",
      payload: { options: [], token: "private-payload" },
    };
    c.send({ id: "pending", method: "session.request", params: request });
    const id = f.w.one<{ id: string }>("SELECT id FROM session_requests")!.id;
    c.send({
      id: "end",
      method: "session.events",
      params: {
        ...base,
        events: [{ sequence: 2, key: "end", kind: "turn_end", command_id: prompt.id, payload: {} }],
      },
    });
    const retired = { ...request, request_revision: 2, state: "stale", payload: null };
    c.send({ id: "retire", method: "session.request", params: retired });
    c.send({ id: "retire-again", method: "session.request", params: retired });
    expect(c.frames.at(-1)).toMatchObject({
      result: { request_id: id, request_revision: 2, applied_request_revision: 2, state: "stale" },
    });
    expect(f.w.executions.managed.request(id)).toBeUndefined();
    c.send({
      id: "fence",
      method: "runtime.lost",
      params: {
        runtime_id: r.id,
        generation: r.generation,
        owner_id: "owner-native",
        loss_id: "loss",
        report_revision: 1,
        termination: "unknown",
        reason: "owner_unreachable",
        observed_at: "2030-01-01T00:00:00Z",
      },
    });
    const { payload: _private, ...bodyFree } = request;
    c.send({
      id: "unseen-retirement",
      method: "session.request",
      params: { ...bodyFree, source_request_id: "unseen", request_revision: 2, state: "cancelled" },
    });
    expect(c.frames.at(-1)).toMatchObject({
      result: { source_request_id: "unseen", state: "cancelled" },
    });
    c.send({
      id: "reopen",
      method: "session.request",
      params: { ...request, request_revision: 3 },
    });
    expect(c.frames.at(-1)).toMatchObject({ error: { data: { code: "stale_request" } } });
    expect(JSON.stringify(f.w.all("SELECT * FROM session_requests"))).not.toContain(
      "private-payload",
    );
    expect(f.w.all("SELECT * FROM session_requests WHERE state='pending'")).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("runtime batches bind identities atomically and reconnect waits for fresh readiness", () => {
  const f = fixture();
  try {
    const c = f.connect();
    const { runtime: r } = f.call<{ runtime: import("../shared/contracts.ts").SessionRuntime }>(
      "session_launch",
      { machine_id: f.m.id, harness: "fixture", cwd: "/work/project" },
    );
    const base = { runtime_id: r.id, generation: r.generation, source_key: r.generation };
    const ready = {
      sequence: 1,
      key: "ready",
      kind: "runtime_state",
      payload: {
        state: "idle",
        owner_id: "owner",
        tower_session_id: "tower",
        acp_session_id: "acp",
      },
    };
    c.send({
      id: "conflicting-identities",
      method: "session.events",
      params: {
        ...base,
        events: [
          ready,
          {
            ...ready,
            sequence: 2,
            key: "other-owner",
            payload: { ...ready.payload, owner_id: "other" },
          },
        ],
      },
    });
    expect(c.frames.at(-1)).toMatchObject({
      error: { data: { code: "runtime_identity_conflict" } },
    });
    expect(f.w.all("SELECT id FROM session_events")).toHaveLength(0);
    expect(f.w.executions.runtime(r.session_id)?.owner_id).toBeNull();
    c.send({ id: "ready", method: "session.events", params: { ...base, events: [ready] } });
    const first = f.call<SessionCommand>("session_prompt", {
      target_session_id: r.session_id,
      content: [{ type: "text", text: "First" }],
    });
    const next = f.call<SessionCommand>("session_prompt", {
      target_session_id: r.session_id,
      content: [{ type: "text", text: "Next" }],
    });
    const b = f.connect();
    b.send({ id: "replay", method: "session.events", params: { ...base, events: [ready] } });
    expect(f.w.executions.runtime(r.session_id)?.connected).toBe(false);
    b.send({
      id: "backlog",
      method: "session.events",
      params: {
        ...base,
        events: [
          { sequence: 2, key: "finished", kind: "turn_end", command_id: first.id, payload: {} },
        ],
      },
    });
    expect(f.w.executions.runtime(r.session_id)?.connected).toBe(false);
    expect(f.w.executions.command(next.id).state).toBe("queued");
    b.send({
      id: "fresh-ready",
      method: "session.events",
      params: { ...base, events: [{ ...ready, sequence: 3, key: "reconnected" }] },
    });
    expect(f.w.executions.runtime(r.session_id)?.connected).toBe(true);
    expect(f.w.executions.command(next.id).state).toBe("sent");
    b.send({
      id: "empty-identity",
      method: "session.events",
      params: {
        ...base,
        events: [
          {
            ...ready,
            sequence: 4,
            key: "invalid",
            payload: { ...ready.payload, native_session_id: "" },
          },
        ],
      },
    });
    expect(b.frames.at(-1)).toMatchObject({
      error: { data: { code: "runtime_identity_conflict" } },
    });
  } finally {
    f.close();
  }
});
