import {
  AppError,
  type Assignment,
  type Blocker,
  type Claim,
  can,
  type EpicProgress,
  type Operation,
  type Principal,
  type Task,
  type TaskComment,
  type TaskContext,
} from "../shared/contracts.ts";
import { commitReference } from "./graph.ts";
import { uid, type Workspace } from "./workspace.ts";

type Input = Record<string, unknown>;
type StoredTask = Omit<
  Task,
  "labels" | "assignee" | "claim" | "blocked" | "needs_owner" | "dependencies" | "child_count"
> & { labels: string; assignee: string | null };
export class Tasks {
  constructor(private w: Workspace) {}
  raw(id: string) {
    const t = this.w.one<StoredTask>("SELECT * FROM tasks WHERE id=?", id);
    if (!t) throw new AppError("not_found", "Task not found", 404);
    return t;
  }
  dependencies(id: string) {
    return this.w
      .all<{ prerequisite_id: string }>(
        "SELECT prerequisite_id FROM task_prerequisites WHERE task_id=? ORDER BY prerequisite_id",
        id,
      )
      .map((r) => r.prerequisite_id);
  }
  blockers(id: string): Blocker[] {
    return [
      ...this.w.all<Blocker>(
        "SELECT * FROM task_blockers WHERE task_id=? AND resolved_at IS NULL ORDER BY created_at,id",
        id,
      ),
      ...this.w
        .all<{ id: string; title: string; created_at: string }>(
          "SELECT t.id,t.title,t.created_at FROM task_prerequisites p JOIN tasks t ON t.id=p.prerequisite_id WHERE p.task_id=? AND t.status!='done' ORDER BY t.id",
          id,
        )
        .map((t) => ({
          id: `dependency:${t.id}`,
          task_id: id,
          waiting_on: "task" as const,
          body: `Complete prerequisite: ${t.title}`,
          dependency_id: t.id,
          created_at: t.created_at,
          resolved_at: null,
        })),
    ];
  }
  get(id: string): Task {
    const t = this.raw(id),
      blockers = this.blockers(id);
    return {
      ...t,
      labels: JSON.parse(t.labels),
      assignee: t.assignee ? JSON.parse(t.assignee) : null,
      claim: this.w.one<Claim>(
        "SELECT * FROM task_claims WHERE task_id=? AND lease_until>?",
        id,
        this.w.now(),
      ),
      blocked: t.status === "open" && blockers.length > 0,
      needs_owner: t.status === "open" && blockers.some((b) => b.waiting_on === "owner"),
      dependencies: this.dependencies(id),
      child_count: this.w.one<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE parent_id=?", id)!
        .n,
    };
  }
  descendants(id: string) {
    return this.w
      .all<{ id: string }>(
        "WITH RECURSIVE children(id) AS (SELECT id FROM tasks WHERE parent_id=? UNION SELECT t.id FROM tasks t JOIN children c ON t.parent_id=c.id) SELECT id FROM children",
        id,
      )
      .map((r) => r.id);
  }
  private checkRevision(t: Task, a: Input) {
    if (t.revision !== a.expected_revision)
      throw new AppError("revision_conflict", "The task changed. Read its current revision.", 409, {
        current_revision: t.revision,
      });
  }
  logSequence(id: string) {
    return this.w.one<{ n: number }>(
      "SELECT COALESCE(MAX(sequence),0) n FROM audit_changes WHERE task_id=? OR related_task_id=?",
      id,
      id,
    )!.n;
  }
  private checkClaim(t: Task, a: Input, p: Principal) {
    if (
      !t.claim ||
      (t.claim.holder === "owner"
        ? this.w.operator.kind === "user"
        : t.claim.session_id === this.w.operator.session_id)
    )
      return;
    if (a.override_claim && can(p, "admin")) {
      this.w.run("DELETE FROM task_claims WHERE task_id=?", t.id);
      return;
    }
    throw new AppError("claim_conflict", "Another session holds this claim", 409, t.claim);
  }
  private bump(id: string) {
    this.w.run("UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?", this.w.now(), id);
  }
  private open(t: Task) {
    if (t.status !== "open") throw new AppError("reopen_required", "Reopen the task first", 409);
  }
  assignment(value: Assignment | null) {
    if (!value || value.kind === "owner") return;
    if (value.kind === "session") this.w.sessions.get(value.id);
    else this.w.sessions.role(value.id);
  }
  private parent(id: string, parent: string | null) {
    if (parent) {
      const t = this.raw(id),
        p = this.raw(parent);
      if (t.project_id !== p.project_id)
        throw new AppError("invalid_parent", "The parent must belong to the same project");
      if (
        this.w.one(
          "WITH RECURSIVE ancestors(id) AS (SELECT ? UNION SELECT t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_id IS NOT NULL) SELECT 1 FROM ancestors WHERE id=?",
          parent,
          id,
        )
      )
        throw new AppError("parent_cycle", "Task hierarchy cannot contain a cycle", 409);
    }
    this.w.run("UPDATE tasks SET parent_id=? WHERE id=?", parent, id);
  }
  private dependency(id: string, other: string, remove = false) {
    this.raw(other);
    if (remove) {
      this.w.run("DELETE FROM task_prerequisites WHERE task_id=? AND prerequisite_id=?", id, other);
      return;
    }
    if (
      this.w.one(
        "WITH RECURSIVE reachable(id) AS (SELECT ? UNION SELECT p.prerequisite_id FROM task_prerequisites p JOIN reachable r ON p.task_id=r.id) SELECT 1 FROM reachable WHERE id=?",
        other,
        id,
      )
    )
      throw new AppError("relation_cycle", "Dependency cycle is not allowed", 409);
    this.w.run("INSERT OR IGNORE INTO task_prerequisites VALUES(?,?)", id, other);
  }
  private create(a: Input): Task {
    const project = this.w.project(String(a.project_id)),
      id = uid("ag");
    this.assignment(a.assignee as Assignment | null);
    this.w.run(
      "INSERT INTO tasks(id,project_id,title,body,labels,defer_until,assignee,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      project.id,
      String(a.title),
      String(a.body ?? ""),
      JSON.stringify(a.labels ?? []),
      (a.defer_until as string | null) ?? null,
      a.assignee ? JSON.stringify(a.assignee) : null,
      this.w.now(),
      this.w.now(),
    );
    this.w.graph.ensure(id, "task", project.id);
    if (a.parent_id) this.parent(id, String(a.parent_id));
    if (a.discovered_from) this.w.graph.add("discovered_from", id, String(a.discovered_from));
    return this.get(id);
  }
  comment(id: string, body: string, reply?: string) {
    this.raw(id);
    if (
      reply &&
      this.w.one<{ task_id: string }>("SELECT task_id FROM task_comments WHERE id=?", reply)
        ?.task_id !== id
    )
      throw new AppError("invalid_reply", "A reply must refer to a comment in this task");
    const c = uid("comment"),
      o = this.w.operator;
    this.w.run(
      "INSERT INTO task_comments(id,task_id,body,operator_id,operator_name,operator_kind,session_id,role_id,role_name,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      c,
      id,
      body,
      o.id,
      o.name,
      o.kind,
      o.session_id,
      o.role_id,
      o.role_name,
      reply ?? null,
      this.w.now(),
    );
    this.w.graph.ensure(c, "comment", this.raw(id).project_id);
    return this.w.one<TaskComment>("SELECT * FROM task_comments WHERE id=?", c)!;
  }
  comments(id: string, a: Input) {
    this.raw(id);
    const total = this.w.one<{ n: number }>(
        "SELECT COUNT(*) n FROM task_comments WHERE task_id=?",
        id,
      )!.n,
      start = Number(a.cursor ?? 0),
      limit = Number(a.limit ?? 50);
    return {
      items: this.w.all<TaskComment>(
        "SELECT * FROM task_comments WHERE task_id=? ORDER BY sequence LIMIT ? OFFSET ?",
        id,
        limit,
        start,
      ),
      total,
      next_cursor: start + limit < total ? start + limit : null,
    };
  }
  progress(id: string): EpicProgress {
    const t = this.raw(id),
      descendants = this.descendants(id).map((x) => this.get(x)),
      children = descendants.filter((c) => !c.child_count),
      count = (status: string) => children.filter((c) => c.status === status).length;
    return {
      id,
      title: t.title,
      total: children.length,
      done: count("done"),
      cancelled: count("cancelled"),
      open: count("open"),
      blocked: children.filter((c) => c.blocked).length,
      percent_done: children.length ? Math.round((count("done") * 100) / children.length) : 0,
      can_close: !descendants.some((c) => c.status === "open"),
    };
  }
  private context(id: string, p: Principal): TaskContext {
    const task = this.get(id),
      total = this.w.one<{ n: number }>(
        "SELECT COUNT(*) n FROM task_comments WHERE task_id=?",
        id,
      )!.n,
      offset = Math.max(0, total - 50),
      related = this.w.graph
        .relations(id)
        .filter(
          (r) =>
            this.w.graph.canRead(this.w.graph.entity(r.source_id), p) &&
            this.w.graph.canRead(this.w.graph.entity(r.target_id), p),
        );
    return {
      task,
      project: this.w.project(task.project_id),
      dependencies: task.dependencies.map((x) => this.get(x)),
      dependents: this.w
        .all<{ task_id: string }>(
          "SELECT task_id FROM task_prerequisites WHERE prerequisite_id=?",
          id,
        )
        .map((r) => this.get(r.task_id)),
      children: this.w
        .all<{ id: string }>("SELECT id FROM tasks WHERE parent_id=? ORDER BY created_at,id", id)
        .map((r) => this.get(r.id)),
      blockers: this.blockers(id),
      comments: { ...this.comments(id, { cursor: offset, limit: 50 }), older_count: offset },
      log_sequence: this.logSequence(id),
      related,
      progress: task.child_count ? this.progress(id) : null,
      commits: related.flatMap((r) => {
        const ref = commitReference(r.source_id === id ? r.target_id : r.source_id);
        return ref
          ? [
              {
                ...ref,
                verified: Number(!!this.w.history.cached(ref.repository_id, ref.commit_id)),
              },
            ]
          : [];
      }),
    };
  }
  private search(a: Input, mode: Operation) {
    if (a.unassigned && a.assignee)
      throw new AppError("invalid_filter", "Use either assignee or unassigned, not both");
    const project = a.project_id ? this.w.project(String(a.project_id)).id : null,
      desc = a.epic_id ? new Set(this.descendants(String(a.epic_id))) : null,
      q = String(a.query ?? "")
        .trim()
        .toLowerCase(),
      rows = this.w
        .all<{ id: string }>(
          "SELECT id FROM tasks WHERE (? IS NULL OR project_id=?)",
          project,
          project,
        )
        .map((r) => this.get(r.id))
        .filter((t) => {
          if (a.status && t.status !== a.status) return false;
          if (a.parent_id && t.parent_id !== a.parent_id) return false;
          if (desc && !desc.has(t.id)) return false;
          if ((a.labels_all as string[] | undefined)?.some((v) => !t.labels.includes(v)))
            return false;
          if (
            (a.labels_any as string[] | undefined)?.length &&
            !(a.labels_any as string[]).some((v) => t.labels.includes(v))
          )
            return false;
          if (a.deferred_before || a.deferred_after) {
            if (!t.defer_until) {
              if (!a.include_undated) return false;
            } else if (
              (a.deferred_before && t.defer_until > String(a.deferred_before)) ||
              (a.deferred_after && t.defer_until < String(a.deferred_after))
            )
              return false;
          }
          if (a.claimed !== undefined && !!t.claim !== a.claimed) return false;
          if (a.blocked !== undefined && t.blocked !== a.blocked) return false;
          if (a.needs_owner !== undefined && t.needs_owner !== a.needs_owner) return false;
          if (a.assignee && JSON.stringify(t.assignee) !== JSON.stringify(a.assignee)) return false;
          if (a.unassigned && t.assignee) return false;
          if (
            q &&
            !`${t.id}\n${t.title}\n${t.body}`.toLowerCase().includes(q) &&
            !this.w.one(
              "SELECT 1 FROM task_comments WHERE task_id=? AND instr(lower(body),?)>0 LIMIT 1",
              t.id,
              q,
            )
          )
            return false;
          if (mode !== "tasks_search" && (t.status !== "open" || t.blocked || t.claim))
            return false;
          return true;
        });
    rows.sort(
      (x, y) =>
        (a.sort === "title"
          ? x.title.localeCompare(y.title)
          : a.sort === "updated"
            ? y.updated_at.localeCompare(x.updated_at)
            : x.created_at.localeCompare(y.created_at)) || x.id.localeCompare(y.id),
    );
    return this.w.page(rows, a);
  }
  read(name: Operation, a: Input, p: Principal): unknown {
    if (name === "tasks_get") return this.get(String(a.task_id));
    if (name === "tasks_context") return this.context(String(a.task_id), p);
    if (name === "task_comments_list") return this.comments(String(a.task_id), a);
    if (name === "tasks_labels") {
      const prj = a.project_id ? this.w.project(String(a.project_id)).id : null;
      return this.w.all(
        "SELECT j.value name,COUNT(*) count FROM tasks t,json_each(t.labels) j WHERE (? IS NULL OR t.project_id=?) GROUP BY j.value ORDER BY j.value",
        prj,
        prj,
      );
    }
    if (name === "tasks_progress") {
      if (a.epic_id) return [this.progress(String(a.epic_id))];
      const prj = a.project_id ? this.w.project(String(a.project_id)).id : null;
      return this.w
        .all<{ id: string }>(
          "SELECT id FROM tasks t WHERE EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id=t.id) AND (? IS NULL OR project_id=?) ORDER BY title,id",
          prj,
          prj,
        )
        .map((r) => this.progress(r.id));
    }
    if (["tasks_search", "tasks_ready"].includes(name)) return this.search(a, name);
    throw new AppError("not_found", "Unknown task query", 404);
  }
  private plan(a: Input) {
    const entries = a.tasks as (Input & { key: string })[],
      mapping: Record<string, string> = Object.create(null);
    for (const e of entries) {
      if (Object.hasOwn(mapping, e.key))
        throw new AppError("duplicate_plan_key", "Plan keys must be unique");
      mapping[e.key] = "";
      if (e.parent_key && e.parent_id)
        throw new AppError("invalid_parent", "Use a parent key or parent ID");
    }
    for (const e of entries)
      for (const k of [e.parent_key, ...(e.depends_on_keys as string[])].filter(Boolean))
        if (!Object.hasOwn(mapping, String(k)))
          throw new AppError("unknown_plan_key", `Unknown plan key ${k}`);
    for (const e of entries)
      mapping[e.key] = this.create({ ...e, project_id: a.project_id, parent_id: undefined }).id;
    for (const e of entries) {
      const id = mapping[e.key];
      if (e.parent_key || e.parent_id)
        this.parent(id, e.parent_key ? mapping[String(e.parent_key)] : String(e.parent_id));
      for (const dep of [
        ...(e.depends_on_keys as string[]).map((k) => mapping[k]),
        ...(e.depends_on as string[]),
      ])
        this.dependency(id, dep);
    }
    return { mapping, tasks: Object.values(mapping).map((id) => this.get(id)) };
  }
  write(name: Operation, a: Input, p: Principal): unknown {
    if (name === "tasks_create") return this.create(a);
    if (name === "tasks_plan_create") return this.plan(a);
    const id = String(a.task_id),
      t = this.get(id);
    if (name === "task_comments_add")
      return this.comment(id, String(a.body), a.reply_to as string | undefined);
    this.checkRevision(t, a);
    this.checkClaim(t, a, p);
    switch (name) {
      case "tasks_update": {
        if (a.assignee !== undefined) this.assignment(a.assignee as Assignment | null);
        for (const field of ["title", "body", "labels", "defer_until", "assignee"] as const)
          if (a[field] !== undefined)
            this.w.run(
              `UPDATE tasks SET ${field}=? WHERE id=?`,
              field === "labels"
                ? JSON.stringify(a[field])
                : field === "assignee"
                  ? a[field]
                    ? JSON.stringify(a[field])
                    : null
                  : (a[field] as string | null),
              id,
            );
        if (a.parent_id !== undefined) this.parent(id, a.parent_id as string | null);
        break;
      }
      case "tasks_claim": {
        this.open(t);
        if (t.blocked)
          throw new AppError("task_blocked", "Resolve blockers before claiming work", 409);
        const owner = this.w.operator.kind === "user",
          session = this.w.operator.session_id;
        if (!owner && !session)
          throw new AppError("session_required", "Supply a session ID for an agent claim");
        this.w.run(
          "INSERT INTO task_claims VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET holder=excluded.holder,session_id=excluded.session_id,lease_until=excluded.lease_until",
          id,
          owner ? "owner" : "session",
          owner ? null : session,
          new Date(this.w.clock().getTime() + Number(a.lease_seconds) * 1000).toISOString(),
        );
        this.w.participation(id);
        break;
      }
      case "tasks_release":
        this.w.run("DELETE FROM task_claims WHERE task_id=?", id);
        break;
      case "tasks_finish": {
        this.open(t);
        if (t.blocked)
          throw new AppError(
            "task_blocked",
            "Resolve blockers and prerequisites before finishing",
            409,
          );
        if (this.descendants(id).some((c) => this.raw(c).status === "open"))
          throw new AppError("unfinished_children", "Finish or cancel descendant work first", 409);
        if (a.commit_id) {
          if (!can(p, "history:read"))
            throw new AppError("forbidden", "Commit references require history:read", 403);
          this.w.graph.add(
            "produces",
            id,
            this.w.graph.commit(String(a.repository_id), String(a.commit_id)).id,
          );
        }
        this.w.run("UPDATE tasks SET status='done',closed_at=? WHERE id=?", this.w.now(), id);
        this.w.run("DELETE FROM task_claims WHERE task_id=?", id);
        if (a.summary) this.comment(id, String(a.summary));
        break;
      }
      case "tasks_cancel":
        this.open(t);
        this.w.run("UPDATE tasks SET status='cancelled',closed_at=? WHERE id=?", this.w.now(), id);
        this.w.run("DELETE FROM task_claims WHERE task_id=?", id);
        if (a.comment) this.comment(id, String(a.comment));
        break;
      case "tasks_reopen":
        if (t.status === "open")
          throw new AppError("already_open", "The task is already open", 409);
        this.w.run("UPDATE tasks SET status='open',closed_at=NULL WHERE id=?", id);
        this.comment(id, String(a.reason));
        break;
      case "tasks_set_dependency":
        this.dependency(id, String(a.depends_on), !!a.remove);
        break;
      case "tasks_link_commit":
        if (!can(p, "history:read"))
          throw new AppError("forbidden", "Commit references require history:read", 403);
        this.w.graph.add(
          "relates_to",
          id,
          this.w.graph.commit(String(a.repository_id), String(a.commit_id)).id,
        );
        break;
      case "tasks_block":
        this.open(t);
        this.w.run(
          "INSERT INTO task_blockers VALUES(?,?,?,?,?,NULL)",
          uid("blocker"),
          id,
          String(a.waiting_on),
          String(a.body),
          this.w.now(),
        );
        break;
      case "tasks_resolve_blocker":
        if (
          !this.w.one(
            "SELECT 1 FROM task_blockers WHERE id=? AND task_id=? AND resolved_at IS NULL",
            String(a.blocker_id),
            id,
          )
        )
          throw new AppError("not_found", "Unresolved blocker not found", 404);
        this.w.run(
          "UPDATE task_blockers SET resolved_at=? WHERE id=?",
          this.w.now(),
          String(a.blocker_id),
        );
        this.comment(id, String(a.comment));
        break;
      case "tasks_handoff": {
        this.open(t);
        const seq = this.logSequence(id);
        if (seq !== a.expected_log_sequence)
          throw new AppError(
            "context_conflict",
            "Read the latest work log before handing off",
            409,
            { current_log_sequence: seq },
          );
        this.assignment(a.assignee as Assignment | null);
        this.w.run(
          "UPDATE tasks SET assignee=? WHERE id=?",
          a.assignee ? JSON.stringify(a.assignee) : null,
          id,
        );
        this.comment(id, String(a.comment));
        this.w.run("DELETE FROM task_claims WHERE task_id=?", id);
        break;
      }
      default:
        throw new AppError("not_found", "Unknown task mutation", 404);
    }
    this.bump(id);
    return this.get(id);
  }
}
