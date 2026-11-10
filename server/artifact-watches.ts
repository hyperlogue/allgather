import { randomUUID } from "node:crypto";
import type { ArtifactActor, ArtifactWatcher, ArtifactWatchResult } from "../shared/artifacts.ts";
import { AppError, can, type Principal } from "../shared/contracts.ts";
import type { Artifacts } from "./artifacts.ts";
import type { Workspace } from "./workspace.ts";

export interface ArtifactWatch {
  info: ArtifactWatcher;
  result: Promise<ArtifactWatchResult>;
  finish: (result: ArtifactWatchResult) => void;
}
export class ArtifactWatches {
  private active = new Map<string, ArtifactWatch>();
  constructor(
    private w: Workspace,
    private artifacts: Artifacts,
  ) {}
  close() {
    for (const watch of this.active.values()) watch.finish({ result: "cancelled" });
  }
  current(id: string) {
    return this.active.get(id);
  }
  terminal(id: string): ArtifactWatchResult | null {
    if (!this.w.one("SELECT 1 FROM artifacts WHERE id=?", id)) return { result: "deleted" };
    if (this.artifacts.store.get(id).state === "archived")
      return {
        result: "archived",
        event: this.artifacts.lifecycle.events(id).findLast((e) => e.event === "archived") ?? null,
      };
    return null;
  }
  open(
    id: string,
    principal: Principal,
    metadata: Record<string, unknown>,
    timeoutMs: number,
  ): ArtifactWatch {
    if (!can(principal, "artifacts:read") || !can(principal, "artifacts:notify"))
      throw new AppError("forbidden", "Watch requires artifact read and notification access", 403);
    this.w.access.require(this.w.access.artifact(id));
    this.artifacts.store.get(id);
    const operator = this.w.identify(principal, metadata);
    if (operator.session_id) this.w.access.require(this.w.access.session(operator.session_id));
    const actor: ArtifactActor =
      operator.kind === "user"
        ? { role: "human", sessionId: null }
        : { role: "agent", sessionId: operator.session_id ?? `watch:${randomUUID()}` };
    let resolve!: (value: ArtifactWatchResult) => void;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch: ArtifactWatch = {
      info: {
        id: randomUUID(),
        kind: "watch",
        mode: "explicit",
        actor,
        connectedAt: this.w.now(),
        connectionState: "connected",
      },
      result: new Promise((done) => {
        resolve = done;
      }),
      finish: (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.active.get(id) === watch) this.active.delete(id);
        resolve(result);
        this.w.onChange();
      },
    };
    const terminal = this.terminal(id);
    if (terminal) {
      watch.finish(terminal);
      return watch;
    }
    const old = this.active.get(id);
    this.active.set(id, watch);
    try {
      this.w.recordArtifactWatch(
        { ...metadata, artifact_id: id, operation_key: watch.info.id },
        principal,
        () => {
          this.artifacts.workers.retire(id, "explicit");
          this.artifacts.notifications.cancelQueued(
            id,
            "An explicit watch replaced the notification recipient",
          );
          this.w.run(
            "UPDATE artifact_notifications SET state='failed',error='An explicit watch replaced the notification recipient' WHERE artifact_id=? AND state='queued' AND command_id IS NULL",
            id,
          );
          return watch.info;
        },
      );
    } catch (error) {
      if (old) this.active.set(id, old);
      else this.active.delete(id);
      throw error;
    }
    old?.finish({ result: "superseded" });
    if (timeoutMs)
      timer = setTimeout(() => watch.finish(this.terminal(id) ?? { result: "timeout" }), timeoutMs);
    if (this.artifacts.conversations.hasPending(id)) watch.finish({ result: "comments" });
    return watch;
  }
  changed(name: string, input: Record<string, unknown>, actor: ArtifactActor) {
    const id = String(input.artifact_id),
      watch = this.current(id);
    if (!watch) return;
    const terminal = this.terminal(id);
    if (terminal) {
      watch.finish(terminal);
      return;
    }
    if (name === "artifacts_listen" && input.mode === "explicit")
      watch.finish({ result: "superseded" });
    else if (
      name === "artifacts_unlisten" &&
      actor.role === watch.info.actor.role &&
      actor.sessionId === watch.info.actor.sessionId
    )
      watch.finish({ result: "cancelled" });
    else if (name === "artifacts_submit" && this.artifacts.conversations.hasPending(id))
      watch.finish({ result: "comments" });
  }
}
