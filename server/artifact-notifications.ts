import type { ArtifactDelivery, ArtifactNotificationSource } from "../shared/artifact-delivery.ts";
import { AppError, can, type Principal, type SessionCommand } from "../shared/contracts.ts";
import type { Artifacts } from "./artifacts.ts";
import { artifactNudgeText } from "./r3/shared/artifact-prompt.ts";
import type { ArtifactActor, ArtifactNudge, ArtifactWatcher } from "./r3/shared/artifacts.ts";
import type { WorkerSubscription } from "./r3/shared/worker-protocol.ts";
import { digest, uid, type Workspace } from "./workspace.ts";
export class ArtifactNotifications {
  constructor(
    private w: Workspace,
    private artifacts: Artifacts,
  ) {}
  subscribe(
    id: string,
    actor: ArtifactActor,
    p: Principal,
    mode: "explicit" | "fallback",
    key: string,
  ) {
    if (actor.role !== "agent")
      throw new AppError("agent_required", "Notification subscriptions require an agent session");
    if (!can(p, "sessions:control") || !can(p, "artifacts:read"))
      throw new AppError(
        "forbidden",
        "Subscriptions need artifact read and session control access",
        403,
      );
    this.artifacts.store.requireActive(id);
    const subscription: WorkerSubscription = {
      id: `subscription-${digest(`${p.id}\0${id}\0${key}`).slice(0, 32)}`,
      artifactId: id,
      listenerId: actor.sessionId,
      actor,
      mode,
    };
    this.artifacts.workers.retire(id, mode, null, subscription.id);
    this.artifacts.workers.save(`session:${actor.sessionId}`, p.id, subscription);
    this.cancelRetired(id);
    return subscription;
  }
  unlisten(id: string, actor: ArtifactActor) {
    if (actor.role !== "agent")
      throw new AppError("agent_required", "Subscriptions belong to agent sessions");
    this.artifacts.workers.retire(id, null, actor);
    this.cancelRetired(id);
    return { unsubscribed: true };
  }
  private cancelRetired(id: string) {
    this.w.run(
      "UPDATE session_commands SET state='failed',result=?,updated_at=? WHERE state='queued' AND id IN (SELECT command_id FROM artifact_notifications WHERE artifact_id=? AND event='submitted' AND registration_id IN (SELECT id FROM worker_registrations WHERE state='retired'))",
      JSON.stringify({ code: "subscription_retired" }),
      this.w.now(),
      id,
    );
    this.w.run(
      "UPDATE artifact_notifications SET state='failed',error='Subscription retired',updated_at=? WHERE artifact_id=? AND state='queued' AND event='submitted' AND registration_id IN (SELECT id FROM worker_registrations WHERE state='retired')",
      this.w.now(),
      id,
    );
  }
  selected(id: string) {
    const row = this.w.one<{ id: string }>(
      "SELECT id FROM worker_registrations WHERE artifact_id=? AND state!='retired' ORDER BY json_extract(body,'$.mode')='explicit' DESC,rowid DESC LIMIT 1",
      id,
    );
    return row ? this.artifacts.workers.get(row.id) : null;
  }
  authorized(principal: string) {
    if (principal === "owner") return true;
    return !!this.w.one(
      "SELECT 1 FROM oauth_tokens t JOIN oauth_clients c ON c.id=t.client_id WHERE c.id=? AND c.revoked=0 AND t.revoked=0 AND (t.expires>? OR t.refresh_hash IS NOT NULL AND t.refresh_expires>?) AND (EXISTS(SELECT 1 FROM json_each(t.scopes) WHERE value='admin') OR (EXISTS(SELECT 1 FROM json_each(t.scopes) WHERE value='artifacts:read') AND EXISTS(SELECT 1 FROM json_each(t.scopes) WHERE value='sessions:control'))) LIMIT 1",
      principal,
      this.w.now(),
      this.w.now(),
    );
  }
  target(sessionId: string) {
    const session = this.w.sessions.get(sessionId),
      runtime = this.w.executions.runtime(sessionId);
    if (
      runtime?.tower_session_id &&
      runtime.connected &&
      !runtime.fenced &&
      !runtime.stop_requested &&
      !["ended", "error"].includes(runtime.state) &&
      this.w.executions.machine(runtime.machine_id).connected
    )
      return {
        kind: "managed" as const,
        machine_id: runtime.machine_id,
        tower_id: runtime.tower_session_id,
        runtime_id: runtime.id,
        generation: runtime.generation,
      };
    // A managed binding cannot silently become a generic message destination.
    if (runtime) return null;
    const native =
      session.native_session_id ?? session.id.replace(/^(codex|claude|antigravity):/, "");
    const matches = this.w
      .all<{ machine_id: string; tower_id: string; record: string }>(
        "SELECT r.* FROM tower_records r JOIN machines m ON m.id=r.machine_id WHERE m.connected=1",
      )
      .filter((r) => {
        if (
          this.w.one(
            "SELECT 1 FROM session_runtimes WHERE machine_id=? AND tower_session_id=?",
            r.machine_id,
            r.tower_id,
          )
        )
          return false;
        const data = JSON.parse(r.record);
        return (
          data.native_session_id === native &&
          (!session.agent_type ||
            session.agent_type === "unknown" ||
            data.harness === session.agent_type) &&
          !["exited", "lost"].includes(data.status) &&
          data.caps?.message !== "none"
        );
      });
    return matches.length === 1
      ? {
          kind: "message" as const,
          machine_id: matches[0].machine_id,
          tower_id: matches[0].tower_id,
        }
      : null;
  }
  dispatchError(command: SessionCommand): string | null {
    if ((command.payload.source as { kind?: string } | undefined)?.kind !== "artifact_notification")
      return null;
    const n = this.w.one<{ registration_id: string; session_id: string }>(
      "SELECT registration_id,session_id FROM artifact_notifications WHERE command_id=?",
      command.id,
    );
    if (!n) return "Notification no longer exists";
    const record = this.artifacts.workers.get(n.registration_id);
    if (!record || !this.authorized(record.principal))
      return "Notification subscription access expired or was revoked";
    if (
      record.state === "retired" ||
      this.selected(record.subscription.artifactId)?.subscription.id !== n.registration_id
    )
      return "Notification subscription was retired or replaced";
    const runtime = this.w.executions.runtime(n.session_id);
    if (
      !runtime ||
      runtime.id !== command.runtime_id ||
      runtime.fenced ||
      runtime.stop_requested ||
      ["ended", "error"].includes(runtime.state)
    )
      return "Notification execution ended or changed";
    return null;
  }
  failQueued(commandId: string, reason: string) {
    this.w.run(
      "UPDATE session_commands SET state='failed',result=?,updated_at=? WHERE id=? AND state='queued'",
      JSON.stringify({ code: "notification_cancelled", message: reason }),
      this.w.now(),
      commandId,
    );
  }
  cancelQueued(artifactId: string, reason: string) {
    for (const n of this.w.all<{ command_id: string }>(
      "SELECT command_id FROM artifact_notifications WHERE artifact_id=? AND command_id IS NOT NULL",
      artifactId,
    ))
      this.failQueued(n.command_id, reason);
  }
  rejectConsent(machineId: string) {
    for (const n of this.w.all<{ command_id: string }>(
      "SELECT n.command_id FROM artifact_notifications n JOIN session_commands c ON c.id=n.command_id WHERE n.machine_id=? AND c.state='queued'",
      machineId,
    ))
      this.failQueued(n.command_id, "Machine enrollment does not grant acp:control");
  }
  refresh() {
    let changed = false;
    for (const row of this.w.all<{
      id: string;
      command_id: string;
      state: string;
      receipt: string | null;
      error: string | null;
    }>(
      "SELECT n.id,n.command_id,n.state,n.receipt,n.error FROM artifact_notifications n JOIN session_commands c ON c.id=n.command_id WHERE c.state IN ('queued','sent','unknown') OR n.state IN ('queued','sending','unknown') OR n.receipt IS NOT c.result",
    )) {
      let command = this.w.executions.command(row.command_id);
      if (command.state === "queued") {
        const reason =
          this.dispatchError(command) ??
          (!this.w.executions.managed.authority(command.id)
            ? "Notification control authority expired or was revoked"
            : null);
        if (reason) {
          this.failQueued(command.id, reason);
          command = this.w.executions.command(command.id);
        }
      }
      const receipt = command.result as {
        state?: string;
        acceptance?: { level?: string };
        error?: { code?: string };
        code?: string;
        message?: string;
        cancelled?: boolean;
      } | null;
      const accepted =
        receipt?.state === "accepted" &&
        ["adapter", "harness"].includes(receipt.acceptance?.level ?? "");
      const state = accepted
        ? "sent"
        : command.state === "queued"
          ? "queued"
          : command.state === "sent"
            ? "sending"
            : command.state === "failed"
              ? "failed"
              : "unknown";
      const error =
        state === "failed"
          ? (receipt?.message ??
            receipt?.error?.code ??
            receipt?.code ??
            (receipt?.cancelled ? "Prompt cancelled before dispatch" : "Prompt was rejected"))
          : state === "unknown"
            ? "Managed prompt acceptance is unknown; it will not be resent"
            : null;
      const encoded = command.result === null ? null : JSON.stringify(command.result);
      if (row.state !== state || row.receipt !== encoded || row.error !== error) {
        this.w.run(
          "UPDATE artifact_notifications SET state=?,receipt=?,error=?,updated_at=? WHERE id=?",
          state,
          encoded,
          error,
          this.w.now(),
          row.id,
        );
        changed = true;
      }
    }
    return changed;
  }
  watchers(id: string): ArtifactWatcher[] {
    this.artifacts.store.get(id);
    const selected = this.selected(id);
    if (!selected) return [];
    const s = selected.subscription,
      sessionId = s.actor.sessionId;
    if (!sessionId) return [];
    const allowed = this.authorized(selected.principal),
      target = allowed ? this.target(sessionId) : null,
      last = this.w.one<{ state: string; error: string | null }>(
        "SELECT state,error FROM artifact_notifications WHERE registration_id=? ORDER BY rowid DESC LIMIT 1",
        s.id,
      ),
      failed = last && ["failed", "unknown"].includes(last.state);
    return [
      {
        id: s.id,
        kind: "listen",
        actor: s.actor,
        mode: s.mode,
        listenerId: s.listenerId,
        connectedAt: this.w.now(),
        label: this.w.sessions.get(sessionId).label,
        connectionState: !allowed || failed ? "failed" : target ? "connected" : "disconnected",
        error: failed
          ? last.error
          : !allowed
            ? "Connection access expired or was revoked"
            : target
              ? null
              : "No unique active Tower session matches this declared session",
      },
    ];
  }
  latest(id: string, notificationId?: string): ArtifactDelivery | null {
    const row = this.w.one<{
      id: string;
      event: "submitted" | "archived";
      state: string;
      receipt: string | null;
      error: string | null;
      updated_at: string;
      route: "message" | "managed";
      command_id: string | null;
    }>(
      "SELECT id,event,state,receipt,error,updated_at,route,command_id FROM artifact_notifications WHERE artifact_id=? AND (? IS NULL OR id=?) ORDER BY rowid DESC LIMIT 1",
      id,
      notificationId ?? null,
      notificationId ?? null,
    );
    if (!row) return null;
    if (row.route === "managed" && row.command_id) {
      const receipt = row.receipt ? JSON.parse(row.receipt) : null;
      const level = receipt?.acceptance?.level;
      const acknowledgement =
        receipt?.state === "accepted" && (level === "adapter" || level === "harness")
          ? level
          : null;
      const ended = this.w.one<{ payload: string }>(
        "SELECT payload FROM session_events WHERE command_id=? AND kind='turn_end' ORDER BY sequence DESC LIMIT 1",
        row.command_id,
      );
      const reason = ended ? JSON.parse(ended.payload).stop_reason : null;
      const turn_state = ended
        ? reason === "cancelled"
          ? "cancelled"
          : reason === "error"
            ? "failed"
            : "completed"
        : null;
      const dispatch_state = receipt?.dispatch?.state ?? null;
      let message =
        row.state === "queued"
          ? "Managed prompt queued. The runtime owner has not accepted it yet."
          : row.state === "sending"
            ? "Submitted for managed prompt admission. Acceptance is not yet confirmed."
            : row.state === "unknown"
              ? "Managed prompt acceptance is unknown. It will not be resent automatically."
              : row.state === "failed"
                ? `Managed notification failed: ${row.error ?? "prompt rejected"}.`
                : acknowledgement === "adapter"
                  ? "The runtime adapter accepted the notification prompt. Harness acceptance and model processing are unconfirmed."
                  : "The harness acknowledged the notification prompt. Model processing is unconfirmed.";
      if (dispatch_state) message += ` Dispatch: ${dispatch_state}.`;
      if (receipt?.error)
        message += ` The adapter reported ${receipt.error.code}; partial effects ${receipt.error.may_have_effect ? "are possible" : "were not reported"}.`;
      if (turn_state)
        message += ` The correlated turn ${turn_state === "completed" ? "ended" : turn_state}. This does not establish review or task completion.`;
      return {
        id: row.id,
        event: row.event,
        state: row.state,
        acknowledgement,
        route: "managed",
        command_id: row.command_id,
        dispatch_state,
        turn_state,
        message,
        updated_at: row.updated_at,
      };
    }
    const receipt = row.receipt ? JSON.parse(row.receipt) : null,
      level = receipt?.acknowledgement;
    const acknowledgement =
      level === "harness" || level === "transport" || level === "pty_submission" ? level : null;
    const message =
      row.state === "queued"
        ? "Notification queued; no delivery acknowledgment yet."
        : row.state === "sending"
          ? "Waiting for Tower’s delivery acknowledgment."
          : row.state === "unknown"
            ? "Delivery is uncertain. This notification will not be resent automatically."
            : row.state === "failed"
              ? `Notification failed: ${row.error ?? "delivery was rejected"}`
              : acknowledgement === "harness"
                ? "The harness acknowledged the notification. Model processing is unconfirmed."
                : acknowledgement === "transport"
                  ? "Transport write completed. The agent may hold or refuse the notification. Agent acceptance and model processing are unconfirmed."
                  : acknowledgement === "pty_submission"
                    ? "Submitted to the terminal. Harness acceptance and model processing are unconfirmed."
                    : "Delivery was reported without an acknowledgment level. Agent acceptance and model processing are unconfirmed.";
    return {
      id: row.id,
      event: row.event,
      state: row.state,
      acknowledgement,
      route: "message",
      command_id: null,
      dispatch_state: null,
      turn_state: null,
      message,
      updated_at: row.updated_at,
    };
  }
  async deliverArchive(
    id: string,
    lifecycle: { id: string; comment: { id: string; body: string } | null },
    principal: Principal,
    context: Record<string, unknown>,
  ) {
    const selected = this.selected(id);
    if (!selected) return { state: "none" };
    if (
      selected.subscription.actor.role !== "agent" ||
      !this.target(selected.subscription.actor.sessionId)
    )
      throw new AppError(
        "notification_offline",
        "The selected agent is offline. The artifact remains active.",
        409,
      );
    this.w.recordNotification(
      {
        ...context,
        artifact_id: id,
        registration_id: selected.subscription.id,
        event: "archived",
        lifecycle,
        operation_key: `archive-notification:${lifecycle.id}:${selected.subscription.id}`,
      },
      principal,
      () => this.enqueue(id, "archived", lifecycle),
    );
    this.w.onChange();
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      this.refresh();
      const row = this.w.one<{ id: string; state: string; error: string | null }>(
        "SELECT id,state,error FROM artifact_notifications WHERE artifact_id=? AND registration_id=? AND fingerprint=? AND event='archived'",
        id,
        selected.subscription.id,
        lifecycle.id,
      );
      if (row?.state === "sent") {
        if (this.selected(id)?.subscription.id !== selected.subscription.id)
          throw new AppError(
            "subscription_changed",
            "The recipient changed during delivery; the artifact remains active",
            409,
          );
        const delivery = this.latest(id, row.id);
        return { state: "sent", acknowledgement: delivery?.acknowledgement ?? null, delivery };
      }
      if (!row || ["unknown", "failed"].includes(row.state))
        throw new AppError(
          "notification_failed",
          row?.error ?? "Archive notification failed; the artifact remains active",
          409,
        );
      await Bun.sleep(50);
    }
    const pending = this.w.one<{ command_id: string | null }>(
      "SELECT command_id FROM artifact_notifications WHERE artifact_id=? AND registration_id=? AND fingerprint=?",
      id,
      selected.subscription.id,
      lifecycle.id,
    );
    if (pending?.command_id) {
      this.failQueued(pending.command_id, "Archive notification timed out before dispatch");
      this.w.run(
        "UPDATE session_commands SET state='unknown',updated_at=? WHERE id=? AND state='sent'",
        this.w.now(),
        pending.command_id,
      );
      this.refresh();
    }
    this.w.run(
      "UPDATE artifact_notifications SET state=CASE WHEN state='queued' THEN 'failed' ELSE 'unknown' END,error='Archive notification timed out' WHERE artifact_id=? AND registration_id=? AND fingerprint=? AND state IN ('queued','sending')",
      id,
      selected.subscription.id,
      lifecycle.id,
    );
    throw new AppError(
      "notification_failed",
      "Archive notification timed out; the artifact remains active",
      409,
    );
  }
  enqueue(
    id: string,
    event: "submitted" | "archived",
    lifecycle?: { id: string; comment: { id: string; body: string } | null },
  ) {
    const artifact = this.artifacts.store.get(id);
    if (event === "submitted" && !this.artifacts.conversations.hasPending(id))
      return { state: "none" as const };
    const selected = this.selected(id);
    if (!selected || selected.subscription.actor.role !== "agent")
      return { state: "none" as const };
    if (!this.authorized(selected.principal))
      throw new AppError(
        "notification_access",
        "The selected notification connection has expired or was revoked",
        409,
      );
    const fingerprint =
        event === "archived"
          ? String(lifecycle?.id)
          : this.artifacts.conversations.snapshot(id).acknowledgment.expectedFingerprint,
      subscription = selected.subscription;
    const old = this.w.one<{
      state: string;
      error: string | null;
      route: string;
      command_id: string | null;
    }>(
      "SELECT state,error,route,command_id FROM artifact_notifications WHERE artifact_id=? AND registration_id=? AND fingerprint=? AND event=?",
      id,
      subscription.id,
      fingerprint,
      event,
    );
    if (old) {
      if (["unknown", "failed"].includes(old.state))
        throw new AppError(
          "notification_failed",
          old.error ??
            "Previous notification acceptance is unknown; inspect its delivery before sending again",
          409,
        );
      return {
        state: old.state === "sent" ? ("sent" as const) : ("queued" as const),
        repeated: true,
        route: old.route,
        command_id: old.command_id,
      };
    }
    const notification = uid("notification"),
      nudge: ArtifactNudge = {
        id: notification,
        artifactId: id,
        title: artifact.title,
        event,
        lifecycleEventId: lifecycle?.id ?? null,
        comment: lifecycle?.comment
          ? { id: lifecycle.comment.id, body: lifecycle.comment.body }
          : null,
      };
    const runtime = this.w.executions.runtime(subscription.actor.sessionId!);
    const body = artifactNudgeText(nudge);
    this.w.run(
      "INSERT INTO artifact_notifications(id,artifact_id,registration_id,session_id,fingerprint,event,body,state,created_at,updated_at,envelope,route) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?)",
      notification,
      id,
      subscription.id,
      subscription.actor.sessionId,
      fingerprint,
      event,
      body,
      this.w.now(),
      this.w.now(),
      JSON.stringify(nudge),
      runtime ? "managed" : "message",
    );
    let commandId: string | null = null;
    if (runtime) {
      const source: ArtifactNotificationSource = {
        kind: "artifact_notification",
        notification_id: notification,
        artifact_id: id,
        registration_id: subscription.id,
        event,
        fingerprint,
        lifecycle_event_id: lifecycle?.id ?? null,
        comment_id: lifecycle?.comment?.id ?? null,
      };
      const command = this.w.executions.queueNotification(runtime, body, source);
      commandId = command.id;
      this.w.run(
        "UPDATE artifact_notifications SET command_id=?,machine_id=?,tower_id=? WHERE id=?",
        command.id,
        runtime.machine_id,
        runtime.tower_session_id,
        notification,
      );
    }
    return {
      state: "queued" as const,
      command_id: commandId,
      route: runtime ? "managed" : "message",
    };
  }
}
