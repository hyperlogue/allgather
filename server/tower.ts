import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { AppError, type SessionRuntime } from "../shared/contracts.ts";
import {
  executionScope,
  gapPayloadSchema,
  harnessControlsSchema,
  hasSessionProtocol,
  liveSourceKind,
  managedCapabilities,
  narrowsControls,
  sessionControlSchema,
  terminalCapabilities,
  terminalControlsSchema,
  terminalStateSchema,
} from "../shared/tower-acp.ts";
import { catalogCapabilities } from "../shared/tower-catalog.ts";
import {
  type TowerPolicyAck,
  type TowerPolicyRule,
  towerPolicyAck,
} from "../shared/tower-policy.ts";
import {
  publicRecordFieldsFor,
  stateDeltaSchemaFor,
  statusCheckoutIdSchema,
} from "../shared/tower-sync.ts";
import { listenerRejection } from "./network.ts";
import { type CatalogConnection, catalogConnection, TowerCatalog } from "./tower-catalog.ts";
import { canonical, digest, uid, type Workspace } from "./workspace.ts";

const text = z.string().min(1).max(160),
  value = z.record(z.string(), z.unknown());
const helloSchema = z.object({
  protocol_version: z.object({ major: z.literal(1), minor: z.number().int().nonnegative() }),
  tower_version: text,
  host_id: text,
  capabilities: z.array(text).max(100),
  acp_harnesses: z.array(text).max(30).default([]),
  harness_controls: harnessControlsSchema.default({}),
  terminal_controls: terminalControlsSchema.default({}),
  policy_revision: z.number().int().nonnegative().nullable().optional(),
});
const eventSchema = z.object({
  sequence: z.number().int().positive(),
  key: text,
  kind: z.string().min(1).max(300),
  payload: value,
  at: z.iso.datetime({ offset: true }).optional(),
  command_id: text.optional(),
});
const eventBatch = z.object({
  runtime_id: text,
  generation: text,
  source_key: text,
  events: z.array(eventSchema).min(1).max(200),
});
export interface TowerSocketData {
  catalog: CatalogConnection;
  machineId: string;
  credentialId: string;
  connectionId: string;
  openedAt: number;
  hello: boolean;
  policyRevision: number;
  policyCompleted: number;
  policySentAt: number;
  reportedPolicyRevision: number | null;
  statusSequence: number;
  statusHash: string | null;
  statusRejections: { id: string; reason: string }[];
  receipts: Map<string, number>;
  capabilities: string[];
  scopes: string[];
  statusNeedsFull: boolean;
  policyRules: TowerPolicyRule[] | null;
  policyPending: {
    id: string;
    revision: number;
    rules: TowerPolicyRule[];
    method: string;
    params: unknown;
  } | null;
  policyForceFull: boolean;
}
type Socket = ServerWebSocket<TowerSocketData>;
export class Tower {
  private readonly catalog: TowerCatalog;
  private sockets = new Map<string, Socket>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private w: Workspace,
    readonly baseUrl: string,
  ) {
    this.catalog = new TowerCatalog(w, (socket, message) => this.send(socket, message));
  }
  authenticate(request: Request): TowerSocketData | null {
    const origin = request.headers.get("origin");
    if (listenerRejection(request, this.baseUrl, "private") || (origin && origin !== this.baseUrl))
      return null;
    const token = request.headers.get("authorization");
    if (!token?.startsWith("Bearer ")) return null;
    const credential = this.w.executions.authenticate(token.slice(7));
    return credential
      ? {
          catalog: catalogConnection(),
          machineId: credential.machine_id,
          credentialId: credential.id,
          connectionId: uid("tower-connection"),
          openedAt: Date.now(),
          hello: false,
          policyRevision: 0,
          policyCompleted: 0,
          policySentAt: 0,
          reportedPolicyRevision: null,
          statusSequence: -1,
          statusHash: null,
          statusRejections: [],
          receipts: new Map<string, number>(),
          capabilities: [],
          scopes: JSON.parse(credential.scopes),
          statusNeedsFull: true,
          policyRules: null,
          policyPending: null,
          policyForceFull: false,
        }
      : null;
  }
  start() {
    this.w.run("UPDATE machines SET connected=0,active_credential_id=NULL");
    this.w.run("UPDATE session_runtimes SET connected=0");
    this.w.run(
      "UPDATE session_requests SET state='stale',revision=revision+1 WHERE state='pending'",
    );
    this.w.run(
      "UPDATE session_commands SET state='failed',result=? WHERE kind='reply' AND state='queued'",
      canonical({ code: "private_state_lost" }),
    );
    this.w.run(
      "UPDATE session_commands SET state='unknown',updated_at=? WHERE state='sent'",
      this.w.now(),
    );
    this.w.run(
      "UPDATE artifact_notifications SET state='unknown',error='Connection was lost before acknowledgment' WHERE state='sending' AND command_id IS NULL",
    );
    this.timer = setInterval(() => this.wake(), 1000);
  }
  private valid(socket: Socket) {
    return !!this.w.one(
      "SELECT 1 FROM tower_credentials c WHERE id=? AND machine_id=? AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM tower_enrollments e WHERE e.credential_id=c.id AND e.state!='confirmed' AND e.expires_at<=?)",
      socket.data.credentialId,
      socket.data.machineId,
      this.w.now(),
    );
  }
  open(socket: Socket) {
    const old = this.sockets.get(socket.data.machineId);
    if (old) {
      this.close(old);
      old.close(4001, "Replaced by a new connection");
    }
    this.sockets.set(socket.data.machineId, socket);
  }
  close(socket: Socket) {
    if (this.sockets.get(socket.data.machineId) !== socket) return;
    this.sockets.delete(socket.data.machineId);
    this.w.executions.managed.disconnected(socket.data.machineId);
    this.w.db
      .transaction(() => {
        this.w.run(
          "UPDATE machines SET connected=0,active_credential_id=NULL WHERE id=?",
          socket.data.machineId,
        );
        this.w.run(
          "UPDATE artifact_notifications SET state='unknown',error='Connection was lost before acknowledgment' WHERE machine_id=? AND state='sending' AND command_id IS NULL",
          socket.data.machineId,
        );
        this.w.run(
          "UPDATE session_runtimes SET connected=0 WHERE machine_id=?",
          socket.data.machineId,
        );
        this.w.run(
          "UPDATE session_commands SET state='unknown',updated_at=? WHERE state='sent' AND runtime_id IN (SELECT id FROM session_runtimes WHERE machine_id=?)",
          this.w.now(),
          socket.data.machineId,
        );
      })
      .immediate();
    this.w.onChange();
  }
  private send(socket: Socket, message: unknown) {
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > 1024 * 1024) {
      socket.close(4009, "frame_too_large");
      return 0;
    }
    return socket.send(body);
  }
  message(socket: Socket, data: string | Buffer) {
    let message: Record<string, unknown> | undefined;
    try {
      if (this.sockets.get(socket.data.machineId) !== socket) {
        socket.close(4001, "Superseded connection");
        return;
      }
      if (!this.valid(socket)) {
        socket.close(4003, "Machine access revoked");
        return;
      }
      if (Buffer.byteLength(data) > 1024 * 1024)
        throw new AppError("frame_too_large", "Tower frames must fit within 1 MiB");
      message = JSON.parse(data.toString());
      if (!message || message.jsonrpc !== "2.0")
        throw new AppError("invalid_rpc", "Expected JSON-RPC 2.0");
      if (!socket.data.hello) {
        if (message.method !== "hello" || message.id === undefined)
          throw new AppError("hello_required", "Send hello first");
        this.hello(socket, message);
        return;
      }
      if (this.catalog.handle(socket, message)) return;
      if (message.method === "state.push") {
        this.state(socket, message.params);
        return;
      }
      if (message.method === "state.delta") {
        this.delta(socket, message.params);
        return;
      }
      if (message.method === "policy.resync") {
        socket.data.policyPending = null;
        socket.data.policyRules = null;
        socket.data.policyForceFull = true;
        this.wake();
        if (message.id !== undefined)
          this.send(socket, { jsonrpc: "2.0", id: message.id, result: { requested: true } });
        return;
      }
      if (message.method === "session.events") {
        this.requireSessionProtocol(socket);
        this.events(socket, message);
        return;
      }
      if (
        ["session.cursor", "runtime.lost", "session.request", "command.receipt"].includes(
          String(message.method),
        )
      ) {
        this.requireSessionProtocol(socket);
        if (
          message.method === "session.request" &&
          (message.params as { state?: unknown })?.state === "pending" &&
          !socket.data.scopes.includes("acp:control")
        )
          throw new AppError(
            "control_scope_required",
            "Machine enrollment did not grant acp:control",
            403,
          );
        const managed = this.w.executions.managed;
        const result =
          message.method === "session.cursor"
            ? managed.cursor(socket.data.machineId, message.params)
            : message.method === "runtime.lost"
              ? managed.loss(socket.data.machineId, message.params)
              : message.method === "session.request"
                ? managed.receiveRequest(socket.data.machineId, message.params)
                : managed.receipt(socket.data.machineId, message.params);
        this.send(socket, {
          jsonrpc: "2.0",
          ...(message.id !== undefined
            ? { id: message.id, result }
            : { method: `${message.method}.ack`, params: result }),
        });
        if (message.method === "command.receipt") {
          const commandId = (message.params as { command_id: string }).command_id;
          socket.data.receipts.set(commandId, Date.now());
        }
        if (message.method !== "session.cursor") {
          this.w.onChange();
          this.wake();
        }
        return;
      }
      if (message.method === "policy.ack") {
        this.policyReport(socket, message.params);
        return;
      }
      if (message.id !== undefined && ("result" in message || "error" in message)) {
        this.result(socket, message);
        return;
      }
      throw new AppError("unknown_method", "Unsupported Tower method");
    } catch (e) {
      if (message?.id !== undefined)
        this.send(socket, {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32602,
            message: e instanceof AppError ? e.message : "Invalid Tower frame",
            data: { code: e instanceof AppError ? e.code : "invalid_frame" },
          },
        });
      else socket.close(4002, e instanceof AppError ? e.code : "invalid_frame");
    }
  }
  private requireSessionProtocol(socket: Socket) {
    if (!this.w.managedSessions || !hasSessionProtocol(socket.data.capabilities))
      throw new AppError(
        "unsupported_capability",
        "Managed control capabilities have not been negotiated",
        409,
      );
  }
  private hello(socket: Socket, message: Record<string, unknown>) {
    const params = message.params as { protocol_version?: { major?: unknown } } | undefined;
    if (params?.protocol_version?.major !== 1)
      throw new AppError("protocol_incompatible", "Tower and Allgather must use protocol major 1");
    const h = helloSchema.parse(message.params),
      m = this.w.executions.machine(socket.data.machineId);
    if (m.host_id && m.host_id !== h.host_id)
      throw new AppError("host_conflict", "This credential belongs to another Tower host");
    if (!["policy-sync.v1", "session-status.v1"].every((c) => h.capabilities.includes(c)))
      throw new AppError(
        "protocol_incompatible",
        "Tower must support policy-sync.v1 and session-status.v1",
      );
    const other = this.w.one<{ id: string }>(
      "SELECT id FROM machines WHERE host_id=? AND id!=?",
      h.host_id,
      m.id,
    );
    if (other) throw new AppError("host_conflict", "This Tower host is already enrolled");
    this.w.run(
      "UPDATE machines SET host_id=?,capabilities=?,harnesses=?,harness_controls=?,terminal_controls=?,active_credential_id=?,tower_version=?,connected=1,last_seen_at=? WHERE id=?",
      h.host_id,
      JSON.stringify(h.capabilities),
      JSON.stringify(h.acp_harnesses),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(h.harness_controls).filter(([name]) => h.acp_harnesses.includes(name)),
        ),
      ),
      JSON.stringify(h.terminal_controls),
      socket.data.credentialId,
      h.tower_version,
      this.w.now(),
      m.id,
    );
    this.w.run("DELETE FROM machine_policy_reports WHERE machine_id=?", m.id);
    socket.data.reportedPolicyRevision = h.policy_revision ?? null;
    socket.data.hello = true;
    socket.data.capabilities = h.capabilities;
    this.catalog.connected(socket);
    this.send(socket, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocol_version: { major: 1, minor: 4 },
        node_name: m.id,
        capabilities: [
          "policy-sync.v1",
          "session-status.v1",
          "session-status-delta.v1",
          "policy-delta.v1",
          ...(this.w.managedSessions
            ? [...new Set([...managedCapabilities, ...terminalCapabilities])]
            : []),
          ...catalogCapabilities,
        ],
      },
    });
    this.wake();
    if (h.capabilities.includes("session-status.v1"))
      this.send(socket, {
        jsonrpc: "2.0",
        id: `resync:${socket.data.connectionId}`,
        method: "sync.resync",
        params: {},
      });
    this.w.onChange();
  }
  private state(socket: Socket, params: unknown) {
    const parsed = z
        .object({
          seq: z.number().int().nonnegative(),
          full: z.literal(true),
          records: z.array(value).max(5000),
        })
        .passthrough()
        .parse(params),
      rejected: { id: string; reason: string }[] = [];
    const ids = new Set<string>();
    for (const r of parsed.records) {
      if (typeof r.id !== "string" || Buffer.byteLength(r.id) > 160)
        throw new AppError(
          "invalid_record_id",
          "Status record IDs must be strings of at most 160 bytes",
        );
      if (ids.has(r.id))
        throw new AppError("duplicate_record_id", "A full snapshot cannot repeat a record ID");
      ids.add(r.id);
    }
    const fingerprint = digest(canonical({ full: parsed.full, records: parsed.records }));
    if (parsed.seq <= socket.data.statusSequence) {
      if (parsed.seq === socket.data.statusSequence && fingerprint !== socket.data.statusHash)
        throw new AppError(
          "status_sequence_conflict",
          "A status sequence cannot identify a different snapshot",
        );
      this.send(socket, {
        jsonrpc: "2.0",
        method: "sync.ack",
        params: { cursor: socket.data.statusSequence, rejected: socket.data.statusRejections },
      });
      return;
    }
    this.w.db
      .transaction(() => {
        this.w.run("DELETE FROM tower_records WHERE machine_id=?", socket.data.machineId);
        for (const record of parsed.records) {
          const id = text.safeParse(record.id);
          if (!id.success) {
            rejected.push({ id: String(record.id).slice(0, 160), reason: "invalid_id" });
            continue;
          }
          const allowed = ["id", ...publicRecordFieldsFor(socket.data.capabilities)];
          if (
            allowed.includes("checkout_id") &&
            record.checkout_id !== undefined &&
            !statusCheckoutIdSchema.safeParse(record.checkout_id).success
          ) {
            rejected.push({ id: id.data, reason: "invalid_checkout_id" });
            continue;
          }
          const projection = Object.fromEntries(
            allowed.filter((k) => record[k] !== undefined).map((k) => [k, record[k]]),
          );
          this.w.run(
            "INSERT INTO tower_records VALUES(?,?,?,?)",
            socket.data.machineId,
            id.data,
            JSON.stringify(projection),
            this.w.now(),
          );
          this.w.sessions.observe(socket.data.machineId, id.data, projection);
        }
        this.w.run(
          "UPDATE machines SET last_seen_at=? WHERE id=?",
          this.w.now(),
          socket.data.machineId,
        );
      })
      .immediate();
    socket.data.statusSequence = parsed.seq;
    socket.data.statusHash = fingerprint;
    socket.data.statusRejections = rejected;
    socket.data.statusNeedsFull = false;
    this.send(socket, {
      jsonrpc: "2.0",
      method: "sync.ack",
      params: { cursor: parsed.seq, rejected },
    });
    this.w.onChange();
  }
  private delta(socket: Socket, input: unknown) {
    if (!socket.data.capabilities.includes("session-status-delta.v1"))
      throw new AppError("unsupported_capability", "Negotiate session-status-delta.v1 first");
    const parsed = stateDeltaSchemaFor(socket.data.capabilities).safeParse(input);
    const resync = () => {
      socket.data.statusNeedsFull = true;
      this.send(socket, {
        jsonrpc: "2.0",
        id: `resync:${socket.data.connectionId}:${Date.now()}`,
        method: "sync.resync",
        params: {},
      });
    };
    if (!parsed.success) {
      resync();
      return;
    }
    const d = parsed.data,
      fingerprint = digest(canonical({ delta: d }));
    if (
      !socket.data.statusNeedsFull &&
      d.seq === socket.data.statusSequence &&
      fingerprint === socket.data.statusHash
    ) {
      this.send(socket, {
        jsonrpc: "2.0",
        method: "sync.ack",
        params: { cursor: d.seq, rejected: socket.data.statusRejections },
      });
      return;
    }
    if (
      socket.data.statusNeedsFull ||
      d.base_seq !== socket.data.statusSequence ||
      d.seq <= socket.data.statusSequence
    ) {
      resync();
      return;
    }
    const records = new Map(
      this.w
        .all<{ tower_id: string; record: string }>(
          "SELECT tower_id,record FROM tower_records WHERE machine_id=?",
          socket.data.machineId,
        )
        .map((r) => [r.tower_id, JSON.parse(r.record) as Record<string, unknown>]),
    );
    for (const id of d.removed) records.delete(id);
    for (const u of d.upserts) {
      const record = { ...(records.get(u.id) ?? { id: u.id }), ...u.set };
      for (const k of u.unset) delete record[k];
      records.set(u.id, record);
    }
    if (
      records.size > 5000 ||
      Buffer.byteLength(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "state.push",
          params: { seq: d.seq, full: true, records: [...records.values()] },
        }),
      ) >
        1024 * 1024
    ) {
      resync();
      return;
    }
    this.w.db
      .transaction(() => {
        for (const id of d.removed)
          this.w.run(
            "DELETE FROM tower_records WHERE machine_id=? AND tower_id=?",
            socket.data.machineId,
            id,
          );
        for (const u of d.upserts) {
          this.w.run(
            "INSERT INTO tower_records VALUES(?,?,?,?) ON CONFLICT(machine_id,tower_id) DO UPDATE SET record=excluded.record,observed_at=excluded.observed_at",
            socket.data.machineId,
            u.id,
            JSON.stringify(records.get(u.id)),
            this.w.now(),
          );
          this.w.sessions.observe(socket.data.machineId, u.id, records.get(u.id)!);
        }
        this.w.run(
          "UPDATE machines SET last_seen_at=? WHERE id=?",
          this.w.now(),
          socket.data.machineId,
        );
      })
      .immediate();
    socket.data.statusSequence = d.seq;
    socket.data.statusHash = fingerprint;
    socket.data.statusRejections = [];
    this.send(socket, {
      jsonrpc: "2.0",
      method: "sync.ack",
      params: { cursor: d.seq, rejected: [] },
    });
    this.w.onChange();
  }
  private events(socket: Socket, message: Record<string, unknown>) {
    const batch = eventBatch.parse(message.params);
    const result = this.w.db
      .transaction(() => {
        const runtime = this.w.executions.managed.owned(
          socket.data.machineId,
          batch.runtime_id,
          batch.generation,
        );
        if (batch.source_key !== runtime.generation)
          throw new AppError(
            "source_conflict",
            "Live source_key must equal the runtime generation",
            409,
          );
        const sourceId = this.w.executions.source(
            runtime.session_id,
            runtime.id,
            liveSourceKind(runtime.protocol),
            batch.source_key,
            runtime.protocol === "terminal" ? "terminal.v1" : "tower-session.v1",
            runtime.protocol === "terminal" ? "partial" : "unknown",
          ),
          source = this.w.one<{ cursor: number }>(
            "SELECT cursor FROM transcript_sources WHERE id=?",
            sourceId,
          )!;
        const previousNativeId = runtime.native_session_id;
        let cursor = source.cursor;
        let boundControls = runtime.controls;
        let ready = false;
        const keys = new Set<string>();
        for (const event of batch.events) {
          if (
            runtime.protocol === "terminal" &&
            (event.kind !== "runtime_state" ||
              !terminalStateSchema.safeParse(event.payload).success)
          )
            throw new AppError(
              "invalid_terminal_event",
              "Terminal streams contain only bounded lifecycle metadata",
              400,
            );
          if (
            event.sequence > source.cursor &&
            event.kind === "runtime_state" &&
            event.payload.controls !== undefined
          ) {
            const controls = sessionControlSchema.safeParse(event.payload.controls);
            if (!controls.success || !narrowsControls(boundControls, controls.data))
              throw new AppError(
                "control_conflict",
                "A runtime can only narrow its negotiated controls",
                409,
              );
            boundControls = controls.data;
          }
          if (event.kind === "gap" && !gapPayloadSchema.safeParse(event.payload).success)
            throw new AppError(
              "invalid_gap",
              "A gap describes only dropped unsequenced native output and its known coverage",
            );
          if (event.kind === "runtime_state") {
            const p = event.payload;
            for (const field of [
              "tower_session_id",
              "acp_session_id",
              "native_session_id",
              "owner_id",
            ] as const) {
              if (p[field] === undefined) continue;
              const identity = text.safeParse(p[field]);
              if (!identity.success || (runtime[field] && runtime[field] !== identity.data))
                throw new AppError(
                  "runtime_identity_conflict",
                  "Runtime identity cannot change or be empty",
                  409,
                );
              // Bind against earlier events in this batch as well as persisted identity.
              runtime[field] = identity.data;
            }
            if (
              event.sequence > source.cursor &&
              ["idle", "running", "waiting"].includes(String(p.state))
            ) {
              if (
                !runtime.owner_id ||
                !runtime.tower_session_id ||
                !(runtime.protocol === "terminal"
                  ? runtime.tower_session_id
                  : runtime.protocol === "codex-app-server"
                    ? runtime.native_session_id
                    : runtime.acp_session_id)
              )
                throw new AppError(
                  "runtime_not_ready",
                  "Ready state requires durable owner and backend execution identities",
                );
              if (
                !runtime.fenced &&
                !["ended", "error"].includes(runtime.state) &&
                this.w.executions.physicalRuntime(runtime.session_id)?.id === runtime.id &&
                !this.w.executions.replacementClean(runtime)
              )
                throw new AppError(
                  "cleanup_unconfirmed",
                  "Previous execution cleanup must be confirmed before replacement readiness",
                  409,
                );
              ready = true;
            }
          }
          if (event.sequence <= source.cursor) {
            const existing = this.w.one<{ source_event_key: string }>(
              "SELECT source_event_key FROM session_events WHERE source_id=? AND source_sequence=?",
              sourceId,
              event.sequence,
            );
            if (existing?.source_event_key !== event.key)
              throw new AppError(
                "sequence_conflict",
                "Replay event identity does not match its sequence",
                409,
              );
          } else {
            if (
              keys.has(event.key) ||
              this.w.one(
                "SELECT 1 FROM session_events WHERE source_id=? AND source_event_key=?",
                sourceId,
                event.key,
              )
            )
              throw new AppError(
                "event_conflict",
                "An event key cannot be reused at a new sequence",
                409,
              );
            keys.add(event.key);
            if (event.sequence !== cursor + 1)
              throw new AppError(
                "sequence_gap",
                "Reconcile the committed cursor. Never replace assigned events with gap records.",
                409,
              );
            cursor = event.sequence;
          }
        }
        const appended = this.w.executions.append(
          sourceId,
          batch.events.map((e) => ({ ...e, source_sequence: e.sequence })),
          true,
        );
        if (boundControls !== runtime.controls)
          this.w.run(
            "UPDATE session_runtimes SET controls=? WHERE id=?",
            canonical(boundControls),
            runtime.id,
          );
        // Replayed history and unrelated output cannot establish readiness after reconnect.
        // The terminal/fence guard also covers a ready event followed by termination in one batch.
        this.w.run(
          "UPDATE session_runtimes SET connected=CASE WHEN state IN ('ended','error') OR fenced=1 THEN 0 WHEN ? THEN 1 ELSE connected END,last_seen_at=?,tower_session_id=?,acp_session_id=?,native_session_id=?,owner_id=? WHERE id=?",
          Number(ready),
          this.w.now(),
          runtime.tower_session_id,
          runtime.acp_session_id,
          runtime.native_session_id,
          runtime.owner_id,
          runtime.id,
        );
        if (runtime.native_session_id && runtime.native_session_id !== previousNativeId) {
          const owner = this.w.one<{ agent_type: string }>(
            "SELECT agent_type FROM agent_sessions WHERE id=?",
            runtime.session_id,
          )!;
          this.w.recordSessionObservation(socket.data.machineId, () => ({
            session_id: this.w.sessions.identity.register(
              runtime.session_id,
              owner.agent_type,
              runtime.native_session_id!,
            ),
          }));
        }
        return {
          ...appended,
          cursor,
          runtime_id: runtime.id,
          generation: runtime.generation,
          source_key: batch.source_key,
        };
      })
      .immediate();
    this.send(socket, {
      jsonrpc: "2.0",
      ...(message.id !== undefined
        ? { id: message.id, result }
        : { method: "session.events.ack", params: result }),
    });
    this.wake();
    this.w.onChange();
  }
  private policyReport(socket: Socket, value: unknown, requestedRevision?: number) {
    const ack = towerPolicyAck.parse(value);
    this.w.run(
      "UPDATE machines SET last_seen_at=? WHERE id=?",
      this.w.now(),
      socket.data.machineId,
    );
    if (requestedRevision === undefined) {
      if (ack.outcome !== "applied" || ack.applied_revision !== socket.data.policyRevision) return;
      requestedRevision = socket.data.policyRevision;
    }
    if (requestedRevision < 1 || requestedRevision > socket.data.policyRevision) return;
    if (ack.outcome === "applied" && ack.applied_revision !== requestedRevision)
      throw new AppError(
        "invalid_policy_ack",
        "Applied policy revision does not match the request",
      );
    if (requestedRevision >= socket.data.policyCompleted)
      socket.data.reportedPolicyRevision = ack.applied_revision;
    socket.data.policyCompleted = Math.max(socket.data.policyCompleted, requestedRevision);
    const pending = socket.data.policyPending;
    if (pending?.revision === requestedRevision) {
      if (ack.outcome === "applied") socket.data.policyRules = pending.rules;
      else if (pending.method === "policy.delta") {
        socket.data.policyRules = null;
        socket.data.policyForceFull = true;
      }
      socket.data.policyPending = null;
    }
    this.w.run(
      "INSERT INTO machine_policy_reports VALUES(?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET requested_revision=excluded.requested_revision,observed_at=excluded.observed_at,body=excluded.body WHERE excluded.requested_revision>=machine_policy_reports.requested_revision",
      socket.data.machineId,
      requestedRevision,
      this.w.now(),
      canonical(ack),
    );
    this.w.onChange();
  }
  private result(socket: Socket, message: Record<string, unknown>) {
    const id = String(message.id);
    if (id.startsWith("policy:")) {
      const prefix = `policy:${socket.data.connectionId}:`;
      if (!id.startsWith(prefix)) return;
      if (socket.data.policyPending?.id !== id) return;
      const revision = socket.data.policyPending.revision;
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > socket.data.policyRevision)
        return;
      if (message.error) {
        const e = message.error as { data?: { code?: string } },
          revisionAtPeer = socket.data.reportedPolicyRevision;
        const ack: TowerPolicyAck = {
          policy_id: "tower",
          previous_revision: revisionAtPeer,
          applied_revision: revisionAtPeer,
          outcome: "rejected",
          changed_rule_ids: [],
          reason: typeof e.data?.code === "string" ? e.data.code.slice(0, 300) : "policy_rpc_error",
          received_at: Date.now(),
        };
        this.policyReport(socket, ack, revision);
      } else this.policyReport(socket, message.result, revision);
      return;
    }
    if (id.startsWith("notification-")) {
      const current = this.w.one<{ state: string; machine_id: string }>(
        "SELECT state,machine_id FROM artifact_notifications WHERE id=? AND command_id IS NULL",
        id,
      );
      if (
        !current ||
        current.machine_id !== socket.data.machineId ||
        !["sending", "unknown"].includes(current.state)
      )
        return;
      const result = message.result as Record<string, unknown> | undefined,
        error = message.error as { message?: string; data?: { code?: string } } | undefined;
      const state =
        result?.state === "delivered"
          ? "sent"
          : error?.data?.code === "delivery_unknown" || !error
            ? "unknown"
            : "failed";
      this.w.run(
        "UPDATE artifact_notifications SET state=?,receipt=?,error=?,updated_at=? WHERE id=?",
        state,
        JSON.stringify(result ?? error ?? null),
        error?.message ?? (state === "unknown" ? "Delivery acceptance is unknown" : null),
        this.w.now(),
        id,
      );
      this.w.onChange();
      return;
    }
    const statusQuery = id.startsWith("receipt:");
    const commandId = statusQuery ? id.slice(8) : id;
    const c = this.w.one<{ runtime_id: string; state: string }>(
      "SELECT runtime_id,state FROM session_commands WHERE id=?",
      commandId,
    );
    if (!c) return;
    this.requireSessionProtocol(socket);
    const runtime = this.w.one<SessionRuntime>(
      "SELECT * FROM session_runtimes WHERE id=?",
      c.runtime_id,
    )!;
    if (runtime.machine_id !== socket.data.machineId)
      throw new AppError("command_owner", "Command belongs to another machine");
    if (message.error) {
      // A transport error is not execution evidence. Never retain native free-form error text.
      if (c.state === "sent")
        this.w.run(
          "UPDATE session_commands SET state='unknown',updated_at=? WHERE id=?",
          this.w.now(),
          commandId,
        );
    } else {
      const response = message.result as Record<string, unknown> | undefined;
      if (response?.command_id !== commandId)
        throw new AppError(
          "command_conflict",
          "Receipt response identity differs from the requested command",
          409,
        );
      this.w.executions.managed.receipt(socket.data.machineId, response);
    }
    socket.data.receipts.set(commandId, Date.now());
    this.wake();
    this.w.onChange();
  }
  wake() {
    const cutoff = new Date(Date.parse(this.w.now()) - 30000).toISOString();
    const expired = this.w.run(
      "UPDATE session_commands SET state='unknown',updated_at=? WHERE state='sent' AND updated_at<?",
      this.w.now(),
      cutoff,
    );
    const notices = this.w.run(
      "UPDATE artifact_notifications SET state='unknown',error='Delivery acknowledgment timed out',updated_at=? WHERE state='sending' AND command_id IS NULL AND updated_at<?",
      this.w.now(),
      cutoff,
    );
    const notificationChanges = this.w.artifacts?.notifications.refresh();
    if (expired.changes || notices.changes || notificationChanges) this.w.onChange();
    for (const socket of this.sockets.values()) {
      if (!this.valid(socket)) {
        socket.close(4003, "Machine access revoked");
        continue;
      }
      if (!socket.data.hello) {
        if (Date.now() - socket.data.openedAt > 10000) socket.close(4002, "Handshake timeout");
        continue;
      }
      const machine = this.w.executions.machine(socket.data.machineId);
      this.catalog.wake(socket);
      if (
        !socket.data.policyPending &&
        (machine.policy_revision !== socket.data.policyRevision || socket.data.policyForceFull)
      ) {
        const full = {
          policy_id: "tower",
          revision: machine.policy_revision,
          rules: machine.policy,
        };
        let method = "policy.push",
          params: unknown = full;
        const before = socket.data.policyRules;
        if (
          !socket.data.policyForceFull &&
          before &&
          socket.data.reportedPolicyRevision !== null &&
          socket.data.capabilities.includes("policy-delta.v1")
        ) {
          const old = new Map(before.map((r) => [r.id, canonical(r)])),
            ids = new Set(machine.policy.map((r) => r.id));
          const delta = {
            policy_id: "tower",
            base_revision: socket.data.reportedPolicyRevision,
            revision: machine.policy_revision,
            upserts: machine.policy.filter((r) => old.get(r.id) !== canonical(r)),
            removed: before.filter((r) => !ids.has(r.id)).map((r) => r.id),
            order: machine.policy.map((r) => r.id),
          };
          if (Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(full))) {
            method = "policy.delta";
            params = delta;
          }
        }
        socket.data.policyPending = {
          id: `policy:${socket.data.connectionId}:${machine.policy_revision}:${uid("attempt")}`,
          revision: machine.policy_revision,
          rules: machine.policy,
          method,
          params,
        };
        socket.data.policyForceFull = false;
        socket.data.policySentAt = 0;
      }
      const pending = socket.data.policyPending;
      if (
        pending &&
        (!socket.data.policySentAt || Date.now() - socket.data.policySentAt >= 30000)
      ) {
        this.send(socket, {
          jsonrpc: "2.0",
          id: pending.id,
          method: pending.method,
          params: pending.params,
        });
        socket.data.policyRevision = pending.revision;
        socket.data.policySentAt = Date.now();
      }
      for (const notification of this.w.all<{
        id: string;
        session_id: string;
        registration_id: string;
        event: string;
      }>(
        "SELECT id,session_id,registration_id,event FROM artifact_notifications WHERE state='queued' AND command_id IS NULL AND route='message' ORDER BY created_at,id LIMIT 32",
      )) {
        const record = this.w.artifacts?.workers.get(notification.registration_id);
        if (
          !record ||
          !this.w.artifacts?.notifications.authorized(
            record.principal,
            record.subscription.artifactId,
            record.subscription.listenerId,
          )
        ) {
          this.w.run(
            "UPDATE artifact_notifications SET state='failed',error='Notification authorization expired' WHERE id=?",
            notification.id,
          );
          continue;
        }
        if (notification.event === "submitted" && record.state === "retired") {
          this.w.run(
            "UPDATE artifact_notifications SET state='failed',error='Subscription retired' WHERE id=?",
            notification.id,
          );
          continue;
        }
        const target = this.w.artifacts.notifications.target(notification.session_id);
        if (!target || target.machine_id !== machine.id) continue;
        if (target.kind !== "message") {
          this.w.run(
            "UPDATE artifact_notifications SET state='failed',error='This destination requires a tracked managed prompt' WHERE id=?",
            notification.id,
          );
          continue;
        }
        if (!socket.data.scopes.includes("send")) {
          this.w.run(
            "UPDATE artifact_notifications SET state='failed',error='Machine enrollment does not grant send' WHERE id=?",
            notification.id,
          );
          continue;
        }
        const body = this.w.one<{ body: string }>(
          "SELECT body FROM artifact_notifications WHERE id=?",
          notification.id,
        )!.body;
        this.w.run(
          "UPDATE artifact_notifications SET state='sending',machine_id=?,tower_id=?,updated_at=? WHERE id=? AND state='queued'",
          machine.id,
          target.tower_id,
          this.w.now(),
          notification.id,
        );
        const sent = this.send(socket, {
          jsonrpc: "2.0",
          id: notification.id,
          method: "message.send",
          params: { to: target.tower_id, body, from_label: "Allgather" },
        });
        if (sent === 0)
          this.w.run(
            "UPDATE artifact_notifications SET state='unknown',error='Delivery acceptance is unknown' WHERE id=?",
            notification.id,
          );
      }
      if (!this.w.managedSessions || !hasSessionProtocol(machine.capabilities)) continue;
      for (const row of this.w.all<{ id: string; runtime_id: string; generation: string }>(
        "SELECT c.id,c.runtime_id,r.generation FROM session_commands c JOIN session_runtimes r ON r.id=c.runtime_id WHERE r.machine_id=? AND (c.state IN ('sent','unknown') OR (c.state='acknowledged' AND json_extract(c.result,'$.dispatch.state')!='finished')) ORDER BY c.updated_at LIMIT 128",
        machine.id,
      )) {
        const last = socket.data.receipts.get(row.id);
        if (last !== undefined && Date.now() - last < 30000) continue;
        socket.data.receipts.set(row.id, Date.now());
        this.send(socket, {
          jsonrpc: "2.0",
          id: `receipt:${row.id}`,
          method: "command.status",
          params: { command_id: row.id, runtime_id: row.runtime_id, generation: row.generation },
        });
      }
      if (!socket.data.scopes.includes("acp:control"))
        this.w.artifacts?.notifications.rejectConsent(machine.id);
      const rows = this.w.all<{ id: string }>(
        "SELECT c.id FROM session_commands c JOIN session_runtimes r ON r.id=c.runtime_id WHERE r.machine_id=? AND c.state='queued' ORDER BY CASE c.kind WHEN 'reply' THEN 0 WHEN 'cancel' THEN 0 ELSE 1 END,c.created_at,c.rowid LIMIT 32",
        machine.id,
      );
      for (const row of rows) {
        const command = this.w.executions.command(row.id),
          runtime = this.w.executions.physicalRuntime(command.session_id);
        if (
          !runtime ||
          runtime.id !== command.runtime_id ||
          runtime.fenced ||
          ["ended", "error"].includes(runtime.state)
        )
          continue;
        if (!socket.data.scopes.includes(executionScope(runtime.protocol))) continue;
        const expires = this.w.executions.managed.authority(command.id);
        const notificationError = this.w.artifacts?.notifications.dispatchError(command);
        if (notificationError) {
          this.w.artifacts!.notifications.failQueued(command.id, notificationError);
          continue;
        }
        const replacementError = this.w.executions.replacementError(command, runtime);
        if (replacementError) {
          this.w.run(
            "UPDATE session_commands SET state='failed',result=?,updated_at=? WHERE id=?",
            canonical({ code: replacementError, stage: "dispatch", may_have_effect: false }),
            this.w.now(),
            command.id,
          );
          this.w.run(
            "UPDATE session_runtimes SET state='error',termination='confirmed',connected=0 WHERE id=? AND state='starting'",
            runtime.id,
          );
          continue;
        }
        if (!this.w.executions.commandSupported(runtime, command.kind, command.payload)) {
          this.w.run(
            "UPDATE session_commands SET state='failed',result=?,updated_at=? WHERE id=?",
            canonical({ code: "unsupported_control" }),
            this.w.now(),
            command.id,
          );
          if (["launch", "resume"].includes(command.kind))
            this.w.run(
              "UPDATE session_runtimes SET state='error',termination='confirmed',connected=0 WHERE id=? AND state='starting'",
              runtime.id,
            );
          continue;
        }
        const payload =
          command.kind === "reply" ? this.w.executions.managed.reply(command.id) : command.payload;
        const response = payload?.response as
          | { action?: string; outcome?: { outcome?: string } }
          | undefined;
        const cleanup =
          command.kind === "cancel" ||
          (command.kind === "reply" &&
            (response?.outcome?.outcome === "cancelled" ||
              ["decline", "cancel"].includes(response?.action ?? "")));
        if (!expires || !payload) {
          this.w.run(
            "UPDATE session_commands SET state='failed',result=?,updated_at=? WHERE id=?",
            canonical({ code: !expires ? "authority_expired" : "private_state_lost" }),
            this.w.now(),
            command.id,
          );
          if (["launch", "resume"].includes(command.kind))
            this.w.run(
              "UPDATE session_runtimes SET state='error',termination='confirmed',connected=0 WHERE id=? AND state='starting'",
              runtime.id,
            );
          continue;
        }
        if (
          !cleanup &&
          (machine.policy_status !== "applied" ||
            socket.data.reportedPolicyRevision !== machine.policy_revision)
        )
          continue;
        if (!cleanup && !["launch", "resume"].includes(command.kind) && !runtime.connected)
          continue;
        if (command.kind === "prompt" && (runtime.active_prompt_id || runtime.state !== "idle"))
          continue;
        this.w.run(
          "UPDATE session_commands SET state='sent',updated_at=? WHERE id=? AND state='queued'",
          this.w.now(),
          command.id,
        );
        if (command.kind === "prompt")
          this.w.run(
            "UPDATE session_runtimes SET active_prompt_id=? WHERE id=?",
            command.id,
            runtime.id,
          );
        socket.data.receipts.set(command.id, Date.now());
        const sent = this.send(socket, {
          jsonrpc: "2.0",
          id: command.id,
          method: "command.execute",
          params: {
            command_id: command.id,
            session_id: command.session_id,
            runtime_id: runtime.id,
            generation: runtime.generation,
            kind: command.kind,
            payload,
            expires_at: expires,
          },
        });
        this.w.executions.managed.releaseReply(command.id);
        if (sent === 0)
          this.w.run(
            "UPDATE session_commands SET state='unknown' WHERE id=? AND state='sent'",
            command.id,
          );
      }
    }
    if (this.w.artifacts?.notifications.refresh()) this.w.onChange();
  }
  stop() {
    clearInterval(this.timer);
    for (const socket of this.sockets.values()) socket.close(1001, "Server stopping");
  }
}
