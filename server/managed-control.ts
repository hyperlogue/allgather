import type { z } from "zod";
import { AppError, type Principal, type SessionRuntime } from "../shared/contracts.ts";
import { effectiveScopes } from "../shared/permissions.ts";
import { resourceGrantsSchema } from "../shared/resource-grants.ts";
import {
  type CommandReceipt,
  cursorSchema,
  liveSourceKind,
  lossSchema,
  receiptSchema,
  requestSchema,
} from "../shared/tower-acp.ts";
import { activeBrowserSession } from "./browser-auth.ts";
import { canonical, uid, type Workspace } from "./workspace.ts";

type Input = Record<string, unknown>;
const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
  const p = schema.safeParse(value);
  if (!p.success) throw new AppError("invalid_control", "Invalid managed control envelope");
  return p.data;
};

/** Durable protocol evidence, with private request/reply bodies confined to live memory. */
export class ManagedControl {
  private requests = new Map<string, { payload: Input; sourceRevision: number }>();
  private replies = new Map<string, Input>();
  constructor(private w: Workspace) {}
  owned(machine: string, runtimeId: string, generation: string) {
    const r = this.w.one<SessionRuntime>(
      "SELECT * FROM session_runtimes WHERE id=? AND machine_id=? AND generation=?",
      runtimeId,
      machine,
      generation,
    );
    if (!r)
      throw new AppError("runtime_conflict", "Runtime identity is not owned by this machine", 409);
    r.controls = r.controls ? JSON.parse(r.controls as unknown as string) : null;
    return r;
  }
  cursor(machine: string, input: unknown) {
    const a = parse(cursorSchema, input),
      r = this.owned(machine, a.runtime_id, a.generation);
    if (a.source_key !== r.generation)
      throw new AppError("source_conflict", "Source key must equal generation", 409);
    const source = this.w.one<{ id: string; cursor: number; coverage: string }>(
      "SELECT id,cursor,coverage FROM transcript_sources WHERE runtime_id=? AND source_key=? AND kind=?",
      r.id,
      r.generation,
      liveSourceKind(r.protocol),
    );
    const last = source
      ? this.w.one<{ source_event_key: string }>(
          "SELECT source_event_key FROM session_events WHERE source_id=? AND source_sequence=?",
          source.id,
          source.cursor,
        )
      : null;
    return {
      ...a,
      source_id: source?.id ?? null,
      cursor: source?.cursor ?? 0,
      last_event_key: last?.source_event_key ?? null,
      coverage: source?.coverage ?? "unknown",
    };
  }
  loss(machine: string, input: unknown) {
    const a = parse(lossSchema, input);
    return this.w.db
      .transaction(() => {
        const r = this.owned(machine, a.runtime_id, a.generation),
          body = canonical(a);
        if (r.owner_id && r.owner_id !== a.owner_id)
          throw new AppError("owner_conflict", "The durable execution owner cannot change", 409);
        const previous = this.w.one<{ body: string }>(
          "SELECT body FROM runtime_losses WHERE runtime_id=? AND revision=?",
          r.id,
          a.report_revision,
        );
        if (previous) {
          if (previous.body !== body)
            throw new AppError("loss_conflict", "Loss report revision has different content", 409);
        } else {
          const last = this.w.one<{ loss_id: string }>(
            "SELECT loss_id FROM runtime_losses WHERE runtime_id=? ORDER BY revision DESC LIMIT 1",
            r.id,
          );
          if (
            a.report_revision <= r.loss_revision ||
            (last && last.loss_id !== a.loss_id) ||
            (r.termination === "confirmed" && a.termination !== "confirmed")
          )
            throw new AppError(
              "loss_conflict",
              "Loss reports cannot change identity or undo confirmed termination",
              409,
            );
          this.w.run(
            "INSERT INTO runtime_losses VALUES(?,?,?,?)",
            r.id,
            a.loss_id,
            a.report_revision,
            body,
          );
          this.w.run(
            "UPDATE session_runtimes SET owner_id=COALESCE(owner_id,?),fenced=1,state='error',connected=0,termination=?,loss_revision=? WHERE id=?",
            a.owner_id,
            a.termination,
            a.report_revision,
            r.id,
          );
          this.invalidate(r.id);
          this.w.run(
            "UPDATE session_commands SET state=CASE WHEN state='queued' THEN 'failed' ELSE 'unknown' END,updated_at=? WHERE runtime_id=? AND state IN ('queued','sent')",
            this.w.now(),
            r.id,
          );
        }
        const latest = this.w.one<SessionRuntime>(
          "SELECT * FROM session_runtimes WHERE id=?",
          r.id,
        )!;
        return {
          runtime_id: r.id,
          generation: r.generation,
          loss_id: a.loss_id,
          report_revision: a.report_revision,
          applied_revision: latest.loss_revision,
          fenced: true,
          termination: latest.termination,
        };
      })
      .immediate();
  }
  receiveRequest(machine: string, input: unknown) {
    const a = parse(requestSchema, input);
    if (Buffer.byteLength(canonical(a.payload ?? null)) > 256 * 1024)
      throw new AppError("request_too_large", "Private controls are limited to 256 KiB", 413);
    return this.w.db
      .transaction(() => {
        const r = this.owned(machine, a.runtime_id, a.generation);
        if (r.protocol === "terminal")
          throw new AppError(
            "unsupported_control",
            "Terminal sessions do not expose private requests",
            409,
          );
        if (a.state !== "pending") return this.retireRequest(r, a);
        if (!a.payload)
          throw new AppError("invalid_control", "Pending requests require a private payload");
        const controls = this.w.executions.controls(r);
        if (
          this.w.executions.stopping(r) ||
          !controls?.capabilities.includes(
            a.kind === "permission" ? "permission_reply" : "elicitation_reply",
          )
        )
          throw new AppError(
            "unsupported_control",
            "This execution cannot accept that live request kind",
            409,
          );
        if (
          !r.owner_id ||
          r.owner_id !== a.owner_id ||
          r.fenced ||
          !r.active_prompt_id ||
          !r.connected ||
          ["ended", "error"].includes(r.state) ||
          this.w.executions.runtime(r.session_id)?.id !== r.id
        )
          throw new AppError("stale_request", "The private request has no live durable owner", 409);
        const fingerprint = this.w.executions.privateFingerprint({
          native_request_id: a.native_request_id,
          kind: a.kind,
          payload: a.payload,
        });
        let row = this.w.one<{
          id: string;
          state: string;
          revision: number;
          source_revision: number;
          fingerprint: string;
          owner_id: string;
          prompt_command_id: string;
          retired: number;
          native_id: string;
          kind: string;
          source_state: string;
        }>(
          "SELECT r.id,r.state,r.revision,r.kind,m.source_revision,m.fingerprint,m.owner_id,m.prompt_command_id,m.retired,m.native_id,m.source_state FROM session_requests r JOIN private_request_metadata m ON m.request_id=r.id WHERE r.runtime_id=? AND r.runtime_generation=? AND r.source_request_id=?",
          r.id,
          r.generation,
          a.source_request_id,
        );
        if (row) {
          if (
            row.fingerprint !== fingerprint ||
            row.owner_id !== a.owner_id ||
            row.native_id !== canonical(a.native_request_id) ||
            row.kind !== a.kind ||
            row.prompt_command_id !== r.active_prompt_id ||
            a.request_revision < row.source_revision
          )
            throw new AppError("request_conflict", "Request occurrence or revision conflicts", 409);
          if (row.retired || row.state === "answered" || row.state === "cancelled")
            return {
              request_id: row.id,
              source_request_id: a.source_request_id,
              request_revision: row.source_revision,
              state: row.state,
              revision: row.revision,
            };
          // A transient disconnect can be repaired only by the same surviving owner and occurrence.
          this.w.run(
            "UPDATE session_requests SET state=?,revision=revision+? WHERE id=?",
            a.state,
            Number(row.state !== a.state),
            row.id,
          );
          this.w.run(
            "UPDATE private_request_metadata SET source_revision=?,retired=?,source_state='pending' WHERE request_id=?",
            a.request_revision,
            Number(a.state !== "pending"),
            row.id,
          );
        } else {
          if (this.requests.size >= 256)
            throw new AppError(
              "control_capacity",
              "Live control capacity exhausted; cancel or fence this runtime",
              429,
            );
          const id = uid("request");
          this.w.run(
            "INSERT INTO session_requests(id,session_id,runtime_id,runtime_generation,source_request_id,kind,payload,state) VALUES(?,?,?,?,?,?,?,?)",
            id,
            r.session_id,
            r.id,
            r.generation,
            a.source_request_id,
            a.kind,
            canonical({ redacted: true, fingerprint }),
            a.state,
          );
          this.w.run(
            "INSERT INTO private_request_metadata(request_id,owner_id,source_revision,native_id,fingerprint,prompt_command_id,retired) VALUES(?,?,?,?,?,?,?)",
            id,
            a.owner_id,
            a.request_revision,
            canonical(a.native_request_id),
            fingerprint,
            r.active_prompt_id,
            Number(a.state !== "pending"),
          );
          row = {
            id,
            state: a.state,
            revision: 1,
            source_revision: a.request_revision,
            fingerprint,
            owner_id: a.owner_id,
            prompt_command_id: r.active_prompt_id,
            retired: Number(a.state !== "pending"),
            native_id: canonical(a.native_request_id),
            kind: a.kind,
            source_state: "pending",
          };
        }
        if (a.state === "pending") {
          // Cap reannouncements as well as first occurrences after reconnect.
          if (!this.requests.has(row.id) && this.requests.size >= 256)
            throw new AppError(
              "control_capacity",
              "Live control capacity exhausted; cancel or fence this runtime",
              429,
            );
          this.requests.set(row.id, { payload: a.payload, sourceRevision: a.request_revision });
          this.w.run("UPDATE session_runtimes SET state='waiting' WHERE id=?", r.id);
        } else this.requests.delete(row.id);
        const state = this.w.one<{ state: string; revision: number }>(
          "SELECT state,revision FROM session_requests WHERE id=?",
          row.id,
        )!;
        return {
          request_id: row.id,
          source_request_id: a.source_request_id,
          request_revision: a.request_revision,
          ...state,
        };
      })
      .immediate();
  }
  private retireRequest(r: SessionRuntime, a: z.infer<typeof requestSchema>) {
    if (!r.owner_id || r.owner_id !== a.owner_id)
      throw new AppError("owner_conflict", "Retirement must name the bound durable owner", 409);
    let row = this.w.one<{
      id: string;
      state: string;
      revision: number;
      owner_id: string;
      native_id: string;
      kind: string;
      source_revision: number;
      source_state: string;
    }>(
      "SELECT r.id,r.state,r.revision,r.kind,m.owner_id,m.native_id,m.source_revision,m.source_state FROM session_requests r JOIN private_request_metadata m ON m.request_id=r.id WHERE r.runtime_id=? AND r.runtime_generation=? AND r.source_request_id=?",
      r.id,
      r.generation,
      a.source_request_id,
    );
    if (
      row &&
      (row.owner_id !== a.owner_id ||
        row.kind !== a.kind ||
        row.native_id !== canonical(a.native_request_id))
    )
      throw new AppError("request_conflict", "Retirement occurrence identity conflicts", 409);
    if (row && a.request_revision <= row.source_revision) {
      if (a.request_revision === row.source_revision && a.state !== row.source_state)
        throw new AppError("request_conflict", "A request revision cannot change its state", 409);
      return {
        request_id: row.id,
        source_request_id: a.source_request_id,
        request_revision: a.request_revision,
        applied_request_revision: row.source_revision,
        state: row.state,
        revision: row.revision,
      };
    }
    if (row) {
      this.w.run(
        "UPDATE session_requests SET state=CASE WHEN state='answered' THEN state ELSE ? END,revision=revision+1 WHERE id=?",
        a.state,
        row.id,
      );
      this.w.run(
        "UPDATE private_request_metadata SET source_revision=?,source_state=?,retired=1 WHERE request_id=?",
        a.request_revision,
        a.state,
        row.id,
      );
    } else {
      const id = uid("request"),
        fingerprint = this.w.executions.privateFingerprint({
          runtime_id: r.id,
          generation: r.generation,
          source_request_id: a.source_request_id,
          retired: true,
        });
      this.w.run(
        "INSERT INTO session_requests(id,session_id,runtime_id,runtime_generation,source_request_id,kind,payload,state) VALUES(?,?,?,?,?,?,?,?)",
        id,
        r.session_id,
        r.id,
        r.generation,
        a.source_request_id,
        a.kind,
        canonical({ redacted: true, fingerprint }),
        a.state,
      );
      this.w.run(
        "INSERT INTO private_request_metadata VALUES(?,?,?,?,?,?,1,?)",
        id,
        a.owner_id,
        a.request_revision,
        canonical(a.native_request_id),
        fingerprint,
        r.active_prompt_id ?? "",
        a.state,
      );
      row = {
        id,
        state: a.state,
        revision: 1,
        owner_id: a.owner_id,
        native_id: canonical(a.native_request_id),
        kind: a.kind,
        source_revision: a.request_revision,
        source_state: a.state,
      };
    }
    this.requests.delete(row.id);
    const queued = this.w.all<{ id: string }>(
      "SELECT id FROM session_commands WHERE runtime_id=? AND kind='reply' AND state='queued' AND json_extract(payload,'$.request_id')=?",
      r.id,
      row.id,
    );
    for (const command of queued) {
      this.replies.delete(command.id);
      this.w.run(
        "UPDATE session_commands SET state='failed',result=?,updated_at=? WHERE id=?",
        canonical({ code: "request_retired" }),
        this.w.now(),
        command.id,
      );
    }
    const result = this.w.one<{ state: string; revision: number }>(
      "SELECT state,revision FROM session_requests WHERE id=?",
      row.id,
    )!;
    return {
      request_id: row.id,
      source_request_id: a.source_request_id,
      request_revision: a.request_revision,
      applied_request_revision: a.request_revision,
      ...result,
    };
  }
  request(id: string) {
    return this.requests.get(id);
  }
  holdReply(id: string, payload: Input) {
    this.replies.set(id, payload);
  }
  reply(id: string) {
    return this.replies.get(id);
  }
  releaseReply(id: string) {
    this.replies.delete(id);
  }
  invalidate(runtimeId: string, transient = false) {
    for (const row of this.w.all<{ id: string }>(
      "SELECT id FROM session_requests WHERE runtime_id=?",
      runtimeId,
    ))
      this.requests.delete(row.id);
    for (const row of this.w.all<{ id: string }>(
      "SELECT id FROM session_commands WHERE runtime_id=? AND kind='reply'",
      runtimeId,
    ))
      this.replies.delete(row.id);
    this.w.run(
      "UPDATE session_requests SET state='stale',revision=revision+1 WHERE runtime_id=? AND state='pending'",
      runtimeId,
    );
    if (!transient)
      this.w.run(
        "UPDATE private_request_metadata SET retired=1 WHERE request_id IN (SELECT id FROM session_requests WHERE runtime_id=?)",
        runtimeId,
      );
  }
  disconnected(machine: string) {
    for (const row of this.w.all<{ id: string }>(
      "SELECT id FROM session_runtimes WHERE machine_id=?",
      machine,
    ))
      this.invalidate(row.id, true);
    this.w.run(
      "UPDATE session_commands SET state='failed',result=?,updated_at=? WHERE kind='reply' AND state='queued' AND runtime_id IN (SELECT id FROM session_runtimes WHERE machine_id=?)",
      canonical({ code: "private_state_lost" }),
      this.w.now(),
      machine,
    );
  }
  receipt(machine: string, input: unknown) {
    const a = parse(receiptSchema, input),
      r = this.owned(machine, a.runtime_id, a.generation);
    const c = this.w.executions.command(a.command_id);
    if (
      r.protocol === "terminal" &&
      (a.result?.acp_session_id || a.acceptance?.level === "harness")
    )
      throw new AppError(
        "invalid_control",
        "Terminal receipts cannot claim ACP identity or harness acceptance",
        409,
      );
    if (c.runtime_id !== r.id || c.state === "queued")
      throw new AppError("command_conflict", "Receipt does not match a dispatched command", 409);
    for (const field of [
      "owner_id",
      "tower_session_id",
      "native_session_id",
      "acp_session_id",
    ] as const) {
      if (a.result?.[field] && r[field] && a.result[field] !== r[field])
        throw new AppError(
          "runtime_identity_conflict",
          "Receipt execution identity cannot change",
          409,
        );
    }
    if (a.state === "missing") return { command_id: a.command_id, receipt_revision: 0 };
    const fingerprint = this.w.executions.privateFingerprint(a);
    // Free-form error messages may contain native request/reply secrets. Keep bounded codes only.
    const safe: CommandReceipt = {
      ...a,
      ...(a.error
        ? { error: { ...a.error, message: "The adapter reported a command error." } }
        : {}),
    };
    return this.w.db
      .transaction(() => {
        const old = this.w.one<{ revision: number; body: string; fingerprint: string }>(
          "SELECT * FROM command_receipts WHERE command_id=?",
          a.command_id,
        );
        if (old && a.receipt_revision <= old.revision) {
          if (a.receipt_revision === old.revision && fingerprint !== old.fingerprint)
            throw new AppError("receipt_conflict", "Receipt revision was reused", 409);
          return { command_id: a.command_id, receipt_revision: old.revision };
        }
        const before: CommandReceipt | null = old ? JSON.parse(old.body) : null;
        if (
          before &&
          ((before.acceptance &&
            (!a.acceptance ||
              (before.acceptance.level === "harness" && a.acceptance.level !== "harness"))) ||
            (before.state === "failed" && a.state !== "failed") ||
            (before.dispatch.state === "finished" && a.dispatch.state !== "finished") ||
            (before.dispatch.transport_written && !a.dispatch.transport_written) ||
            (before.dispatch.state !== "not_started" && a.dispatch.state === "not_started"))
        )
          throw new AppError("receipt_regression", "Receipt evidence cannot be erased", 409);
        this.w.run(
          "INSERT INTO command_receipts VALUES(?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET revision=excluded.revision,body=excluded.body,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at",
          a.command_id,
          a.receipt_revision,
          canonical(safe),
          fingerprint,
          this.w.now(),
        );
        const state =
          a.state === "accepted"
            ? "acknowledged"
            : a.state === "failed"
              ? "failed"
              : a.state === "unknown"
                ? "unknown"
                : "sent";
        this.w.run(
          "UPDATE session_commands SET state=?,result=?,updated_at=? WHERE id=?",
          state,
          canonical(safe),
          this.w.now(),
          a.command_id,
        );
        // Receipt identity is useful evidence, but readiness is established only by a runtime event.
        if (
          !r.fenced &&
          !["ended", "error"].includes(r.state) &&
          this.w.executions.runtime(r.session_id)?.id === r.id &&
          a.state === "failed" &&
          a.error?.may_have_effect === false &&
          a.dispatch.state === "not_started"
        ) {
          if (c.kind === "launch" || c.kind === "resume")
            this.w.run(
              "UPDATE session_runtimes SET state='error',termination='confirmed',connected=0 WHERE id=?",
              r.id,
            );
          if (c.kind === "prompt")
            this.w.run(
              "UPDATE session_runtimes SET active_prompt_id=NULL WHERE id=? AND active_prompt_id=?",
              r.id,
              c.id,
            );
        }
        this.releaseReply(c.id);
        return { command_id: c.id, receipt_revision: a.receipt_revision };
      })
      .immediate();
  }
  rememberAuthority(commandId: string, principal: Principal) {
    const expires = new Date(Date.parse(this.w.now()) + 10 * 60000).toISOString();
    this.w.run(
      "INSERT INTO command_authority VALUES(?,?,?)",
      commandId,
      canonical(principal),
      expires,
    );
  }
  authority(commandId: string) {
    const row = this.w.one<{ principal: string; expires_at: string }>(
      "SELECT * FROM command_authority WHERE command_id=?",
      commandId,
    );
    if (!row || row.expires_at <= this.w.now()) return null;
    const p: Principal = JSON.parse(row.principal),
      binding = p.auth_binding;
    if (!binding) return null;
    if (binding.kind === "browser")
      return activeBrowserSession(this.w.db, binding.hash, this.w.now()) ? row.expires_at : null;
    if (binding.kind !== "oauth") return null;
    const command = this.w.one<{ kind: string }>(
      "SELECT kind FROM session_commands WHERE id=?",
      commandId,
    );
    const scope = command?.kind === "cancel" ? "sessions:stop" : `sessions:${command?.kind}`;
    const access = this.w.one<{
      scopes: string;
      granted_scopes: string;
      resources: string;
      permissions: string;
    }>(
      "SELECT t.scopes,g.scopes granted_scopes,g.resources,g.permissions FROM oauth_tokens t JOIN oauth_clients c ON c.id=t.client_id JOIN oauth_grants g ON g.id=t.grant_id AND g.client_id=t.client_id AND g.resource=t.resource WHERE t.hash=? AND t.client_id=? AND t.grant_id=? AND c.revoked=0 AND g.revoked=0 AND EXISTS(SELECT 1 FROM oauth_tokens live WHERE live.grant_id=t.grant_id AND live.revoked=0 AND (live.expires>? OR live.refresh_hash IS NOT NULL AND live.refresh_expires>?))",
      binding.hash,
      p.id,
      p.grant_id ?? "",
      this.w.now(),
      this.w.now(),
    );
    if (!access) return null;
    if (
      JSON.parse(access.permissions)[scope] === "approval" &&
      (!p.approval_id || !this.w.approvals.commandApproved(p.approval_id, commandId, p.grant_id!))
    )
      return null;
    const tokenScopes = JSON.parse(access.scopes) as string[],
      grantScopes = JSON.parse(access.granted_scopes) as string[];
    if (!effectiveScopes(tokenScopes, grantScopes).some((s) => s === scope || s === "admin"))
      return null;
    const resources = resourceGrantsSchema.safeParse(JSON.parse(access.resources));
    if (!resources.success) return null;
    const target = this.w.one<{ session_id: string }>(
      "SELECT session_id FROM session_commands WHERE id=?",
      commandId,
    );
    return target &&
      this.w.access.run({ ...p, resources: resources.data }, () =>
        this.w.access.session(target.session_id),
      )
      ? row.expires_at
      : null;
  }
}
