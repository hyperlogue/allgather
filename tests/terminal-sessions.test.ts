import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { openDatabase } from "../server/storage.ts";
import { Tower, type TowerSocketData } from "../server/tower.ts";
import { Workspace } from "../server/workspace.ts";
import type { Machine, Operation, SessionCommand, SessionRuntime } from "../shared/contracts.ts";
import { type MachineScope, terminalControlsSchema } from "../shared/tower-acp.ts";
import { fixtureOwner, fullControls } from "./fixtures/tower-controls.ts";
import wire from "./fixtures/tower-terminal-v1.json";

function fixture(scopes: MachineScope[] = ["read", "send", "terminal:control"]) {
  const db = openDatabase(":memory:");
  let tower: Tower;
  const w = new Workspace(db, undefined, () => tower?.wake());
  const owner = fixtureOwner(w);
  tower = new Tower(w, "http://127.0.0.1:4390");
  const call = <T>(name: Operation, input: Record<string, unknown> = {}) =>
    w.execute(name, { operation_key: randomUUID(), ...input }, owner) as T;
  const machine = call<Machine>("machines_create", { name: "Terminal fixture" });
  const credential = w.executions.issueCredential(machine.id, "Terminal fixture", scopes);
  const connect = (extra: Record<string, unknown> = {}, key = credential) => {
    const frames: Record<string, any>[] = [];
    const data = tower.authenticate(
      new Request("http://127.0.0.1:4390/tower", {
        headers: { authorization: `Bearer ${key.access_key}` },
      }),
    )!;
    const socket = {
      data,
      send(text: string) {
        frames.push(JSON.parse(text));
        return 1;
      },
      close() {
        tower.close(socket);
      },
    } as unknown as ServerWebSocket<TowerSocketData>;
    tower.open(socket);
    const send = (message: Record<string, unknown>) =>
      tower.message(socket, JSON.stringify({ jsonrpc: "2.0", ...message }));
    send({ id: "hello", method: "hello", params: { ...structuredClone(wire.hello), ...extra } });
    const policy = frames.find((f) => f.method === "policy.push");
    if (policy)
      send({
        id: policy.id,
        result: {
          policy_id: "tower",
          previous_revision: null,
          applied_revision: policy.params.revision,
          outcome: "applied",
          changed_rule_ids: [],
          reason: null,
          received_at: Date.now(),
        },
      });
    return { frames, send, socket };
  };
  const launch = (input: Record<string, unknown> = {}) =>
    call<{ runtime: SessionRuntime; command: SessionCommand }>("session_launch", {
      machine_id: machine.id,
      ...wire.launch,
      ...input,
    });
  return {
    db,
    w,
    owner,
    tower,
    machine,
    credential,
    call,
    connect,
    launch,
    close() {
      tower.stop();
      db.close();
    },
  };
}
function events(
  r: SessionRuntime,
  sequence: number,
  payload: unknown = wire.ready,
  kind = "runtime_state",
) {
  return {
    id: `events-${sequence}`,
    method: "session.events",
    params: {
      runtime_id: r.id,
      generation: r.generation,
      source_key: r.generation,
      events: [{ sequence, key: `terminal-event-${sequence}`, kind, payload }],
    },
  };
}
function receipt(
  r: SessionRuntime,
  command: SessionCommand,
  revision: number,
  result?: Record<string, string>,
) {
  return {
    command_id: command.id,
    runtime_id: r.id,
    generation: r.generation,
    receipt_revision: revision,
    state: "accepted",
    acceptance: { level: "adapter", at: "2026-11-05T00:00:00Z" },
    dispatch: { state: result ? "finished" : "not_started" },
    ...(result ? { result } : {}),
  };
}

test("terminal-only negotiation launches with adapter evidence and lifecycle-only identity", () => {
  const f = fixture();
  try {
    const c = f.connect();
    expect(c.frames.find((m) => m.id === "hello")!.result.capabilities).toContain(
      "terminal-launch.v1",
    );
    expect(f.w.executions.machine(f.machine.id).harness_controls).toEqual({});
    expect(f.w.executions.machine(f.machine.id).connection_scopes).toEqual([
      "read",
      "send",
      "terminal:control",
    ]);
    const launched = f.launch(),
      r = launched.runtime;
    const sent = c.frames.find((m) => m.method === "command.execute")!;
    expect(sent.params).toMatchObject({
      command_id: launched.command.id,
      session_id: r.session_id,
      runtime_id: r.id,
      generation: r.generation,
      kind: "launch",
      payload: wire.payload,
    });
    expect(sent.params.payload).toEqual(wire.payload);
    expect(r.controls).toEqual(terminalControlsSchema.parse(wire.hello.terminal_controls).fixture);
    c.send({ id: "admitted", method: "command.receipt", params: receipt(r, launched.command, 1) });
    expect(c.frames.at(-1)).toMatchObject({ id: "admitted", result: { receipt_revision: 1 } });
    expect(f.w.executions.runtime(r.session_id)?.state).toBe("starting");
    c.send(events(r, 1));
    expect(c.frames.at(-1)).toMatchObject({ id: "events-1", result: { cursor: 1 } });
    expect(f.w.executions.runtime(r.session_id)).toMatchObject({
      protocol: "terminal",
      state: "running",
      connected: true,
      owner_id: "terminal-owner",
      tower_session_id: "tower-terminal",
      acp_session_id: null,
      native_session_id: null,
      active_prompt_id: null,
    });
    expect(
      f.w.one<{ kind: string; format_version: string; coverage: string }>(
        "SELECT kind,format_version,coverage FROM transcript_sources WHERE runtime_id=?",
        r.id,
      ),
    ).toEqual({ kind: "terminal_lifecycle", format_version: "terminal.v1", coverage: "partial" });
    c.send({
      id: "created",
      method: "command.receipt",
      params: receipt(r, launched.command, 2, {
        tower_session_id: "tower-terminal",
        owner_id: "terminal-owner",
        outcome: "completed",
      }),
    });
    expect(f.w.executions.runtime(r.session_id)?.state).toBe("running");
    c.send(events(r, 2, { ...wire.ready, native_session_id: "late-native-id" }));
    expect(f.w.executions.runtime(r.session_id)?.native_session_id).toBe("late-native-id");
    c.send({
      id: "cursor",
      method: "session.cursor",
      params: { runtime_id: r.id, generation: r.generation, source_key: r.generation },
    });
    expect(c.frames.at(-1)).toMatchObject({ result: { cursor: 2 } });
    const replay = f.launch({ operation_key: launched.command.request_key });
    expect(replay.command.id).toBe(launched.command.id);
    expect(c.frames.filter((m) => m.method === "command.execute")).toHaveLength(1);
    const cancelled = f.call<SessionCommand>("session_cancel", { target_session_id: r.session_id });
    expect(c.frames.find((m) => m.id === cancelled.id)?.params).toMatchObject({
      kind: "cancel",
      generation: r.generation,
      payload: {},
    });
    c.send({
      id: "stopped",
      method: "command.receipt",
      params: receipt(r, cancelled, 1, {
        owner_id: "terminal-owner",
        tower_session_id: "tower-terminal",
        outcome: "stopped",
      }),
    });
    c.send(events(r, 3, { state: "ended", termination: "confirmed" }));
    expect(f.w.executions.runtime(r.session_id)).toMatchObject({
      state: "ended",
      fenced: 1,
      termination: "confirmed",
      connected: false,
    });
    expect(
      f.w.one<{ n: number }>("SELECT COUNT(*) n FROM session_events WHERE kind='turn_end'")!.n,
    ).toBe(0);
  } finally {
    f.close();
  }
});

test("terminal launch needs negotiated descriptors, current consent, and explicit mode", () => {
  for (const scopes of [
    ["read", "send"],
    ["read", "send", "acp:control"],
  ] as MachineScope[][]) {
    const f = fixture(scopes);
    try {
      f.connect();
      expect(f.launch).toThrow("terminal:control");
      expect(f.w.all("SELECT id FROM session_commands")).toEqual([]);
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    f.connect({ terminal_controls: {} });
    expect(f.launch).toThrow("not advertised");
    f.connect({
      capabilities: [
        "policy-sync.v1",
        "session-status.v1",
        "command-receipts.v1",
        "session-stream.v1",
      ],
    });
    expect(f.launch).toThrow("not negotiated");
    const c = f.connect();
    expect(() => f.launch({ mode: undefined })).toThrow("managed-acp.v1");
    expect(() => f.launch({ harness: "missing" })).toThrow("not advertised");
    expect(() => f.launch({ args: ["sh", "-c", "echo unsupported"] })).toThrow("Invalid request");
    f.tower.close(c.socket);
    expect(f.launch).toThrow("current Tower connection");
    expect(f.w.all("SELECT id FROM session_commands")).toEqual([]);
  } finally {
    f.close();
  }
});

test("terminal controls never fall back to native prompting or accept private/output data", () => {
  const f = fixture(["read", "send", "terminal:control", "acp:control"]);
  try {
    const c = f.connect({
      acp_harnesses: ["fixture"],
      harness_controls: { fixture: fullControls() },
      capabilities: [...wire.hello.capabilities, "managed-acp.v1", "session-resume.v1"],
    });
    const { runtime: r, command } = f.launch();
    c.send(events(r, 1));
    for (const [name, args] of [
      ["session_prompt", { content: [{ type: "text", text: "No PTY injection" }] }],
      ["session_configure", { config: {} }],
      ["session_resume", { machine_id: f.machine.id, cwd: "/work/project" }],
    ] as const) {
      try {
        f.call(name, { target_session_id: r.session_id, ...args });
        throw new Error("Unsupported command admitted");
      } catch (error) {
        expect(error).toMatchObject({ code: "unsupported_control" });
      }
    }
    expect(f.w.all("SELECT id FROM session_commands")).toHaveLength(1);
    for (const kind of ["text", "turn_end", "permission_request", "gap"]) {
      c.send(events(r, 2, {}, kind));
      expect(c.frames.at(-1)).toMatchObject({
        error: { data: { code: "invalid_terminal_event" } },
      });
    }
    for (const payload of [
      { ...wire.ready, acp_session_id: "fake" },
      { ...wire.ready, raw_output: "private output" },
      { state: "ended", termination: "unknown" },
    ]) {
      c.send(events(r, 2, payload));
      expect(c.frames.at(-1)).toMatchObject({
        error: { data: { code: "invalid_terminal_event" } },
      });
    }
    const falseAck = receipt(r, command, 1);
    c.send({
      id: "false-harness",
      method: "command.receipt",
      params: { ...falseAck, acceptance: { ...falseAck.acceptance, level: "harness" } },
    });
    expect(c.frames.at(-1)).toMatchObject({ error: { data: { code: "invalid_control" } } });
    c.send({
      id: "private",
      method: "session.request",
      params: {
        runtime_id: r.id,
        generation: r.generation,
        owner_id: "terminal-owner",
        source_request_id: "request",
        request_revision: 1,
        native_request_id: "native",
        kind: "permission",
        state: "pending",
        payload: { options: [] },
      },
    });
    expect(c.frames.at(-1)).toMatchObject({ error: { data: { code: "unsupported_control" } } });
    expect(f.w.all("SELECT id FROM session_requests")).toEqual([]);
    expect(f.w.one<{ n: number }>("SELECT COUNT(*) n FROM session_events")!.n).toBe(1);
    expect(
      terminalControlsSchema.safeParse({
        fixture: { ...wire.ready.controls, capabilities: ["prompt"] },
      }).success,
    ).toBe(false);
  } finally {
    f.close();
  }
});

test("terminal lifecycle replay cannot restore readiness or reopen a fenced execution", () => {
  const f = fixture();
  try {
    let c = f.connect();
    const { runtime: r } = f.launch();
    c.send(events(r, 1));
    expect(c.frames.filter((m) => m.method === "command.execute")).toHaveLength(1);
    f.tower.close(c.socket);
    c = f.connect();
    c.send(events(r, 1));
    expect(f.w.executions.runtime(r.session_id)?.connected).toBe(false);
    c.send(events(r, 2));
    expect(f.w.executions.runtime(r.session_id)?.connected).toBe(true);
    c.send({
      id: "lost",
      method: "runtime.lost",
      params: {
        runtime_id: r.id,
        generation: r.generation,
        loss_id: "loss",
        report_revision: 1,
        owner_id: "terminal-owner",
        termination: "unknown",
        reason: "pool_unreachable",
        observed_at: "2026-11-05T00:00:00Z",
      },
    });
    expect(c.frames.at(-1)).toMatchObject({ result: { fenced: true, termination: "unknown" } });
    c.send(events(r, 3));
    expect(f.w.executions.runtime(r.session_id)).toMatchObject({
      fenced: 1,
      connected: false,
      termination: "unknown",
    });
    expect(() =>
      f.call("session_resume", {
        target_session_id: r.session_id,
        machine_id: f.machine.id,
        cwd: "/work/project",
      }),
    ).toThrow("not supported");
    expect(c.frames.filter((m) => m.method === "command.execute")).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("queued terminal dispatch uses the current credential rather than another stored grant", () => {
  const f = fixture();
  try {
    f.connect();
    f.call("machines_update", { machine_id: f.machine.id, expected_revision: 1, policy: [] });
    const queued = f.launch();
    expect(f.w.executions.command(queued.command.id).state).toBe("queued");
    const reduced = f.w.executions.issueCredential(f.machine.id, "Read-only connection", ["read"]);
    const c = f.connect({}, reduced);
    expect(f.w.executions.machine(f.machine.id).connection_scopes).toEqual(["read"]);
    expect(f.launch).toThrow("terminal:control");
    f.tower.wake();
    expect(c.frames.some((frame) => frame.method === "command.execute")).toBe(false);
    const cancelled = f.call<SessionCommand>("session_cancel", {
      target_session_id: queued.runtime.session_id,
    });
    expect(cancelled).toMatchObject({
      state: "acknowledged",
      result: { cancelled_before_launch: true },
    });
    expect(c.frames.some((frame) => frame.method === "command.execute")).toBe(false);
  } finally {
    f.close();
  }
});
