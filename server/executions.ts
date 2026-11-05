import { createHmac } from "node:crypto";
import Ajv from "ajv";
import type { ArtifactNotificationSource } from "../shared/artifact-delivery.ts";
import {
  AppError,
  can,
  type Machine,
  type Operation,
  type Principal,
  type SessionCommand,
  type SessionEvent,
  type SessionRuntime,
} from "../shared/contracts.ts";
import {
  acceptsPrompt,
  hasManagedProtocol,
  hasTerminalProtocol,
  intersectControls,
  type MachineScope,
  machineScopes,
  receiptSchema,
  resumeCleanupSchema,
  type SessionControls,
} from "../shared/tower-acp.ts";
import type { CatalogSyncStatus } from "../shared/tower-catalog.ts";
import type { TowerPolicyAck, TowerPolicyReport } from "../shared/tower-policy.ts";
import { statusCheckoutIdSchema } from "../shared/tower-sync.ts";
import { hash, secret } from "./auth.ts";
import { ManagedControl } from "./managed-control.ts";
import { setSetting, setting } from "./storage.ts";
import { checkoutObservations } from "./tower-catalog.ts";
import { canonical, digest, uid, type Workspace } from "./workspace.ts";

type Input = Record<string, unknown>;
type Stored<T, K extends keyof T> = Omit<T, K> & Record<K, string>;
export class Executions {
  readonly managed: ManagedControl;
  private fingerprintKey: string;
  constructor(private w: Workspace) {
    this.fingerprintKey = setting(w.db, "private_fingerprint_key") ?? secret();
    setSetting(w.db, "private_fingerprint_key", this.fingerprintKey);
    this.managed = new ManagedControl(w);
  }
  privateFingerprint(value: unknown) {
    return createHmac("sha256", this.fingerprintKey).update(canonical(value)).digest("hex");
  }
  machine(id: string): Machine {
    const row = this.w.one<
      Stored<
        Machine,
        "capabilities" | "harnesses" | "policy" | "harness_controls" | "terminal_controls"
      > & { active_credential_id: string | null }
    >("SELECT * FROM machines WHERE id=?", id);
    if (!row) throw new AppError("not_found", "Machine not found", 404);
    const report = this.w.one<{ requested_revision: number; observed_at: string; body: string }>(
      "SELECT requested_revision,observed_at,body FROM machine_policy_reports WHERE machine_id=?",
      id,
    );
    const policy_report: TowerPolicyReport | null = report
      ? {
          ...(JSON.parse(report.body) as TowerPolicyAck),
          requested_revision: report.requested_revision,
          observed_at: report.observed_at,
        }
      : null;
    const { active_credential_id, ...publicRow } = row;
    const credential =
      row.connected && active_credential_id
        ? this.w.one<{ scopes: string }>(
            "SELECT scopes FROM tower_credentials WHERE id=? AND machine_id=? AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM tower_enrollments e WHERE e.credential_id=tower_credentials.id AND e.state!='confirmed' AND e.expires_at<=?)",
            active_credential_id,
            row.id,
            this.w.now(),
          )
        : null;
    return {
      ...publicRow,
      connection_scopes: credential ? JSON.parse(credential.scopes) : [],
      terminal_controls: JSON.parse(row.terminal_controls),
      capabilities: JSON.parse(row.capabilities),
      harnesses: JSON.parse(row.harnesses),
      harness_controls: JSON.parse(row.harness_controls),
      managed_enabled: !!this.w.managedSessions,
      policy: JSON.parse(row.policy),
      policy_report,
      policy_status:
        policy_report?.requested_revision === row.policy_revision
          ? policy_report.outcome
          : "pending",
      connected: !!row.connected,
      catalog_sync:
        this.w.one<CatalogSyncStatus>(
          "SELECT catalog_revision,catalog_error,checkout_error,checkout_received_at,checkouts_current FROM machine_catalog_sync WHERE machine_id=?",
          id,
        ) ?? null,
    };
  }
  runtime(session: string): SessionRuntime | null {
    this.w.sessions.get(session);
    const r = this.w.one<Stored<SessionRuntime, "controls"> & { observed_checkout_id: unknown }>(
      "SELECT r.*,json_extract(t.record,'$.checkout_id') observed_checkout_id FROM session_runtimes r LEFT JOIN tower_records t ON t.machine_id=r.machine_id AND t.tower_id=r.tower_session_id WHERE r.session_id=? ORDER BY r.rowid DESC LIMIT 1",
      session,
    );
    if (!r) return null;
    const { observed_checkout_id, ...stored } = r;
    const reference = statusCheckoutIdSchema.safeParse(observed_checkout_id);
    const runtime = {
      ...stored,
      // Observation only: never use the legacy FK or infer an execution target from cwd.
      checkout_id: reference.success ? reference.data : null,
      controls: r.controls ? JSON.parse(r.controls) : null,
      connected: !!r.connected,
    };
    return {
      ...runtime,
      stop_requested: this.stopping(runtime),
      resume_requires_force: this.unresolved(session).length > 0,
    };
  }
  stopping(runtime: SessionRuntime): boolean {
    return (
      runtime.controls?.cancel_mode === "runtime" &&
      !!this.w.one(
        "SELECT 1 FROM session_commands WHERE runtime_id=? AND kind='cancel' AND (state!='failed' OR json_extract(result,'$.error.may_have_effect')=1)",
        runtime.id,
      )
    );
  }
  controls(runtime: SessionRuntime): SessionControls | null {
    const machine = this.machine(runtime.machine_id),
      harness = this.w.sessions.get(runtime.session_id).agent_type;
    if (!machine.managed_enabled) return null;
    if (runtime.protocol === "terminal")
      return hasTerminalProtocol(machine.capabilities)
        ? intersectControls(runtime.controls, machine.terminal_controls[harness])
        : null;
    if (!machine.harnesses.includes(harness) || !hasManagedProtocol(machine.capabilities))
      return null;
    return intersectControls(runtime.controls, machine.harness_controls[harness]);
  }
  commandSupported(runtime: SessionRuntime, kind: SessionCommand["kind"], payload: Input): boolean {
    const controls = this.controls(runtime);
    if (!controls) return false;
    if (kind !== "cancel" && this.stopping(runtime)) return false;
    if (kind === "launch") return true;
    if (kind === "resume") {
      const capabilities = this.machine(runtime.machine_id).capabilities;
      return (
        controls.capabilities.includes("resume") &&
        capabilities.includes("session-resume.v1") &&
        (payload.force !== true || capabilities.includes("session-force-resume.v1"))
      );
    }
    if (kind === "cancel") return controls.cancel_mode !== null;
    if (kind === "prompt") return acceptsPrompt(controls, payload.content);
    if (kind === "configure") return controls.capabilities.includes("configure");
    const request = this.w.one<{ kind: "permission" | "elicitation" }>(
      "SELECT kind FROM session_requests WHERE id=? AND runtime_id=?",
      String(payload.request_id),
      runtime.id,
    );
    return (
      !!request &&
      controls.capabilities.includes(
        request.kind === "permission" ? "permission_reply" : "elicitation_reply",
      )
    );
  }
  private unresolved(sessionId: string, exclude = "") {
    return this.w.all<
      Pick<
        SessionRuntime,
        | "id"
        | "generation"
        | "machine_id"
        | "state"
        | "owner_id"
        | "native_session_id"
        | "acp_session_id"
      >
    >(
      "SELECT id,generation,machine_id,state,owner_id,native_session_id,acp_session_id FROM session_runtimes WHERE session_id=? AND (termination!='confirmed' OR state NOT IN ('ended','error')) AND id!=? ORDER BY rowid",
      sessionId,
      exclude,
    );
  }
  replacementClean(runtime: SessionRuntime) {
    const force = this.w.one(
      "SELECT 1 FROM session_commands WHERE runtime_id=? AND kind='resume' AND json_extract(payload,'$.force')=1",
      runtime.id,
    );
    return !force || this.unresolved(runtime.session_id, runtime.id).length === 0;
  }
  replacementError(command: SessionCommand, target: SessionRuntime) {
    const { force, cleanup, takeover } = command.payload;
    if (
      takeover !== undefined ||
      (force !== undefined && force !== true) ||
      (cleanup !== undefined && force !== true) ||
      ((force !== undefined || cleanup !== undefined) &&
        (command.kind !== "resume" || target.protocol === "terminal"))
    )
      return "cleanup_target_conflict";
    if (!["launch", "resume"].includes(command.kind)) return null;
    if (command.runtime_id !== target.id || command.session_id !== target.session_id)
      return "cleanup_target_conflict";
    const unresolved = this.unresolved(command.session_id, target.id);
    if (force !== true) return unresolved.length ? "cleanup_unconfirmed" : null;
    const parsed = resumeCleanupSchema.safeParse(cleanup);
    if (!parsed.success) return "cleanup_target_conflict";
    const targets = new Set(parsed.data.map((r) => r.runtime_id));
    if (!unresolved.every((r) => targets.has(r.id))) return "cleanup_target_conflict";
    return parsed.data.every(
      (r) =>
        r.runtime_id !== target.id &&
        !!this.w.one(
          "SELECT 1 FROM session_runtimes WHERE id=? AND generation=? AND session_id=? AND machine_id=? AND (fenced=1 OR (termination='confirmed' AND state IN ('ended','error')))",
          r.runtime_id,
          r.generation,
          target.session_id,
          target.machine_id,
        ),
    )
      ? null
      : "cleanup_target_conflict";
  }
  private requireCommand(
    runtime: SessionRuntime,
    kind: SessionCommand["kind"],
    payload: Input = {},
  ) {
    if (!this.commandSupported(runtime, kind, payload))
      throw new AppError(
        "unsupported_control",
        "This agent execution does not support that control or input type",
        409,
      );
    if (runtime.protocol === "terminal")
      this.requireTerminalConsent(this.machine(runtime.machine_id));
  }
  private requireTerminalConsent(machine: Machine) {
    if (!machine.connected)
      throw new AppError(
        "machine_not_connected",
        "Terminal control requires a current Tower connection",
        409,
      );
    if (!machine.connection_scopes.includes("terminal:control"))
      throw new AppError(
        "control_scope_required",
        "Machine enrollment did not grant terminal:control",
        403,
      );
  }
  command(id: string): SessionCommand {
    const c = this.w.one<Stored<SessionCommand, "payload" | "result">>(
      "SELECT * FROM session_commands WHERE id=?",
      id,
    );
    if (!c) throw new AppError("not_found", "Command not found", 404);
    return { ...c, payload: JSON.parse(c.payload), result: c.result ? JSON.parse(c.result) : null };
  }
  private commandStatus(command: SessionCommand) {
    const receipt = receiptSchema.safeParse(command.result);
    return {
      id: command.id,
      session_id: command.session_id,
      runtime_id: command.runtime_id,
      kind: command.kind,
      state: command.state,
      created_at: command.created_at,
      updated_at: command.updated_at,
      ...(receipt.success
        ? {
            acceptance: receipt.data.acceptance ?? null,
            dispatch: receipt.data.dispatch,
            outcome: receipt.data.result?.outcome ?? null,
            error: receipt.data.error
              ? {
                  code: receipt.data.error.code,
                  stage: receipt.data.error.stage,
                  may_have_effect: receipt.data.error.may_have_effect,
                }
              : null,
          }
        : {}),
    };
  }
  private queue(
    session: string,
    runtime: string,
    kind: SessionCommand["kind"],
    payload: Input,
    key: string,
  ) {
    const encoded = JSON.stringify(
      kind === "reply"
        ? {
            request_id: payload.request_id,
            source_request_id: payload.source_request_id,
            generation: payload.generation,
            redacted: true,
          }
        : payload,
    );
    if (Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024 - 4096)
      throw new AppError(
        "command_too_large",
        "Command payload must fit within the 1 MiB Tower frame. Upload larger content as session assets.",
        413,
      );
    const id = uid("command"),
      at = this.w.now();
    this.w.run(
      "INSERT INTO session_commands VALUES(?,?,?,?,?,?,?,'queued',NULL,?,?)",
      id,
      session,
      runtime,
      this.w.operationId,
      key,
      kind,
      encoded,
      at,
      at,
    );
    this.managed.rememberAuthority(id, this.w.principal);
    if (kind === "reply") this.managed.holdReply(id, payload);
    return this.command(id);
  }
  private bound(session: string) {
    const runtime = this.runtime(session);
    if (!runtime || runtime.fenced || ["ended", "error"].includes(runtime.state))
      throw new AppError("session_not_live", "This session has no live execution", 409);
    return runtime;
  }
  queueNotification(runtime: SessionRuntime, body: string, source: ArtifactNotificationSource) {
    if (!can(this.w.principal, "sessions:prompt"))
      throw new AppError("forbidden", "Managed notifications require session prompt access", 403);
    const current = this.bound(runtime.session_id);
    if (current.id !== runtime.id || current.generation !== runtime.generation)
      throw new AppError("runtime_conflict", "Notification execution changed", 409);
    const payload = { content: [{ type: "text", text: body }], source };
    this.requireCommand(current, "prompt", payload);
    if (current.state === "starting" || !(current.acp_session_id || current.native_session_id))
      throw new AppError(
        "session_not_ready",
        "Wait for managed session readiness before notifying it",
        409,
      );
    return this.queue(
      current.session_id,
      current.id,
      "prompt",
      payload,
      `notification:${source.notification_id}`,
    );
  }
  private supports(
    machine: Machine,
    harness: string,
    resume = false,
    terminal = false,
  ): SessionControls {
    if (!this.w.managedSessions)
      throw new AppError(
        "unsupported_capability",
        "Managed sessions are disabled in server configuration",
        409,
      );
    if (terminal) {
      if (!hasTerminalProtocol(machine.capabilities))
        throw new AppError(
          "unsupported_capability",
          "Machine has not negotiated terminal launch",
          409,
        );
      const controls = machine.terminal_controls[harness];
      if (!controls)
        throw new AppError(
          "unsupported_agent",
          "This machine has not advertised terminal launch for that agent",
          409,
        );
      this.requireTerminalConsent(machine);
      return controls;
    }
    for (const capability of [
      "managed-acp.v1",
      "command-receipts.v1",
      "session-stream.v1",
      ...(resume ? ["session-resume.v1"] : []),
    ])
      if (!machine.capabilities.includes(capability))
        throw new AppError(
          "unsupported_capability",
          `Machine does not advertise ${capability}`,
          409,
        );
    if (!machine.harnesses.includes(harness))
      throw new AppError(
        "unsupported_agent",
        "This machine has not advertised managed support for that agent",
        409,
      );
    const controls = machine.harness_controls[harness];
    if (
      !controls ||
      (harness === "codex" && controls.protocol !== "codex-app-server") ||
      (resume && !controls.capabilities.includes("resume"))
    )
      throw new AppError(
        "unsupported_control",
        "This agent has not advertised the required managed controls",
        409,
      );
    return controls;
  }
  read(name: Operation, a: Input, p: Principal): unknown {
    if (name === "machines_list")
      return this.w
        .all<{ id: string }>("SELECT id FROM machines ORDER BY name,id")
        .map((r) => this.machine(r.id));
    if (name === "machines_get") {
      const m = this.machine(String(a.machine_id));
      return {
        ...m,
        agents: this.w
          .all<{ record: string; observed_at: string }>(
            "SELECT record,observed_at FROM tower_records WHERE machine_id=? ORDER BY tower_id",
            m.id,
          )
          .map((r) => ({ ...JSON.parse(r.record), observed_at: r.observed_at })),
      };
    }
    if (name === "checkouts_list") return checkoutObservations(this.w, a);
    const session = this.w.sessions.get(String(a.target_session_id));
    if (name === "session_assets_list")
      return this.w.all(
        "SELECT * FROM session_assets WHERE session_id=? ORDER BY created_at,id",
        session.id,
      );
    if (name === "session_runtime_get") {
      const runtime = this.runtime(session.id);
      const checkout = runtime?.checkout_id
        ? (checkoutObservations(this.w, {
            machine_id: runtime.machine_id,
            checkout_id: runtime.checkout_id,
            include_removed: true,
          })[0] ?? null)
        : null;
      return { session, runtime, checkout };
    }
    if (name === "session_transcript_sources")
      return this.w.all(
        "SELECT * FROM transcript_sources WHERE session_id=? ORDER BY created_at,id",
        session.id,
      );
    if (name === "session_transcript_events") {
      const rows = this.w.all<Stored<SessionEvent, "payload">>(
          "SELECT * FROM session_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",
          session.id,
          Number(a.after),
          Number(a.limit) + 1,
        ),
        more = rows.length > Number(a.limit),
        items = rows
          .slice(0, Number(a.limit))
          .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
      return { items, has_more: more, next_sequence: items.at(-1)?.sequence ?? Number(a.after) };
    }
    if (name === "session_requests")
      return this.w
        .all<Record<string, unknown>>(
          "SELECT * FROM session_requests WHERE session_id=? ORDER BY rowid",
          session.id,
        )
        .map((r) => ({
          ...r,
          payload:
            r.state === "pending"
              ? (this.managed.request(String(r.id))?.payload ?? {
                  redacted: true,
                  unavailable: true,
                })
              : { redacted: true },
          response: r.response ? { redacted: true } : null,
        }));
    if (name === "session_commands")
      return this.w.page(
        this.w
          .all<{ id: string }>(
            "SELECT id FROM session_commands WHERE session_id=? ORDER BY created_at DESC,id",
            session.id,
          )
          .map((r) => {
            const command = this.command(r.id);
            return p.inlet === "mcp" ? this.commandStatus(command) : command;
          }),
        a,
      );
    throw new AppError("not_found", "Unknown session query", 404);
  }
  write(name: Operation, a: Input, p: Principal): unknown {
    if (name === "machines_create") {
      const id = uid("machine");
      this.w.run(
        "INSERT INTO machines(id,name,created_at) VALUES(?,?,?)",
        id,
        String(a.name),
        this.w.now(),
      );
      return this.machine(id);
    }
    if (name === "machines_update") {
      const m = this.machine(String(a.machine_id));
      if (m.revision !== a.expected_revision)
        throw new AppError("revision_conflict", "Read current machine settings", 409);
      this.w.run(
        "UPDATE machines SET name=?,policy=?,policy_revision=policy_revision+?,revision=revision+1 WHERE id=?",
        String(a.name ?? m.name),
        JSON.stringify(a.policy ?? m.policy),
        a.policy === undefined ? 0 : 1,
        m.id,
      );
      return this.machine(m.id);
    }
    if (name === "session_launch" || name === "session_resume") {
      const machine = this.machine(String(a.machine_id)),
        prior = name === "session_resume" ? this.w.sessions.get(String(a.target_session_id)) : null,
        harness = prior?.agent_type ?? String(a.harness);
      if (prior && this.runtime(prior.id)?.protocol === "terminal")
        throw new AppError("unsupported_control", "Remote terminal resume is not supported", 409);
      const controls = this.supports(machine, harness, !!prior, a.mode === "terminal");
      const forceRequested = prior !== null && a.force === true;
      if (forceRequested && p.inlet === "mcp")
        throw new AppError(
          "forbidden",
          "Force resume is available only through the private CLI or web app",
          403,
        );
      const unresolved = prior ? this.unresolved(prior.id) : [];
      const undispatched = new Set(
        unresolved
          .filter(
            (r) =>
              r.state === "starting" &&
              !r.owner_id &&
              !r.native_session_id &&
              !r.acp_session_id &&
              !!this.w.one(
                "SELECT 1 FROM session_commands c WHERE c.runtime_id=? AND c.kind IN ('launch','resume') AND c.state='queued' AND NOT EXISTS (SELECT 1 FROM command_receipts cr WHERE cr.command_id=c.id)",
                r.id,
              ),
          )
          .map((r) => r.id),
      );
      const cleanup = unresolved.filter((r) => !undispatched.has(r.id));
      const force = forceRequested && cleanup.length > 0;
      if (force && !machine.capabilities.includes("session-force-resume.v1"))
        throw new AppError("unsupported_control", "This Tower does not support force resume", 409);
      if (unresolved.length && !forceRequested)
        throw new AppError(
          "cleanup_unconfirmed",
          "Previous termination is unconfirmed. Stop the execution or use resume --force to clean it up before resuming",
          409,
        );
      if (cleanup.length > 32 || cleanup.some((r) => r.machine_id !== machine.id))
        throw new AppError(
          "cleanup_target_conflict",
          "Cleanup requires at most 32 executions on the original machine",
          409,
        );
      const history = prior
        ? this.w.one<{
            id: string;
            controls: string | null;
            protocol: string;
            native_session_id: string | null;
            acp_session_id: string | null;
            machine_id: string;
          }>(
            "SELECT * FROM session_runtimes WHERE session_id=? AND (native_session_id IS NOT NULL OR acp_session_id IS NOT NULL) ORDER BY rowid DESC LIMIT 1",
            prior.id,
          )
        : null;
      const previousRuntime = history
        ? { ...history, controls: history.controls ? JSON.parse(history.controls) : null }
        : null;
      if (previousRuntime && previousRuntime.machine_id !== machine.id)
        throw new AppError(
          "resume_unavailable",
          "Resume native history on its original machine",
          409,
        );
      if (previousRuntime && previousRuntime.protocol !== controls.protocol)
        throw new AppError(
          "resume_unavailable",
          "Native history cannot be resumed through a different backend protocol",
          409,
        );
      if (prior && !previousRuntime?.controls?.capabilities.includes("resume"))
        throw new AppError(
          "unsupported_control",
          "The previous execution did not advertise resumable history",
          409,
        );
      const resumeId =
        previousRuntime?.protocol === "codex-app-server"
          ? previousRuntime.native_session_id
          : previousRuntime?.acp_session_id;
      if (prior && !resumeId)
        throw new AppError(
          "resume_unavailable",
          "This session has no recorded native session ID to resume",
          409,
        );
      const session =
        prior ?? this.w.sessions.ensure(uid("session"), harness, a.label as string | undefined);
      if (a.role_id)
        this.w.sessions.write("sessions_bind_role", {
          target_session_id: session.id,
          role_id: a.role_id,
          expected_revision: session.revision,
        });
      if (a.task_id) {
        if (!can(p, "tasks:read"))
          throw new AppError("forbidden", "Task links require tasks:read", 403);
        this.w.task(String(a.task_id));
        this.w.graph.add("works_on", session.id, String(a.task_id));
      }
      for (const old of unresolved) {
        this.w.run(
          "UPDATE session_runtimes SET fenced=1,state='error',connected=0,termination=CASE WHEN ? THEN 'confirmed' ELSE termination END WHERE id=?",
          Number(undispatched.has(old.id)),
          old.id,
        );
        this.managed.invalidate(old.id);
        this.w.run(
          "UPDATE session_commands SET state=CASE WHEN state='queued' THEN 'failed' ELSE 'unknown' END,updated_at=? WHERE runtime_id=? AND state IN ('queued','sent')",
          this.w.now(),
          old.id,
        );
      }
      const runtime = uid("runtime"),
        generation = uid("generation"),
        at = this.w.now();
      this.w.run(
        "INSERT INTO session_runtimes(id,session_id,machine_id,cwd,protocol,generation,state,connected,last_seen_at,controls) VALUES(?,?,?,?,?,?,'starting',?,?,?)",
        runtime,
        session.id,
        machine.id,
        String(a.cwd),
        controls.protocol,
        generation,
        Number(machine.connected),
        at,
        JSON.stringify(controls),
      );
      const command = this.queue(
        session.id,
        runtime,
        prior ? "resume" : "launch",
        controls.protocol === "terminal"
          ? { protocol: "terminal", harness, cwd: a.cwd }
          : {
              harness,
              cwd: a.cwd,
              protocol: controls.protocol,
              resume_session_id: resumeId ?? undefined,
              generation,
              ...(force
                ? {
                    force: true,
                    cleanup: cleanup.map((r) => ({ runtime_id: r.id, generation: r.generation })),
                  }
                : {}),
            },
        String(a.operation_key),
      );
      return {
        session: this.w.sessions.get(session.id),
        runtime: this.runtime(session.id),
        command,
      };
    }
    if (name === "session_reconcile") {
      const c = this.command(String(a.command_id));
      if (c.state !== "unknown")
        throw new AppError("command_state", "Only unknown acceptance needs reconciliation", 409);
      if (a.decision === "failed" && ["launch", "resume"].includes(c.kind)) {
        const runtime = this.w.one<{
          acp_session_id: string | null;
          native_session_id: string | null;
        }>(
          "SELECT acp_session_id,native_session_id FROM session_runtimes WHERE id=?",
          c.runtime_id,
        );
        if (runtime?.acp_session_id || runtime?.native_session_id)
          throw new AppError(
            "execution_observed",
            "Tower already reported this execution. Reconcile acceptance, then cancel it separately.",
            409,
          );
        this.w.run(
          "UPDATE session_runtimes SET state='error',connected=0 WHERE id=? AND state='starting'",
          c.runtime_id,
        );
      }
      this.w.run(
        "UPDATE session_commands SET state=?,result=?,updated_at=? WHERE id=?",
        String(a.decision),
        JSON.stringify({ reconciled: true, reason: a.reason, actor: this.w.operator.id }),
        this.w.now(),
        c.id,
      );
      return this.command(c.id);
    }
    if (name === "session_reply") {
      const r = this.w.one<{
        session_id: string;
        runtime_id: string;
        runtime_generation: string;
        state: string;
        revision: number;
        source_request_id: string;
        payload: string;
        kind: string;
      }>("SELECT * FROM session_requests WHERE id=?", String(a.request_id));
      if (!r) throw new AppError("not_found", "Session request not found", 404);
      const runtime = this.bound(r.session_id);
      this.requireCommand(runtime, "reply", { request_id: a.request_id });
      if (
        r.revision !== a.expected_revision ||
        r.state !== "pending" ||
        r.runtime_id !== runtime.id ||
        r.runtime_generation !== runtime.generation ||
        !runtime.connected ||
        !this.machine(runtime.machine_id).connected
      )
        throw new AppError(
          "stale_request",
          "This request is no longer live on the current execution",
          409,
        );
      const response = a.response as Input,
        live = this.managed.request(String(a.request_id));
      if (!live)
        throw new AppError(
          "stale_request",
          "The private request must be reannounced by its live owner",
          409,
        );
      const request = live.payload;
      if (r.kind === "permission") {
        const outcome = response.outcome as Input | undefined;
        if (
          !outcome ||
          (outcome.outcome !== "cancelled" &&
            (outcome.outcome !== "selected" ||
              typeof outcome.optionId !== "string" ||
              !Array.isArray(request.options) ||
              !request.options.some((o: Input) => o.optionId === outcome.optionId)))
        )
          throw new AppError("invalid_response", "Choose an offered permission option or cancel");
      } else if (!["accept", "decline", "cancel"].includes(String(response.action)))
        throw new AppError("invalid_response", "Choose accept, decline, or cancel");
      if (r.kind === "elicitation" && request.mode === "url" && response.content != null)
        throw new AppError(
          "invalid_response",
          "URL consent cannot return form content or credentials",
        );
      if (r.kind === "elicitation" && response.action === "accept" && request.mode !== "url") {
        const schema = request.requestedSchema;
        if (
          !schema ||
          JSON.stringify(schema).length > 32768 ||
          /"\$(?:ref|dynamicRef|recursiveRef)"/.test(JSON.stringify(schema))
        )
          throw new AppError(
            "unsupported_schema",
            "This form schema is unavailable or uses references",
          );
        let valid = false;
        try {
          valid = new Ajv({ strict: false, validateFormats: false }).validate(
            schema,
            response.content,
          ) as boolean;
        } catch {
          throw new AppError("unsupported_schema", "This form schema cannot be validated");
        }
        if (!valid)
          throw new AppError("invalid_response", "The response does not match the requested form");
      }
      const command = this.queue(
        r.session_id,
        runtime.id,
        "reply",
        {
          request_id: a.request_id,
          source_request_id: r.source_request_id,
          generation: runtime.generation,
          request_revision: live.sourceRevision,
          response,
        },
        String(a.operation_key),
      );
      this.w.run(
        "UPDATE session_requests SET state='answered',reply_command_id=?,response=?,answered_by=?,answered_at=?,revision=revision+1 WHERE id=?",
        command.id,
        JSON.stringify({ redacted: true, fingerprint: this.privateFingerprint(response) }),
        this.w.operator.id,
        this.w.now(),
        String(a.request_id),
      );
      return command;
    }
    const session = this.w.sessions.get(String(a.target_session_id));
    if (name === "session_transcript_import") {
      const source = this.source(
        session.id,
        null,
        "native_import",
        String(a.source_key),
        String(a.format_version),
        String(a.coverage),
      );
      return this.append(source, a.events as Input[], false);
    }
    const runtime = this.bound(session.id);
    if (name === "session_prompt") {
      this.requireCommand(runtime, "prompt", { content: a.content });
      if (!(runtime.acp_session_id || runtime.native_session_id) || runtime.state === "starting")
        throw new AppError(
          "session_not_ready",
          "Wait for the adapter to confirm the ACP session before sending a prompt",
          409,
        );
      for (const block of a.content as Input[])
        if (
          block.asset_id &&
          !this.w.one(
            "SELECT 1 FROM session_assets a LEFT JOIN transcript_sources s ON s.id=a.source_id WHERE a.id=? AND a.session_id=? AND (a.source_id IS NULL OR (s.runtime_id=? AND s.source_key=?))",
            String(block.asset_id),
            session.id,
            runtime.id,
            runtime.generation,
          )
        )
          throw new AppError(
            "invalid_asset",
            "Prompt assets must belong to this session and execution",
          );
      return this.queue(
        session.id,
        runtime.id,
        "prompt",
        { content: a.content },
        String(a.operation_key),
      );
    }
    if (name === "session_cancel") {
      const unstarted =
        runtime.state === "starting" &&
        this.w.one(
          "SELECT 1 FROM session_commands WHERE runtime_id=? AND kind IN ('launch','resume') AND state='queued'",
          runtime.id,
        );
      if (!unstarted) this.requireCommand(runtime, "cancel");
      this.w.run(
        "UPDATE session_commands SET state='failed',result=?,updated_at=? WHERE runtime_id=? AND state='queued' AND (kind='prompt' OR ?=1)",
        JSON.stringify({ cancelled: true }),
        this.w.now(),
        runtime.id,
        Number(!!unstarted),
      );
      const command = this.queue(session.id, runtime.id, "cancel", {}, String(a.operation_key));
      if (unstarted) {
        this.w.run(
          "UPDATE session_commands SET state='acknowledged',result=? WHERE id=?",
          JSON.stringify({ cancelled_before_launch: true }),
          command.id,
        );
        this.w.run(
          "UPDATE session_runtimes SET state='ended',termination='confirmed' WHERE id=?",
          runtime.id,
        );
      }
      return this.command(command.id);
    }
    if (name === "session_configure") {
      this.requireCommand(runtime, "configure");
      return this.queue(
        session.id,
        runtime.id,
        "configure",
        { config: a.config },
        String(a.operation_key),
      );
    }
    throw new AppError("not_found", "Unknown session command", 404);
  }
  source(
    session: string,
    runtime: string | null,
    kind: "native_import" | "acp_stream" | "terminal_lifecycle",
    key: string,
    format: string,
    coverage: string,
  ) {
    const existing = this.w.one<{ id: string; runtime_id: string | null }>(
      "SELECT id,runtime_id FROM transcript_sources WHERE session_id=? AND kind=? AND source_key=?",
      session,
      kind,
      key,
    );
    if (existing) {
      if (existing.runtime_id !== runtime)
        throw new AppError("source_conflict", "A transcript source cannot change execution", 409);
      return existing.id;
    }
    const id = uid("source");
    this.w.run(
      "INSERT INTO transcript_sources VALUES(?,?,?,?,?,?,0,?,?)",
      id,
      session,
      runtime,
      kind,
      key,
      format,
      coverage,
      this.w.now(),
    );
    return id;
  }
  append(sourceId: string, events: Input[], live: boolean) {
    const source = this.w.one<{
      id: string;
      session_id: string;
      runtime_id: string | null;
      cursor: number;
      kind: string;
    }>("SELECT * FROM transcript_sources WHERE id=?", sourceId);
    if (!source) throw new AppError("not_found", "Transcript source not found", 404);
    let sequence = this.w.one<{ n: number }>(
      "SELECT COALESCE(MAX(sequence),0) n FROM session_events WHERE session_id=?",
      source.session_id,
    )!.n;
    let added = 0;
    for (const event of events) {
      const requestPayload = canonical(event.payload),
        data = event.payload as Input;
      // Authentication destinations belong to private live-control state, never transcript exports.
      const payload = ["permission_request", "elicitation_request"].includes(String(event.kind))
        ? canonical({
            kind: event.kind,
            ...(data.mode === "url" ? { mode: "url" } : {}),
            redacted: true,
            message: "External setup request. Open the live session controls to review it.",
            source_fingerprint: this.privateFingerprint(requestPayload),
          })
        : requestPayload;
      if (Buffer.byteLength(requestPayload) > 1024 * 1024)
        throw new AppError("event_too_large", "Session events must fit within 1 MiB");
      const existing = this.w.one<{
        kind: string;
        payload: string;
        command_id: string | null;
        occurred_at: string | null;
      }>(
        "SELECT kind,payload,command_id,occurred_at FROM session_events WHERE source_id=? AND source_event_key=?",
        sourceId,
        String(event.key),
      );
      if (existing) {
        if (
          existing.kind !== event.kind ||
          existing.payload !== payload ||
          existing.command_id !== (event.command_id ?? null) ||
          existing.occurred_at !== (event.at ?? null)
        )
          throw new AppError(
            "event_conflict",
            "An event identity was reused with different content",
            409,
          );
        continue;
      }
      const id = uid("event");
      if (
        event.command_id &&
        (this.command(String(event.command_id)).session_id !== source.session_id ||
          (live && this.command(String(event.command_id)).runtime_id !== source.runtime_id))
      )
        throw new AppError("invalid_command", "Event command belongs to another session");
      this.w.run(
        "INSERT INTO session_events VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)",
        id,
        source.session_id,
        ++sequence,
        sourceId,
        String(event.key),
        source.runtime_id,
        (event.command_id as string) ?? null,
        String(event.kind),
        payload,
        (event.at as string) ?? null,
        this.w.now(),
        (event.source_sequence as number) ?? null,
      );
      added++;
      if (event.kind === "gap")
        this.w.run("UPDATE transcript_sources SET coverage='partial' WHERE id=?", sourceId);
      if (live && source.runtime_id) {
        const runtime = this.runtime(source.session_id)!;
        if (
          runtime.id !== source.runtime_id ||
          runtime.fenced ||
          ["ended", "error"].includes(runtime.state)
        )
          continue;
        const data = event.payload as Input;
        if (event.kind === "turn_end") {
          if (!event.command_id || runtime.active_prompt_id !== event.command_id)
            throw new AppError(
              "turn_conflict",
              "Turn completion must identify the active prompt command",
              409,
            );
          this.w.run(
            "UPDATE session_runtimes SET state='idle',active_prompt_id=NULL WHERE id=?",
            source.runtime_id,
          );
          this.managed.invalidate(source.runtime_id);
        } else if (
          event.kind === "runtime_state" &&
          ["idle", "running", "waiting", "ended", "error"].includes(String(data.state))
        ) {
          const terminal = ["ended", "error"].includes(String(data.state));
          this.w.run(
            "UPDATE session_runtimes SET state=?,connected=CASE WHEN ? THEN 0 ELSE connected END,last_seen_at=? WHERE id=?",
            String(data.state),
            Number(terminal),
            this.w.now(),
            source.runtime_id,
          );
          if (terminal) {
            this.managed.invalidate(source.runtime_id);
            this.w.run(
              "UPDATE session_runtimes SET termination=?,fenced=1 WHERE id=?",
              data.termination === "confirmed" ? "confirmed" : "unknown",
              source.runtime_id,
            );
          }
        }
      }
    }
    this.w.run("UPDATE transcript_sources SET cursor=cursor+? WHERE id=?", added, sourceId);
    return { source_id: sourceId, added, last_sequence: sequence, cursor: source.cursor + added };
  }
  attachAsset(
    session: string,
    source: string | null,
    blob: { hash: string; byteLength: number },
    media: string,
    name: string | null,
  ) {
    this.w.sessions.get(session);
    const id = `asset-${digest(`${session}\0${source ?? ""}\0${blob.hash}\0${media}\0${name ?? ""}`).slice(0, 32)}`;
    this.w.run(
      "INSERT OR IGNORE INTO blobs VALUES(?,?,?)",
      blob.hash,
      blob.byteLength,
      this.w.now(),
    );
    this.w.run(
      "INSERT OR IGNORE INTO session_assets VALUES(?,?,?,?,?,?,?,?)",
      id,
      session,
      source,
      blob.hash,
      media,
      blob.byteLength,
      name,
      this.w.now(),
    );
    return this.w.one<{
      id: string;
      session_id: string;
      blob_hash: string;
      media_type: string;
      name: string | null;
    }>("SELECT * FROM session_assets WHERE id=?", id)!;
  }
  issueCredential(
    machine: string,
    label: string,
    scopes: MachineScope[] = ["read", "send"],
    token = secret(),
  ) {
    this.machine(machine);
    machineScopes.parse(scopes);
    const id = uid("tower-key");
    this.w.run(
      "INSERT INTO tower_credentials(id,machine_id,hash,label,created_at,revoked_at,scopes) VALUES(?,?,?,?,?,NULL,?)",
      id,
      machine,
      hash(token),
      label,
      this.w.now(),
      JSON.stringify(scopes),
    );
    return { id, machine_id: machine, access_key: token, scopes };
  }
  authenticate(token: string) {
    return this.w.one<{ id: string; machine_id: string; scopes: string }>(
      "SELECT id,machine_id,scopes FROM tower_credentials c WHERE hash=? AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM tower_enrollments e WHERE e.credential_id=c.id AND e.state!='confirmed' AND e.expires_at<=?)",
      hash(token),
      this.w.now(),
    );
  }
  revokeCredential(id: string) {
    this.w.run("UPDATE tower_credentials SET revoked_at=? WHERE id=?", this.w.now(), id);
  }
}
