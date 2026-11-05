import { AppError, can, type Principal, type Relation } from "../shared/contracts.ts";
import { uid, type Workspace } from "./workspace.ts";
export interface Entity {
  id: string;
  kind: string;
  project_id: string | null;
  deleted_at?: string | null;
  label?: string | null;
}
export const commitEntityId = (repository: string, commit: string) =>
  `commit:${repository}:${commit}`;
export function commitReference(id: string) {
  const m = /^commit:([^:]+):([a-f0-9]{40}|[a-f0-9]{64})$/.exec(id);
  return m ? { repository_id: m[1], commit_id: m[2] } : null;
}
export class Graph {
  constructor(private w: Workspace) {}
  entity(id: string): Entity {
    const e = this.w.one<Entity>("SELECT * FROM entities WHERE id=?", id);
    if (e) {
      if (e.kind === "session_event") {
        const body = this.w.one<{ deleted_at: string | null }>(
          "SELECT deleted_at FROM session_event_content WHERE id=?",
          id,
        );
        if (body?.deleted_at)
          return { ...e, deleted_at: body.deleted_at, label: "Captured session event" };
      }
      return e;
    }
    const ref = commitReference(id);
    if (
      ref &&
      this.w.one(
        "SELECT 1 FROM commits WHERE repository_id=? AND id=?",
        ref.repository_id,
        ref.commit_id,
      )
    )
      return { id, kind: "commit", project_id: null };
    throw new AppError("not_found", "Entity not found", 404);
  }
  ensure(id: string, kind?: string, projectId: string | null = null): Entity {
    const e = this.w.one<Entity>("SELECT * FROM entities WHERE id=?", id);
    if (e) {
      if (e.deleted_at) throw new AppError("entity_deleted", "This identity was deleted", 410);
      if (kind && e.kind !== kind)
        throw new AppError("identity_conflict", "This ID belongs to another entity kind", 409);
      return e;
    }
    if (!kind) return this.entity(id);
    this.w.run("INSERT INTO entities(id,kind,project_id) VALUES(?,?,?)", id, kind, projectId);
    return { id, kind, project_id: projectId };
  }
  retire(id: string, label: string) {
    this.w.run(
      "UPDATE entities SET deleted_at=COALESCE(deleted_at,?),label=COALESCE(label,?) WHERE id=?",
      this.w.now(),
      label,
      id,
    );
  }
  commit(repositoryId: string, hash: string) {
    this.w.history.repository(repositoryId);
    const id = commitEntityId(repositoryId, hash);
    this.w.run("INSERT OR IGNORE INTO commit_references VALUES(?,?,?)", id, repositoryId, hash);
    return this.ensure(id, "commit");
  }
  canRead(e: Entity, p: Principal) {
    return (
      this.w.access.entity(e.id) &&
      can(
        p,
        e.kind === "commit"
          ? "commits:read"
          : e.kind === "repository"
            ? "repositories:read"
            : e.kind === "project"
              ? "projects:read"
              : e.kind === "session" || e.kind === "runtime"
                ? "sessions:read"
                : ["artifact", "artifact_version", "artifact_thread", "artifact_comment"].includes(
                      e.kind,
                    )
                  ? "artifacts:read"
                  : e.kind === "session_event"
                    ? "transcripts:read"
                    : "tasks:read",
      )
    );
  }
  add(type: string, source: string, target: string, reason = "") {
    this.entity(source);
    this.entity(target);
    const old = this.w.one<Relation>(
      "SELECT * FROM relations WHERE type=? AND source_id=? AND target_id=?",
      type,
      source,
      target,
    );
    if (old) return old;
    if (this.entity(source).deleted_at || this.entity(target).deleted_at)
      throw new AppError("entity_deleted", "New links require live endpoints", 410);
    const r = {
      id: uid("link"),
      type,
      source_id: source,
      target_id: target,
      reason,
      created_at: this.w.now(),
    };
    this.w.run(
      "INSERT INTO relations VALUES(?,?,?,?,?,?)",
      r.id,
      type,
      source,
      target,
      reason,
      r.created_at,
    );
    return r;
  }
  relations(id: string) {
    return this.w.all<Relation>(
      "SELECT * FROM relations WHERE source_id=? OR target_id=? ORDER BY created_at,id",
      id,
      id,
    );
  }
  describe(e: Entity) {
    if (e.deleted_at) return { ...e, value: null };
    let value: unknown = null;
    if (e.kind === "task") value = this.w.task(e.id);
    else if (e.kind === "project") value = this.w.project(e.id);
    else if (e.kind === "repository") value = this.w.history.repository(e.id);
    else if (e.kind === "session") value = this.w.sessions.get(e.id);
    else if (e.kind === "role") value = this.w.sessions.role(e.id);
    else if (e.kind === "artifact") value = this.w.artifacts?.detail(e.id);
    else if (e.kind === "artifact_version") {
      const at = e.id.lastIndexOf("@");
      value = this.w.artifacts?.store.version(e.id.slice(0, at), Number(e.id.slice(at + 1)));
    } else if (e.kind === "artifact_thread") value = this.w.artifacts?.conversations.get(e.id);
    else if (e.kind === "artifact_comment") value = this.w.artifacts?.conversations.comment(e.id);
    else if (e.kind === "comment")
      value = this.w.one("SELECT * FROM task_comments WHERE id=?", e.id);
    else if (e.kind === "commit") {
      const ref = commitReference(e.id)!;
      value = { ...ref, observed: !!this.w.history.cached(ref.repository_id, ref.commit_id) };
    }
    return { ...e, value };
  }
  context(a: Record<string, unknown>, p: Principal) {
    const entity = this.entity(String(a.entity_id));
    if (!this.canRead(entity, p))
      throw new AppError("forbidden", "Access to this entity is not granted", 403);
    const rows = this.relations(entity.id).filter(
      (r) =>
        (!a.relation_type || a.relation_type === r.type) &&
        (a.direction === "both" ||
          (a.direction === "incoming" ? r.target_id === entity.id : r.source_id === entity.id)) &&
        this.canRead(this.entity(r.source_id), p) &&
        this.canRead(this.entity(r.target_id), p),
    );
    const page = this.w.page(rows, a);
    return {
      entity: this.describe(entity),
      relations: page,
      neighbors: [
        ...new Set(
          page.items.flatMap((r) => [r.source_id, r.target_id]).filter((id) => id !== entity.id),
        ),
      ].map((id) => this.describe(this.entity(id))),
    };
  }
  write(name: string, a: Record<string, unknown>, p: Principal) {
    const r =
      name === "links_remove"
        ? this.w.one<Relation>("SELECT * FROM relations WHERE id=?", String(a.relation_id))
        : null;
    if (name === "links_remove" && !r) throw new AppError("not_found", "Link not found", 404);
    const source = r?.source_id ?? String(a.source_id),
      target = r?.target_id ?? String(a.target_id);
    for (const id of [source, target])
      if (!this.canRead(this.entity(id), p))
        throw new AppError("forbidden", "Both link endpoints must be readable", 403);
    if (r) {
      this.w.run("DELETE FROM relations WHERE id=?", r.id);
      return { ...r, deleted: true };
    }
    return this.add(String(a.type), source, target, String(a.reason ?? ""));
  }
}
