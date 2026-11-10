import type { ArtifactDelivery } from "../shared/artifact-delivery.ts";
import { ArtifactError } from "../shared/artifact-validation.ts";
import {
  type ArtifactActor,
  type ArtifactCommentAcknowledgment,
  type ArtifactDetail,
  artifactAgentIds,
} from "../shared/artifacts.ts";
import { AppError, can, type Operation, operations, type Principal } from "../shared/contracts.ts";
import { ArtifactConversations } from "./artifact-conversations.ts";
import { renderArtifactDocument } from "./artifact-document.ts";
import { ArtifactLifecycle } from "./artifact-lifecycle.ts";
import { ArtifactNotifications } from "./artifact-notifications.ts";
import { ArtifactSearch } from "./artifact-search.ts";
import { type ArtifactCommit, ArtifactStore } from "./artifact-store.ts";
import { ArtifactUsageStore } from "./artifact-usage.ts";
import type { BlobStore } from "./blobs.ts";
import { PreviewHost } from "./preview-host.ts";
import { previewSupport } from "./preview-support.ts";
import { WorkerRecords } from "./worker-records.ts";
import type { Workspace } from "./workspace.ts";

type Input = Record<string, unknown>;
export class Artifacts {
  readonly store: ArtifactStore;
  readonly conversations: ArtifactConversations;
  readonly lifecycle: ArtifactLifecycle;
  readonly search: ArtifactSearch;
  readonly usage: ArtifactUsageStore;
  readonly workers: WorkerRecords;
  readonly previews: PreviewHost;
  readonly notifications: ArtifactNotifications;
  constructor(
    private w: Workspace,
    readonly blobs: BlobStore,
  ) {
    const db = w.db,
      clock = () => w.now();
    this.workers = new WorkerRecords(db);
    this.store = new ArtifactStore(
      db,
      blobs,
      renderArtifactDocument,
      clock,
      (id) => !!this.notifications?.selected(id),
      this.workers,
      undefined,
      {
        artifact: (id) => !w.access.restricted || w.access.artifact(id),
        project: (id) => w.access.project(id),
        session: (id) => w.access.session(id),
      },
    );
    this.conversations = new ArtifactConversations(db, this.store, clock);
    this.lifecycle = new ArtifactLifecycle(db, this.store, clock, this.workers);
    this.search = new ArtifactSearch(db, this.store, this.conversations);
    this.usage = new ArtifactUsageStore(db, this.store, clock, 30, "UTC");
    this.previews = new PreviewHost(this.store, previewSupport);
    this.notifications = new ArtifactNotifications(w, this);
  }
  detail(id: string): ArtifactDetail & { delivery: ArtifactDelivery | null } {
    const detail: ArtifactDetail & { delivery: ArtifactDelivery | null } = {
      ...this.store.get(id),
      versions: this.store.versions(id),
      threads: this.conversations.list(id),
      placements: this.conversations.placements(id),
      events: this.lifecycle.events(id),
      delivery: this.notifications.latest(id),
    };
    detail.agentLabels = this.store.sessionLabels(artifactAgentIds(detail));
    return detail;
  }
  private actor(p: Principal, a: Input): ArtifactActor {
    const op = this.w.identify(p, a);
    if (op.kind === "user") return { role: "human", sessionId: null };
    if (!op.session_id)
      throw new AppError("session_required", "Artifact mutations by an agent require session_id");
    return { role: "agent", sessionId: op.session_id };
  }
  private register(value: unknown) {
    if (Array.isArray(value)) {
      for (const item of value) this.register(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const v = value as Input;
    const artifact =
      typeof v.artifactId === "string"
        ? v.artifactId
        : typeof v.id === "string" && "nextSeq" in v
          ? v.id
          : null;
    if (artifact) {
      const root = this.store.get(artifact);
      this.w.graph.ensure(root.id, "artifact", root.projectId);
      this.w.run("INSERT OR IGNORE INTO artifact_entities VALUES(?,?)", root.id, root.id);
      this.w.run(
        "UPDATE entities SET project_id=? WHERE id IN (SELECT entity_id FROM artifact_entities WHERE artifact_id=?)",
        root.projectId,
        root.id,
      );
      const id =
        "seq" in v && "publishedAt" in v
          ? `${artifact}@${v.seq}`
          : typeof v.id === "string"
            ? v.id
            : null;
      const kind =
        "seq" in v && "publishedAt" in v
          ? "artifact_version"
          : "comments" in v
            ? "artifact_thread"
            : "body" in v
              ? "artifact_comment"
              : id === root.id
                ? "artifact"
                : null;
      if (id && kind) {
        this.w.graph.ensure(id, kind, root.projectId);
        this.w.run("INSERT OR IGNORE INTO artifact_entities VALUES(?,?)", id, root.id);
      }
    }
    if (v.comments) this.register(v.comments);
    if (v.comment) this.register(v.comment);
    if (v.event && typeof v.event === "object") this.register(v.event);
  }
  private taskLink(a: Input, value: unknown, p: Principal) {
    if (!a.task_id) return;
    if (!can(p, "tasks:write") || !can(p, "tasks:read"))
      throw new AppError("forbidden", "Task evidence links require task read/write access", 403);
    this.w.task(String(a.task_id));
    const v = value as Input;
    const target = v.artifactId && v.seq ? `${v.artifactId}@${v.seq}` : String(v.id);
    this.w.graph.add("produces", String(a.task_id), target);
  }
  async run(name: Operation, input: unknown, p: Principal): Promise<unknown> {
    const definition = operations[name];
    if (!can(p, definition.scope))
      throw new AppError("forbidden", `Scope ${definition.scope} is required`, 403);
    const parsed = definition.schema.safeParse(input);
    if (!parsed.success)
      throw new AppError("invalid_input", "Invalid artifact request", 400, parsed.error.flatten());
    const a = parsed.data as Input;
    this.w.access.inputs(name, a);
    try {
      if (!definition.write) return await this.read(name, a);
      const actor = this.actor(p, a);
      if (a.task_id && (!can(p, "tasks:read") || !can(p, "tasks:write")))
        throw new AppError("forbidden", "Task evidence links require task read/write access", 403);
      if (
        name === "artifact_threads_edit" &&
        (a.input as Input).status !== undefined &&
        (p.inlet === "mcp" || !can(p, "admin"))
      )
        throw new AppError("forbidden", "Only the owner may resolve review threads", 403);
      let committed = false;
      const commit: ArtifactCommit = <T>(work: () => T): T => {
        if (committed) throw new Error("Artifact operation attempted multiple independent commits");
        const result = this.w.execute(name, input, p, () => {
          const result = work() ?? null;
          this.register(result);
          if (
            name === "artifacts_publish" &&
            p.inlet !== "mcp" &&
            a.listen !== false &&
            actor.role === "agent" &&
            can(p, "artifacts:notify") &&
            can(p, "artifacts:read")
          )
            this.notifications.subscribe(
              String(a.artifact_id),
              actor,
              p,
              "fallback",
              String(a.operation_key),
            );
          if (name === "artifacts_create" || name === "artifacts_publish")
            this.taskLink(a, result, p);
          return result;
        }) as T;
        committed = true;
        return result;
      };
      let value: unknown;
      if (name === "artifacts_archive") {
        const id = String(a.artifact_id),
          prepared = this.lifecycle.prepare(id, {
            actor,
            event: "archived",
            operationKey: a.operation_key,
            ...(a.comment ? { comment: { body: a.comment } } : {}),
          });
        const notification = prepared.notification
          ? await this.notifications.deliverArchive(
              id,
              {
                id: prepared.notification.lifecycleEventId,
                comment: prepared.notification.comment,
              },
              p,
              a,
            )
          : { state: "none" };
        value = commit(() => ({ ...prepared.commit(), notification }));
      } else if (
        [
          "artifacts_publish",
          "artifact_threads_add",
          "artifact_threads_edit",
          "artifact_comments_add",
          "artifact_comments_edit",
          "artifact_threads_reanchor",
        ].includes(name)
      ) {
        value = await this.asyncWrite(name, a, actor, commit);
        if (!committed) value = commit(() => value);
      } else {
        value = commit(() => this.write(name, a, actor, p));
      }
      if (name === "artifacts_delete") this.previews.revokeArtifact(String(a.artifact_id));
      if (name === "artifacts_gc" && !(a.input as Input).dryRun) await this.collectBlobs();
      return value;
    } catch (e) {
      if (e instanceof ArtifactError)
        throw new AppError(
          e.status === 409
            ? "artifact_conflict"
            : e.status === 404
              ? "not_found"
              : "invalid_artifact",
          e.message,
          e.status,
        );
      throw e;
    }
  }
  private read(name: Operation, a: Input): unknown {
    const id = String(a.artifact_id);
    if (name === "artifacts_list")
      return this.w.page(
        this.store.list({
          state: a.state as "active" | "archived" | undefined,
          kind: a.kind as "files" | "html" | "diff" | undefined,
          projectIds: this.w.projectScope(a) ?? undefined,
          meta: a.meta as Record<string, string> | undefined,
        }),
        a,
      );
    if (name === "artifacts_get") return this.detail(id);
    if (name === "artifacts_files") return this.store.files(id, Number(a.version_seq));
    if (name === "artifacts_read_file")
      return this.readLines(
        id,
        Number(a.version_seq),
        String(a.path),
        Number(a.start_line),
        Number(a.limit),
      );
    if (name === "artifact_comments_get") return this.conversations.comment(String(a.comment_id));
    if (name === "artifact_comments_fetch")
      return this.conversations.snapshot(id, a.threads as string[] | undefined);
    if (name === "artifacts_watchers") return this.notifications.watchers(id);
    if (name === "artifacts_viewed") return this.store.viewed(id);
    if (name === "artifacts_usage") {
      this.w.access.require(this.w.access.global());
      return this.usage.stat(a.window as "daily" | "weekly");
    }
    if (name === "artifacts_search")
      return this.search.search({
        q: String(a.query),
        projects: this.w.projectScope(a) ?? undefined,
        kind: a.kind as "files" | "html" | "diff" | undefined,
        state: a.state as "active" | "archived" | undefined,
        history: a.history as "latest" | "all",
        type: a.type as "all" | "content" | "conversation",
        attention: !!a.attention,
        offset: Number(a.cursor),
        limit: Number(a.limit),
      });
    throw new AppError("not_found", "Unknown artifact query", 404);
  }
  private async readLines(id: string, seq: number, path: string, start: number, limit: number) {
    const file = this.store.file(id, seq, path);
    if (file.byteLength > 4 * 1024 * 1024)
      throw new AppError("source_limit", "Use the CLI download command for files over 4 MiB", 413);
    const bytes = await this.store.readFile(id, seq, path);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AppError("binary_file", "This file is not UTF-8 text; download its original bytes");
    }
    const lines = content.split("\n");
    return {
      path,
      version_seq: seq,
      start_line: start,
      total_lines: lines.length,
      lines: lines.slice(start - 1, start - 1 + limit),
    };
  }
  private asyncWrite(name: Operation, a: Input, actor: ArtifactActor, commit: ArtifactCommit) {
    const input = { ...((a.input as Input) ?? {}), actor, operationKey: a.operation_key };
    switch (name) {
      case "artifacts_publish":
        return this.store.publish(
          String(a.artifact_id),
          {
            actor,
            expectedSeq: a.expected_seq,
            publicationKey: a.operation_key,
            content: a.content,
            label: a.label,
            summary: a.summary,
            provenance: a.provenance,
          },
          commit,
        );
      case "artifact_threads_add":
        return this.conversations.add(String(a.artifact_id), input, commit);
      case "artifact_threads_edit":
        return this.conversations.update(String(a.thread_id), input, commit);
      case "artifact_comments_add":
        return this.conversations.addComment(String(a.thread_id), input, commit);
      case "artifact_comments_edit":
        return this.conversations.updateComment(String(a.comment_id), input, commit);
      case "artifact_threads_reanchor":
        return this.conversations.anchors.reanchor(String(a.artifact_id), input, commit);
      default:
        throw new AppError("not_found", "Unknown asynchronous artifact mutation", 404);
    }
  }
  private write(name: Operation, a: Input, actor: ArtifactActor, p: Principal): unknown {
    const id = String(a.artifact_id);
    switch (name) {
      case "artifacts_create":
        return this.store.create({
          kind: a.kind,
          title: a.title,
          meta: a.meta,
          actor,
          projectId: this.w.access.initialProject(a),
          remoteUrl: a.remote_url,
        });
      case "artifacts_edit":
        return this.store.edit(id, a.input);
      case "artifacts_delete":
        this.notifications.cancelQueued(id, "Artifact deleted before notification dispatch");
        this.store.delete(id);
        return { deleted: true, id };
      case "artifacts_restore":
        return {
          ...this.lifecycle
            .prepare(id, {
              actor,
              event: "restored",
              operationKey: a.operation_key,
            })
            .commit(),
          notification: { state: "none" },
        };
      case "artifacts_listen":
        return this.notifications.subscribe(
          id,
          actor,
          p,
          a.mode as "explicit" | "fallback",
          String(a.operation_key),
        );
      case "artifacts_unlisten":
        return this.notifications.unlisten(id, actor);
      case "artifacts_submit":
        return { notification: this.notifications.enqueue(id, "submitted") };
      case "artifact_threads_delete":
        this.conversations.delete(String(a.thread_id), actor);
        return { deleted: true, id: a.thread_id };
      case "artifact_threads_claim":
        if (actor.role !== "agent")
          throw new AppError("agent_required", "Review claims belong to agent sessions");
        return this.conversations.claim(a.thread_ids as string[], actor.sessionId);
      case "artifact_threads_release":
        if (actor.role !== "agent")
          throw new AppError("agent_required", "Review claims belong to agent sessions");
        this.conversations.release(a.thread_ids as string[], actor.sessionId);
        return { released: a.thread_ids };
      case "artifact_comments_ack":
        return this.conversations.acknowledge(
          id,
          a.receipt as unknown as ArtifactCommentAcknowledgment,
        );
      case "artifacts_gc":
        return this.usage.gc(a.input);
      case "artifacts_mark_viewed":
        this.store.setViewed(id, a.input);
        return { updated: true };
      default:
        throw new AppError("not_found", "Unknown artifact mutation", 404);
    }
  }
  async collectBlobs() {
    return this.blobs.collect(() => {
      const roots = `SELECT blob_hash hash FROM version_files UNION SELECT rendered_blob_hash FROM version_files WHERE rendered_blob_hash IS NOT NULL UNION SELECT blob_hash FROM message_attachments UNION SELECT blob_hash FROM thread_anchor_frames UNION SELECT blob_hash FROM session_assets`;
      const live = new Set(this.w.all<{ hash: string }>(roots).map((r) => r.hash));
      this.w.run(`DELETE FROM blobs WHERE hash NOT IN (${roots})`);
      return live;
    });
  }
}
