import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { openDatabase } from "../server/storage.ts";
import { Tower, type TowerSocketData } from "../server/tower.ts";
import { Workspace } from "../server/workspace.ts";
import type {
  Machine,
  Operation,
  Project,
  Repository,
  SessionRuntime,
} from "../shared/contracts.ts";
import type { MachineScope } from "../shared/tower-acp.ts";
import {
  type CheckoutObservation,
  catalogCapabilities,
  catalogDeltaSchema,
  catalogSchema,
  checkoutDeltaSchema,
  checkoutSnapshotSchema,
  type RepositoryCatalog,
  type TowerCheckout,
} from "../shared/tower-catalog.ts";
import { stateDeltaSchema, stateDeltaSchemaFor } from "../shared/tower-sync.ts";
import fixtures from "./fixtures/tower-catalog-v1.json";
import { fixtureOwner } from "./fixtures/tower-controls.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
type Frame = { id?: string; method?: string; params: Record<string, unknown>; result?: unknown };
function fixture() {
  const db = openDatabase(":memory:");
  let tower: Tower;
  const w = new Workspace(db, undefined, () => tower?.wake());
  tower = new Tower(w, "http://127.0.0.1:4390");
  cleanups.push(() => {
    tower.stop();
    db.close();
  });
  const owner = fixtureOwner(w);
  const call = <T>(name: Operation, input: Record<string, unknown>) =>
    w.execute(name, { operation_key: randomUUID(), ...input }, owner) as T;
  const project = call<Project>("projects_create", { name: "Web" });
  const repo = call<Repository>("repositories_create", {
    project_id: project.id,
    name: "Main",
    upstream_url: "https://example.invalid/team/repo.git",
    url_aliases: ["git@example.invalid:team/repo.git"],
    sync_enabled: false,
  });
  const machine = () => call<Machine>("machines_create", { name: randomUUID() });
  const connect = (
    m: Machine,
    scopes: MachineScope[] = ["read"],
    capabilities: string[] = [...catalogCapabilities],
  ) => {
    const credential = w.executions.issueCredential(m.id, "Synthetic", scopes);
    const data = tower.authenticate(
      new Request("http://127.0.0.1:4390/tower", {
        headers: { authorization: `Bearer ${credential.access_key}` },
      }),
    )!;
    const frames: Frame[] = [],
      closed: number[] = [];
    const socket = {
      data,
      send: (body: string) => {
        frames.push(JSON.parse(body));
        return 1;
      },
      close: (code: number) => {
        closed.push(code);
        tower.close(socket);
      },
    } as unknown as ServerWebSocket<TowerSocketData>;
    tower.open(socket);
    const send = (message: Record<string, unknown>) =>
      tower.message(socket, JSON.stringify({ jsonrpc: "2.0", ...message }));
    const last = (method: string) => frames.findLast((f) => f.method === method)!;
    const ack = () => {
      const f = frames.findLast(
        (f) => f.method === "catalog.push" || f.method === "catalog.delta",
      )!;
      send({ id: f.id, result: { revision: f.params.revision } });
      return f;
    };
    send({
      id: "hello",
      method: "hello",
      params: {
        protocol_version: { major: 1, minor: 4 },
        host_id: m.id,
        tower_version: "fixture",
        capabilities: [
          "policy-sync.v1",
          "session-status.v1",
          "session-status-delta.v1",
          ...capabilities,
        ],
      },
    });
    return { socket, send, frames, closed, last, ack, credential };
  };
  const list = (machine_id?: string, include_removed = false) =>
    w.execute("checkouts_list", { machine_id, include_removed }, owner) as CheckoutObservation[];
  const record = (id = "local-checkout", extra: Partial<TowerCheckout> = {}): TowerCheckout => ({
    id,
    repository_id: repo.id,
    path: "/work/main",
    system: "git",
    branch: "main",
    head: "a".repeat(40),
    dirty: false,
    conflicts: false,
    locked: false,
    prunable: false,
    available: true,
    tracking_ref: "origin/main",
    ahead: 0,
    behind: 0,
    observed_at: 1793750400000,
    revision: 1,
    ...extra,
  });
  const runtime = (m: Machine, towerId: string) => {
    const id = randomUUID(),
      session = randomUUID();
    call("sessions_declare", { target_session_id: session, harness: "fixture" });
    w.run(
      "INSERT INTO session_runtimes(id,session_id,machine_id,cwd,tower_session_id,protocol,generation,state,connected,last_seen_at) VALUES(?,?,?,'/unrelated/cwd',?,'codex-app-server',?,'idle',1,?)",
      id,
      session,
      m.id,
      towerId,
      randomUUID(),
      w.now(),
    );
    return () =>
      w.execute("session_runtime_get", { target_session_id: session }, owner) as {
        runtime: SessionRuntime;
        checkout: CheckoutObservation | null;
      };
  };
  return { db, w, tower, call, project, repo, machine, connect, list, record, runtime };
}

test("catalog wire examples and strict records reject credentials and ambiguous deltas", () => {
  expect(catalogSchema.safeParse(fixtures.catalog_push.params).success).toBe(true);
  expect(catalogDeltaSchema.safeParse(fixtures.catalog_delta.params).success).toBe(true);
  expect(checkoutSnapshotSchema.safeParse(fixtures.checkout_snapshot.params).success).toBe(true);
  expect(checkoutDeltaSchema.safeParse(fixtures.checkout_delta.params).success).toBe(true);
  expect(
    stateDeltaSchemaFor(["checkout-sync.v1"]).safeParse(fixtures.status_checkout_null.params)
      .success,
  ).toBe(true);
  expect(
    stateDeltaSchemaFor(["checkout-sync.v1"]).safeParse(fixtures.status_checkout_unset.params)
      .success,
  ).toBe(true);
  for (const url of [
    "https://user:secret@example.invalid/repo",
    "ssh://git:secret@example.invalid/repo",
    "https://example.invalid/repo?token=secret",
    "file:///private/repo",
  ])
    expect(
      catalogSchema.safeParse({
        ...fixtures.catalog_push.params,
        repositories: [{ ...fixtures.catalog_push.params.repositories[0], upstream_url: url }],
      }).success,
    ).toBe(false);
  expect(
    checkoutSnapshotSchema.safeParse({
      ...fixtures.checkout_snapshot.params,
      records: [
        ...fixtures.checkout_snapshot.params.records,
        ...fixtures.checkout_snapshot.params.records,
      ],
    }).success,
  ).toBe(false);
  expect(
    checkoutDeltaSchema.safeParse({
      seq: 1,
      base_seq: 0,
      upserts: fixtures.checkout_snapshot.params.records,
      removed: ["checkout-web"],
    }).success,
  ).toBe(false);
});

test("catalog uses durable revisions, one ACKed base, coalesced deltas and full recovery", () => {
  const f = fixture(),
    m = f.machine(),
    c = f.connect(m);
  const full = c.last("catalog.push"),
    snapshot = full.params as unknown as RepositoryCatalog;
  expect(snapshot.repositories[0]).toMatchObject({
    id: f.repo.id,
    project_ids: [f.project.id],
    url_aliases: ["git@example.invalid:team/repo.git"],
  });
  let p = f.call<Project>("projects_update", {
    project_id: f.project.id,
    expected_revision: 1,
    name: "Web next",
  });
  expect(c.frames.filter((frame) => frame.method?.startsWith("catalog.")).length).toBe(1);
  c.ack();
  const delta = c.last("catalog.delta");
  expect(delta.params).toMatchObject({
    base_revision: snapshot.revision,
    projects: { upserts: [{ id: p.id, name: p.name }], removed: [] },
  });
  p = f.call<Project>("projects_update", {
    project_id: p.id,
    expected_revision: p.revision,
    name: "Web final",
  });
  c.send({ id: full.id, result: { revision: snapshot.revision } });
  expect(c.last("catalog.delta").id).toBe(delta.id);
  c.ack();
  c.ack();
  expect(c.socket.data.catalog.acknowledged?.projects[0].name).toBe("Web final");
  const revision = c.socket.data.catalog.acknowledged!.revision;
  f.call("repositories_set_paths", {
    repository_id: f.repo.id,
    project_id: p.id,
    expected_revision: 1,
    path_prefixes: ["apps/web"],
  });
  expect(
    f.w.one<{ revision: number }>("SELECT revision FROM repository_catalog_clock")?.revision,
  ).toBe(revision);
  c.send({ method: "catalog.resync", params: {} });
  expect(c.last("catalog.push").params.revision).toBe(revision);
  c.ack();
  const rotated = f.connect(m);
  expect(rotated.last("catalog.push").params.revision).toBe(revision);
  c.send({ method: "checkout.snapshot", params: { seq: 0, full: true, records: [f.record()] } });
  expect(f.list()).toHaveLength(0);
  expect(c.closed).toContain(4001);
  rotated.ack();
  rotated.send({
    method: "state.push",
    params: {
      seq: 0,
      full: true,
      records: [
        { id: "agent", tags: ["private"], needs_attention: true, checkout_id: "local-checkout" },
      ],
    },
  });
  expect(
    JSON.parse(f.w.one<{ record: string }>("SELECT record FROM tower_records")!.record),
  ).toEqual({ id: "agent", checkout_id: "local-checkout" });
});

test("status checkout references are capability-gated, bounded, and preserve delta null/unset semantics", () => {
  const f = fixture(),
    old = f.connect(f.machine(), ["read"], []);
  old.send({
    method: "state.push",
    params: { seq: 0, full: true, records: [{ id: "agent", checkout_id: "co" }] },
  });
  expect(
    JSON.parse(f.w.one<{ record: string }>("SELECT record FROM tower_records")!.record),
  ).toEqual({ id: "agent" });
  const delta = {
    seq: 1,
    base_seq: 0,
    upserts: [{ id: "agent", set: { checkout_id: "co" }, unset: [] }],
    removed: [],
  };
  expect(stateDeltaSchema.safeParse(delta).success).toBe(false);
  expect(stateDeltaSchemaFor(["checkout-sync.v1"]).safeParse(delta).success).toBe(true);
  old.send({ method: "state.delta", params: delta });
  expect(old.last("sync.resync")).toBeDefined();
  const m = f.machine(),
    c = f.connect(m),
    read = f.runtime(m, "agent");
  c.send({
    method: "state.push",
    params: {
      seq: 0,
      full: true,
      records: [
        { id: "agent", checkout_id: "missing" },
        { id: "malformed", checkout_id: { machine_id: "elsewhere", id: "co" } },
        { id: "too-long", checkout_id: "é".repeat(81) },
      ],
    },
  });
  expect(c.last("sync.ack").params).toEqual({
    cursor: 0,
    rejected: [
      { id: "malformed", reason: "invalid_checkout_id" },
      { id: "too-long", reason: "invalid_checkout_id" },
    ],
  });
  expect(read().runtime.checkout_id).toBe("missing");
  expect(read().checkout).toBeNull();
  c.send({ method: "state.delta", params: delta });
  expect(read().runtime.checkout_id).toBe("co");
  c.send({
    method: "state.delta",
    params: {
      ...delta,
      seq: 2,
      base_seq: 1,
      upserts: [{ id: "agent", set: { checkout_id: null }, unset: [] }],
    },
  });
  expect(read().runtime.checkout_id).toBeNull();
  c.send({ method: "state.delta", params: { ...delta, seq: 3, base_seq: 2 } });
  c.send({
    method: "state.delta",
    params: {
      ...delta,
      seq: 4,
      base_seq: 3,
      upserts: [{ id: "agent", set: {}, unset: ["checkout_id"] }],
    },
  });
  expect(read().runtime.checkout_id).toBeNull();
  expect(
    JSON.parse(
      f.w.one<{ record: string }>("SELECT record FROM tower_records WHERE machine_id=?", m.id)!
        .record,
    ),
  ).toEqual({ id: "agent" });
  const invalid = {
    ...delta,
    seq: 5,
    base_seq: 4,
    upserts: [{ id: "agent", set: { checkout_id: 42, status: "incorrect" }, unset: [] }],
  };
  c.send({ method: "state.delta", params: invalid });
  expect(c.last("sync.resync")).toBeDefined();
  expect(
    JSON.parse(
      f.w.one<{ record: string }>("SELECT record FROM tower_records WHERE machine_id=?", m.id)!
        .record,
    ),
  ).toEqual({ id: "agent" });
});

test("runtime checkout joins tolerate either snapshot order and never cross machines or infer cwd", () => {
  const f = fixture(),
    a = f.machine(),
    b = f.machine(),
    ca = f.connect(a),
    cb = f.connect(b);
  ca.ack();
  cb.ack();
  const readA = f.runtime(a, "same-agent"),
    readB = f.runtime(b, "same-agent");
  const status = {
    seq: 0,
    full: true,
    records: [{ id: "same-agent", checkout_id: "same-checkout", cwd: "/unrelated/cwd" }],
  };
  // A reports the reference first; B reports the checkout first with the same opaque IDs.
  ca.send({ method: "state.push", params: status });
  cb.send({
    method: "checkout.snapshot",
    params: { seq: 0, full: true, records: [f.record("same-checkout", { path: "/b/worktree" })] },
  });
  expect(readA().runtime.checkout_id).toBe("same-checkout");
  expect(readA().checkout).toBeNull();
  expect(readB().runtime.checkout_id).toBeNull();
  ca.send({
    method: "checkout.snapshot",
    params: { seq: 0, full: true, records: [f.record("same-checkout", { path: "/a/worktree" })] },
  });
  cb.send({ method: "state.push", params: status });
  expect(readA().checkout).toMatchObject({
    machine_id: a.id,
    checkout_id: "same-checkout",
    path: "/a/worktree",
  });
  expect(readB().checkout).toMatchObject({
    machine_id: b.id,
    checkout_id: "same-checkout",
    path: "/b/worktree",
  });
  expect(readA().runtime.cwd).toBe("/unrelated/cwd");
  ca.send({
    method: "checkout.delta",
    params: {
      seq: 1,
      base_seq: 0,
      upserts: [f.record("same-checkout", { path: "/a/moved", revision: 2 })],
      removed: [],
    },
  });
  expect(readA().checkout?.path).toBe("/a/moved");
  ca.send({
    method: "checkout.delta",
    params: { seq: 2, base_seq: 1, upserts: [], removed: ["same-checkout"] },
  });
  expect(readA().checkout).toMatchObject({ checkout_id: "same-checkout", present: false });
  expect(readB().checkout?.present).toBe(true);
  ca.send({
    method: "state.push",
    params: { seq: 1, full: true, records: [{ id: "same-agent", cwd: "/a/moved" }] },
  });
  expect(readA().runtime.checkout_id).toBeNull();
  expect(readA().checkout).toBeNull();
  expect(() =>
    f.call("session_prompt", {
      target_session_id: readB().runtime.session_id,
      content: [{ type: "text", text: "Must remain unauthorized" }],
    }),
  ).toThrow();
  expect(f.w.all("SELECT * FROM session_commands")).toHaveLength(0);
});

test("checkout identity survives moves, reconnect, absence, and identical IDs on another machine", () => {
  const f = fixture(),
    m = f.machine(),
    c = f.connect(m),
    record = f.record();
  c.send({ method: "checkout.snapshot", params: { seq: 0, full: true, records: [record] } });
  expect(f.list()).toHaveLength(0);
  expect(c.last("checkout.resync")).toBeDefined();
  c.ack();
  c.send({ method: "checkout.snapshot", params: { seq: 0, full: true, records: [record] } });
  const before = f.list(m.id)[0];
  expect(before.checkout_id).toBe(record.id);
  expect("id" in before).toBe(false);
  expect(before.connected).toBe(true);
  const moved = {
    ...record,
    path: "/work/renamed",
    branch: null,
    tracking_ref: null,
    locked: true,
    revision: 2,
  };
  const delta = { seq: 1, base_seq: 0, upserts: [moved], removed: [] };
  c.send({ method: "checkout.delta", params: delta });
  c.send({ method: "checkout.delta", params: delta });
  expect(c.last("checkout.ack").params).toEqual({ cursor: 1 });
  expect(f.list(m.id)).toHaveLength(1);
  expect(f.list(m.id)[0]).toMatchObject({
    checkout_id: record.id,
    path: "/work/renamed",
    branch: null,
    locked: true,
    revision: 2,
  });
  c.send({
    method: "checkout.delta",
    params: {
      seq: 2,
      base_seq: 0,
      upserts: [{ ...moved, path: "/wrong", revision: 3 }],
      removed: [],
    },
  });
  expect(c.last("checkout.resync")).toBeDefined();
  expect(f.list(m.id)[0].path).toBe("/work/renamed");
  c.send({ method: "checkout.snapshot", params: { seq: 3, full: true, records: [moved] } });
  const another = f.machine(),
    other = f.connect(another);
  other.ack();
  other.send({ method: "checkout.snapshot", params: { seq: 0, full: true, records: [record] } });
  expect(
    f
      .list()
      .map((r) => r.machine_id)
      .sort(),
  ).toEqual([m.id, another.id].sort());
  const reconnect = f.connect(m);
  reconnect.ack();
  expect(f.list(m.id)[0].connected).toBe(false);
  reconnect.send({ method: "checkout.snapshot", params: { seq: 0, full: true, records: [moved] } });
  reconnect.send({
    method: "checkout.delta",
    params: { seq: 1, base_seq: 0, upserts: [], removed: [record.id] },
  });
  expect(f.list(m.id)).toHaveLength(0);
  expect(f.list(m.id, true)[0]).toMatchObject({
    checkout_id: record.id,
    path: "/work/renamed",
    present: false,
  });
  reconnect.send({ method: "checkout.snapshot", params: { seq: 2, full: true, records: [moved] } });
  expect(f.list(m.id)[0].present).toBe(true);
  expect(f.w.all("SELECT * FROM audit_operations WHERE operation LIKE 'checkout.%'")).toHaveLength(
    0,
  );
});

test("checkout batches reject stale facts and unauthorized associations without partial writes", () => {
  const f = fixture(),
    m = f.machine(),
    c = f.connect(m);
  c.ack();
  c.send({
    method: "checkout.snapshot",
    params: { seq: 0, full: true, records: [f.record("one", { revision: 2 })] },
  });
  c.send({
    method: "checkout.delta",
    params: {
      seq: 1,
      base_seq: 0,
      upserts: [f.record("two"), f.record("one", { path: "/stale" })],
      removed: [],
    },
  });
  expect(c.closed).toContain(4002);
  expect(f.list(m.id).map((r) => r.checkout_id)).toEqual(["one"]);
  const fresh = f.connect(m);
  fresh.ack();
  fresh.send({
    method: "checkout.snapshot",
    params: {
      seq: 0,
      full: true,
      records: [
        f.record("one", { revision: 2 }),
        f.record("unauthorized", { repository_id: "missing" }),
      ],
    },
  });
  expect(fresh.closed).toContain(4002);
  expect(f.list(m.id).map((r) => r.checkout_id)).toEqual(["one"]);
  const conflict = f.connect(m);
  conflict.ack();
  conflict.send({
    method: "checkout.snapshot",
    params: {
      seq: 0,
      full: true,
      records: [f.record("one", { revision: 2, path: "/same-revision-conflict" })],
    },
  });
  expect(conflict.closed).toContain(4002);
  expect(f.w.executions.machine(m.id).catalog_sync?.checkout_error).toBe(
    "checkout_revision_conflict",
  );
});

test("read consent and capabilities gate catalog and checkouts; full recovery remains bounded", () => {
  const f = fixture();
  const denied = f.connect(f.machine(), ["send"]);
  expect(denied.frames.some((frame) => frame.method === "catalog.push")).toBe(false);
  denied.send({ method: "checkout.snapshot", params: { seq: 0, full: true, records: [] } });
  expect(denied.closed).toContain(4002);
  const old = f.connect(f.machine(), ["read"], []);
  expect(old.frames.some((frame) => frame.method === "catalog.push")).toBe(false);
  const m = f.machine(),
    c = f.connect(m);
  c.ack();
  const records = Array.from({ length: 150 }, (_, i) =>
    f.record(`co-${i}`, { path: `/work/${"x".repeat(3900)}${i}` }),
  );
  c.send({ method: "checkout.snapshot", params: { seq: 0, full: true, records } });
  c.send({
    method: "checkout.delta",
    params: {
      seq: 1,
      base_seq: 0,
      upserts: records.map((r, i) => ({ ...r, id: `extra-${i}` })),
      removed: [],
    },
  });
  expect(c.closed).toContain(4002);
  expect(f.list(m.id)).toHaveLength(150);
  expect(f.w.executions.machine(m.id).catalog_sync?.checkout_error).toBe(
    "checkout_projection_too_large",
  );
  const tooMany = f.connect(m);
  tooMany.ack();
  tooMany.send({
    method: "checkout.snapshot",
    params: {
      seq: 0,
      full: true,
      records: Array.from({ length: 5001 }, (_, i) => f.record(String(i))),
    },
  });
  expect(tooMany.closed).toContain(4002);
  expect(f.list(m.id)).toHaveLength(150);
});

test("catalog rejection needs recovery and oversized catalogs fail without a partial projection", () => {
  const f = fixture(),
    m = f.machine(),
    c = f.connect(m),
    first = c.last("catalog.push");
  c.send({ id: first.id, error: { code: -32602, data: { code: "revision_conflict" } } });
  expect(f.w.executions.machine(m.id).catalog_sync?.catalog_error).toBe("catalog_rejected");
  f.tower.wake();
  expect(c.frames.filter((frame) => frame.method === "catalog.push")).toHaveLength(1);
  c.send({ method: "catalog.resync", params: {} });
  const replacement = c.last("catalog.push");
  expect(replacement.id).not.toBe(first.id);
  c.send({ id: first.id, result: { revision: first.params.revision } });
  expect(c.socket.data.catalog.acknowledged).toBeNull();
  c.ack();
  expect(f.w.executions.machine(m.id).catalog_sync?.catalog_error).toBeNull();
  // Hold the next catalog update while later changes coalesce beyond the full-frame limit.
  for (let i = 0; i < 29; i++)
    f.call("repositories_create", {
      project_id: f.project.id,
      name: `Large ${i}`,
      upstream_url: `https://example.invalid/repo-${i}`,
      sync_enabled: false,
      url_aliases: Array.from(
        { length: 20 },
        (_, j) => `https://example.invalid/${i}/${j}/${"a".repeat(1800)}`,
      ),
    });
  c.ack();
  expect(c.closed).toContain(4009);
  expect(f.w.executions.machine(m.id).catalog_sync?.catalog_error).toBe("catalog_frame_too_large");
  expect(
    c.frames
      .filter((frame) => frame.method === "catalog.push" || frame.method === "catalog.delta")
      .every((frame) => Buffer.byteLength(JSON.stringify(frame)) <= 1024 * 1024),
  ).toBe(true);
});
