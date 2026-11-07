import { reviewableApproval } from "../shared/approval-content.ts";
import {
  AppError,
  can,
  type Operation,
  operations,
  type Principal,
  type Scope,
} from "../shared/contracts.ts";
import type { PermissionModes } from "../shared/permissions.ts";
import { resourceGrantsSchema } from "../shared/resource-grants.ts";
import { isBrowserOwner } from "./auth.ts";
import { canonical, digest, uid, type Workspace } from "./workspace.ts";

type Input = Record<string, unknown>;
interface Approval {
  id: string;
  client_id: string;
  grant_id: string;
  operation: Operation;
  operation_key: string;
  fingerprint: string;
  input: string;
  principal: string;
  target: string;
  state: string;
  revision: number;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  result: string | null;
  error: string | null;
}
const controlled = new Set<Operation>([
  "session_launch",
  "session_prompt",
  "session_cancel",
  "session_resume",
]);
export function approvalWait(request: Request) {
  const value = /(?:^|,)\s*wait=(\d+)\s*(?:,|$)/.exec(request.headers.get("prefer") ?? "")?.[1];
  return value === undefined ? 30000 : Math.min(30000, Number(value) * 1000);
}
export class Approvals {
  private waiters = new Map<string, Set<() => void>>();
  private stopped = false;
  constructor(private w: Workspace) {}
  requires(name: Operation, p: Principal) {
    return p.kind === "client" && p.permission_modes?.[operations[name].scope] === "approval";
  }
  private reviewable(name: string, input: unknown, context: unknown = null) {
    if (!reviewableApproval(name, input, context))
      throw new AppError(
        "unsupported_approval_content",
        "All strings in an approval request and its identity/target metadata must use visible, assigned Unicode text. Prompts require text-only parts. Hidden, control, private-use, unassigned, and surrogate characters are forbidden; tabs and line breaks are permitted.",
        400,
      );
  }
  private row(id: string) {
    const row = this.w.one<Approval>("SELECT * FROM approval_requests WHERE id=?", id);
    if (!row) throw new AppError("not_found", "Request not found", 404);
    return row;
  }
  private changed(id: string) {
    this.w.onChange();
    for (const notify of this.waiters.get(id) ?? []) notify();
  }
  private current(
    row: Pick<Approval, "principal" | "grant_id" | "client_id" | "operation">,
  ): Principal {
    const saved = JSON.parse(row.principal) as Principal;
    const grant = this.w.one<{
      scopes: string;
      resources: string;
      permissions: string;
      original_scopes: string;
    }>(
      "SELECT g.scopes,g.resources,g.permissions,original.scopes original_scopes FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id JOIN oauth_tokens original ON original.grant_id=g.id AND original.client_id=g.client_id AND original.hash=? WHERE g.id=? AND g.client_id=? AND g.revoked=0 AND c.revoked=0 AND EXISTS(SELECT 1 FROM oauth_tokens t WHERE t.grant_id=g.id AND t.revoked=0 AND (t.expires>? OR t.refresh_hash IS NOT NULL AND t.refresh_expires>?))",
      saved.auth_binding?.kind === "oauth" ? saved.auth_binding.hash : "",
      row.grant_id,
      row.client_id,
      this.w.now(),
      this.w.now(),
    );
    if (!grant)
      throw new AppError(
        "grant_revoked",
        "This request's access grant expired or was revoked",
        403,
      );
    const granted = JSON.parse(grant.scopes) as Scope[],
      original = JSON.parse(grant.original_scopes) as Scope[];
    const p = {
      ...saved,
      scopes: saved.scopes.filter((s) => granted.includes(s) && original.includes(s)),
      resources: resourceGrantsSchema.parse(JSON.parse(grant.resources)),
      permission_modes: JSON.parse(grant.permissions) as PermissionModes,
    };
    if (!can(p, operations[row.operation].scope))
      throw new AppError("grant_revoked", "This operation is no longer granted", 403);
    return p;
  }
  private expire() {
    const rows = this.w.all<{ id: string }>(
      "SELECT id FROM approval_requests WHERE state IN ('needs_approval','approved') AND expires_at<=?",
      this.w.now(),
    );
    for (const row of rows) {
      this.w.run(
        "UPDATE approval_requests SET state='expired',revision=revision+1 WHERE id=?",
        row.id,
      );
      this.changed(row.id);
    }
    const revoked = this.w.all<Approval>(
      "SELECT r.* FROM approval_requests r WHERE r.state IN ('needs_approval','approved') AND NOT EXISTS(SELECT 1 FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.id=r.grant_id AND g.revoked=0 AND c.revoked=0 AND EXISTS(SELECT 1 FROM oauth_tokens t WHERE t.grant_id=g.id AND t.revoked=0 AND (t.expires>? OR t.refresh_hash IS NOT NULL AND t.refresh_expires>?)))",
      this.w.now(),
      this.w.now(),
    );
    for (const row of revoked)
      this.finish(row, "failed", {
        code: "grant_revoked",
        message: "This request's access grant expired or was revoked",
      });
  }
  private presentation(input: Input, target: Input, p: Principal) {
    const session = this.w.one<{ agent_type: string; label: string | null }>(
      "SELECT agent_type,label FROM agent_sessions WHERE id=?",
      String(target.session_id ?? ""),
    );
    return {
      target,
      operator_name: p.operator_name ?? p.id,
      client_id: p.id,
      machine_name:
        this.w.one<{ name: string }>(
          "SELECT name FROM machines WHERE id=?",
          String(target.machine_id),
        )?.name ?? null,
      project_name:
        this.w.one<{ name: string }>(
          "SELECT name FROM projects WHERE id=?",
          String(target.project_id),
        )?.name ?? null,
      harness: input.harness ?? session?.agent_type ?? null,
      cwd:
        input.cwd ??
        this.w.one<{ cwd: string }>(
          "SELECT cwd FROM session_runtimes WHERE id=?",
          String(target.runtime_id ?? ""),
        )?.cwd ??
        null,
      label: input.label ?? session?.label ?? null,
    };
  }
  private review(row: Approval) {
    const input = JSON.parse(row.input) as Input;
    return {
      input,
      ...this.presentation(input, JSON.parse(row.target), JSON.parse(row.principal)),
    };
  }
  private storedReviewable(row: Approval) {
    const { input, ...context } = this.review(row);
    return reviewableApproval(row.operation, input, context);
  }
  private view(row: Approval, owner = false) {
    return {
      id: row.id,
      operation: row.operation,
      operation_key: row.operation_key,
      state: row.state,
      revision: row.revision,
      created_at: row.created_at,
      expires_at: row.expires_at,
      decided_at: row.decided_at,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error ? JSON.parse(row.error) : null,
      ...(owner ? this.review(row) : {}),
    };
  }
  ownerList() {
    this.expire();
    return this.w
      .all<Approval>(
        "SELECT * FROM approval_requests ORDER BY state='needs_approval' DESC,created_at DESC,id DESC LIMIT 200",
      )
      .map((row) => this.view(row, true));
  }
  ownerGet(id: string) {
    this.expire();
    return this.view(this.row(id), true);
  }
  private visible(row: Approval, p: Principal) {
    if (p.kind !== "client" || p.id !== row.client_id || p.grant_id !== row.grant_id)
      throw new AppError("not_found", "Request not found", 404);
    const current = this.current(row);
    this.w.access.run({ ...p, resources: current.resources }, () =>
      this.w.access.inputs(row.operation, JSON.parse(row.input)),
    );
  }
  get(id: string, p: Principal) {
    this.expire();
    const row = this.row(id);
    this.visible(row, p);
    return this.view(row);
  }
  list(a: Input, p: Principal) {
    this.expire();
    const rows = this.w
      .all<Approval>(
        "SELECT * FROM approval_requests WHERE client_id=? AND grant_id=? ORDER BY created_at DESC,id DESC",
        p.id,
        p.grant_id ?? "",
      )
      .filter((row) => {
        try {
          this.visible(row, p);
          return true;
        } catch (error) {
          if (error instanceof AppError && [403, 404].includes(error.status)) return false;
          throw error;
        }
      });
    return this.w.page(
      rows.map((row) => this.view(row)),
      a,
    );
  }
  permits(name: Operation, a: Input, p: Principal) {
    if (!p.approval_id) return false;
    const row = this.w.one<Approval>("SELECT * FROM approval_requests WHERE id=?", p.approval_id);
    return (
      !!row &&
      reviewableApproval(name, a, { operator_name: p.operator_name, client_id: p.id }) &&
      this.storedReviewable(row) &&
      !!row.decided_at &&
      row.state === "executing" &&
      row.client_id === p.id &&
      row.grant_id === p.grant_id &&
      row.operation === name &&
      row.fingerprint === digest(canonical({ name, input: a }))
    );
  }
  commandApproved(id: string, commandId: string, grantId: string) {
    const row = this.w.one<Approval & { command_payload: string }>(
      "SELECT r.*,c.payload command_payload FROM approval_requests r JOIN session_commands c ON c.id=? JOIN audit_operations a ON a.id=c.operation_id JOIN machines m ON m.id=json_extract(r.target,'$.machine_id') WHERE m.active_credential_id IS json_extract(r.target,'$.machine_credential_id') AND r.id=? AND r.grant_id=? AND r.state IN ('executing','succeeded') AND a.connection_id=r.client_id AND a.operation=r.operation AND a.operation_key=r.operation_key",
      commandId,
      id,
      grantId,
    );
    return (
      !!row &&
      this.storedReviewable(row) &&
      reviewableApproval(row.operation, JSON.parse(row.command_payload))
    );
  }
  private finish(row: Approval, state: "succeeded" | "failed", value: unknown) {
    this.w.run(
      `UPDATE approval_requests SET state=?,${state === "succeeded" ? "result" : "error"}=?,revision=revision+1 WHERE id=?`,
      state,
      JSON.stringify(value),
      row.id,
    );
    this.changed(row.id);
  }
  private run(id: string) {
    const row = this.row(id);
    if (!["approved", "executing"].includes(row.state)) return;
    const prior = this.w.one<{ operation: string; hash: string; result: string }>(
      "SELECT * FROM operations WHERE actor=? AND key=?",
      row.client_id,
      row.operation_key,
    );
    if (prior && prior.operation === row.operation && prior.hash === digest(row.input)) {
      this.finish(row, "succeeded", JSON.parse(prior.result));
      return;
    }
    try {
      if (row.expires_at <= this.w.now())
        throw new AppError("approval_expired", "This request expired; submit a new request", 409);
      const principal = this.current(row),
        input = JSON.parse(row.input) as Input;
      this.reviewable(
        row.operation,
        input,
        this.presentation(input, JSON.parse(row.target), principal),
      );
      this.w.access.run(principal, () => {
        this.w.access.inputs(row.operation, input);
        const target = this.w.executions.approvalTarget(row.operation, input);
        if (canonical(target) !== row.target)
          throw new AppError(
            "request_changed",
            "The target execution changed; submit a new request for review",
            409,
          );
      });
      this.w.run(
        "UPDATE approval_requests SET state='executing',revision=revision+1 WHERE id=?",
        row.id,
      );
      this.w.execute(row.operation, input, { ...principal, approval_id: row.id });
    } catch (error) {
      const admitted = this.w.one<{ operation: string; hash: string; result: string }>(
        "SELECT * FROM operations WHERE actor=? AND key=?",
        row.client_id,
        row.operation_key,
      );
      if (admitted?.operation === row.operation && admitted.hash === digest(row.input)) {
        this.finish(row, "succeeded", JSON.parse(admitted.result));
        return;
      }
      this.finish(
        row,
        "failed",
        error instanceof AppError
          ? { code: error.code, message: error.message }
          : { code: "internal_error", message: "The approved request could not be completed" },
      );
      return;
    }
    const admitted = this.w.one<{ result: string }>(
      "SELECT result FROM operations WHERE actor=? AND key=?",
      row.client_id,
      row.operation_key,
    )!;
    this.finish(row, "succeeded", JSON.parse(admitted.result));
  }
  recover() {
    for (const row of this.w.all<{ id: string }>(
      "SELECT id FROM approval_requests WHERE state IN ('approved','executing')",
    ))
      this.run(row.id);
  }
  decide(id: string, decision: "approve" | "deny", revision: number, owner: Principal) {
    if (!isBrowserOwner(this.w.db, owner, this.w.now()))
      throw new AppError("forbidden", "Owner browser approval required", 403);
    this.expire();
    const row = this.row(id);
    if (
      row.decided_at &&
      (decision === "approve" ? row.state !== "denied" : row.state === "denied")
    )
      return this.view(row, true);
    if (row.state !== "needs_approval" || row.revision !== revision)
      throw new AppError("revision_conflict", "This approval request changed; refresh it", 409);
    if (decision === "approve" && !this.storedReviewable(row)) {
      this.finish(row, "failed", {
        code: "unsupported_approval_content",
        message:
          "This stored request or its identity/target metadata cannot be reviewed safely. Submit a new request with visible, assigned Unicode text.",
      });
      return this.ownerGet(row.id);
    }
    this.w.run(
      "UPDATE approval_requests SET state=?,decided_at=?,decided_by=?,revision=revision+1 WHERE id=?",
      decision === "approve" ? "approved" : "denied",
      this.w.now(),
      owner.id,
      row.id,
    );
    if (decision === "approve") this.run(row.id);
    else this.changed(row.id);
    return this.ownerGet(row.id);
  }
  private async wait(id: string, milliseconds: number, signal?: AbortSignal) {
    if (milliseconds <= 0 || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const listeners = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, listeners);
      const done = () => {
        clearTimeout(timer);
        listeners.delete(done);
        if (!listeners.size) this.waiters.delete(id);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      listeners.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  async request(
    name: Operation,
    input: unknown,
    p: Principal,
    options: { waitMs?: number; signal?: AbortSignal } = {},
  ) {
    if (
      !controlled.has(name) ||
      !p.grant_id ||
      p.auth_binding?.kind !== "oauth" ||
      !can(p, operations[name].scope)
    )
      throw new AppError("forbidden", "This request cannot use approval mode", 403);
    p = this.current({
      principal: canonical(p),
      grant_id: p.grant_id,
      client_id: p.id,
      operation: name,
    });
    this.reviewable(name, input, { operator_name: p.operator_name, client_id: p.id });
    const parsed = operations[name].schema.safeParse(input);
    if (!parsed.success)
      throw new AppError("invalid_input", "Invalid request", 400, parsed.error.flatten());
    const a = parsed.data as Input;
    if (name === "session_resume" && a.force && p.inlet === "mcp")
      throw new AppError("forbidden", "Force resume is private", 403);
    this.w.access.inputs(name, a);
    const encoded = canonical(a),
      fingerprint = digest(canonical({ name, input: a }));
    if (Buffer.byteLength(encoded) > 1024 * 1024)
      throw new AppError("too_large", "Approval requests must fit within 1 MiB", 413);
    this.expire();
    let row = this.w.one<Approval>(
      "SELECT * FROM approval_requests WHERE client_id=? AND operation_key=?",
      p.id,
      String(a.operation_key),
    );
    if (row) {
      this.visible(row, p);
      if (row.fingerprint !== fingerprint)
        throw new AppError(
          "key_conflict",
          "This operation key belongs to a different request",
          409,
        );
    } else {
      const target = this.w.executions.approvalTarget(name, a);
      this.reviewable(name, a, this.presentation(a, target, p));
      const count = this.w.one<{ n: number }>(
        "SELECT COUNT(*) n FROM approval_requests WHERE grant_id=? AND state='needs_approval'",
        p.grant_id!,
      )!.n;
      if (count >= 32)
        throw new AppError(
          "approval_capacity",
          "Review or expire pending requests before adding another",
          429,
        );
      const id = uid("request"),
        at = this.w.now();
      this.w.run(
        "INSERT INTO approval_requests(id,client_id,grant_id,operation,operation_key,fingerprint,input,principal,target,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'needs_approval',?,?)",
        id,
        p.id,
        p.grant_id!,
        name,
        String(a.operation_key),
        fingerprint,
        encoded,
        canonical(p),
        canonical(target),
        at,
        new Date(Date.parse(at) + 3600000).toISOString(),
      );
      row = this.row(id);
      this.changed(id);
    }
    if (["approved", "executing"].includes(row.state)) this.run(row.id);
    const deadline = performance.now() + Math.max(0, Math.min(30000, options.waitMs ?? 30000));
    while (
      !this.stopped &&
      !options.signal?.aborted &&
      performance.now() < deadline &&
      this.row(row.id).state === "needs_approval"
    )
      await this.wait(row.id, deadline - performance.now(), options.signal);
    if (this.stopped)
      throw new AppError(
        "unavailable",
        "Server stopped; retrieve this request after reconnecting",
        503,
        { request_id: row.id },
      );
    row = this.row(row.id);
    this.visible(row, p);
    if (row.state === "succeeded") return JSON.parse(row.result!);
    if (row.state === "failed") {
      const error = JSON.parse(row.error!);
      throw new AppError(error.code, error.message, 409, { request_id: row.id });
    }
    if (row.state === "denied" || row.state === "expired")
      throw new AppError(
        `approval_${row.state}`,
        `This request was ${row.state}; submit a new request if needed`,
        403,
        { request_id: row.id },
      );
    throw new AppError(
      "needs_approval",
      "The owner must approve this exact request in the Allgather web app. Retrieve it with requests_get; do not submit a new operation key.",
      403,
      {
        request_id: row.id,
        status: "needs_approval",
        expires_at: row.expires_at,
      },
    );
  }
  close() {
    this.stopped = true;
    for (const listeners of this.waiters.values()) for (const notify of [...listeners]) notify();
  }
}
