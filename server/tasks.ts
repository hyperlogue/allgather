import {
  AppError,
  type Assignment,
  type Blocker,
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
  | "labels"
  | "assignee"
  | "status"
  | "is_done"
  | "blocked"
  | "needs_owner"
  | "dependencies"
  | "child_count"
> & { labels: string; assignee: string | null; is_done: number };
export class Tasks {
  constructor(private w: Workspace) {}
  raw(id: string) {
    const t = this.w.one<StoredTask>("SELECT * FROM tasks WHERE id=?", id);
    if (!t) throw new AppError("not_found", "Task not found", 404);
    this.w.access.require(this.w.access.project(t.project_id));
    return t;
  }
  dependencies(id: string) {
    return this.w
      .all<{ waiting_on_task_id: string }>(
        "SELECT waiting_on_task_id FROM task_blockers WHERE task_id=? AND waiting_on='task' ORDER BY waiting_on_task_id",
        id,
      )
      .map((r) => r.waiting_on_task_id);
  }
  blockers(id: string): Blocker[] {
    return this.w
      .all<Omit<Blocker, "satisfied"> & { satisfied: number }>(
        `SELECT b.*,CASE WHEN b.waiting_on='task' THEN p.closed_at IS NOT NULL AND p.is_done=1
        ELSE b.cleared_at IS NOT NULL END satisfied
       FROM task_blockers b LEFT JOIN tasks p ON p.id=b.waiting_on_task_id
       WHERE b.task_id=? ORDER BY b.created_at,b.id`,
        id,
      )
      .map((b) => ({
        ...b,
        satisfied: !!b.satisfied,
        ...(b.waiting_on_task_id && !this.w.access.task(b.waiting_on_task_id)
          ? { waiting_on_task_id: null, body: "Waiting for a restricted prerequisite" }
          : {}),
      }));
  }
  get(id: string): Task {
    const t = this.raw(id),
      blockers = this.blockers(id).filter((b) => !b.satisfied);
    return {
      ...t,
      status: t.closed_at ? "closed" : blockers.length ? "blocked" : "open",
      is_done: !!t.is_done,
      labels: JSON.parse(t.labels),
      assignee: t.assignee ? JSON.parse(t.assignee) : null,
      blocked: !t.closed_at && blockers.length > 0,
      needs_owner: !t.closed_at && blockers.some((b) => b.waiting_on === "human"),
      dependencies: this.dependencies(id).filter((id) => this.w.access.task(id)),
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
  private bump(id: string) {
    this.w.run("UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?", this.w.now(), id);
  }
  private open(t: Task) {
    if (t.closed_at) throw new AppError("reopen_required", "Reopen the task first", 409);
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
  private addBlocker(
    task: string,
    waiting: Blocker["waiting_on"],
    body: string,
    prerequisite?: string,
  ) {
    if (prerequisite) {
      this.raw(prerequisite);
      if (
        this.w.one(
          `WITH RECURSIVE reachable(id) AS (SELECT ? UNION
          SELECT b.waiting_on_task_id FROM task_blockers b JOIN reachable r ON b.task_id=r.id
          WHERE b.waiting_on='task') SELECT 1 FROM reachable WHERE id=?`,
          prerequisite,
          task,
        )
      )
        throw new AppError("dependency_cycle", "Dependency cycle is not allowed", 409);
      if (
        this.w.one(
          "SELECT 1 FROM task_blockers WHERE task_id=? AND waiting_on='task' AND waiting_on_task_id=?",
          task,
          prerequisite,
        )
      )
        throw new AppError("duplicate_blocker", "This prerequisite already has a blocker", 409);
    }
    this.w.run(
      "INSERT INTO task_blockers(id,task_id,waiting_on,waiting_on_task_id,body,created_at) VALUES(?,?,?,?,?,?)",
      uid("blocker"),
      task,
      waiting,
      prerequisite ?? null,
      body,
      this.w.now(),
    );
  }
  private create(a: Input): Task {
    const project = this.w.project(String(a.project_id)),
      sequence = this.w.one<{ task_sequence: number }>(
        "UPDATE projects SET task_sequence=task_sequence+1 WHERE id=? RETURNING task_sequence",
        project.id,
      )!.task_sequence,
      id = `${project.slug}-${sequence}`;
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
  private clearBlocker(task: string, blocker: string, body: string) {
    const row = this.w.one<Blocker>(
      "SELECT * FROM task_blockers WHERE id=? AND task_id=?",
      blocker,
      task,
    );
    if (!row) throw new AppError("not_found", "Blocker not found", 404);
    if (row.waiting_on === "task")
      throw new AppError(
        "automatic_blocker",
        "Task blockers satisfy automatically; remove the blocker if it is no longer required",
        409,
      );
    if (row.cleared_at)
      throw new AppError("blocker_cleared", "This blocker is already cleared", 409, {
        comment_id: row.resolution_comment_id,
      });
    const comment = this.comment(task, body);
    this.w.run(
      "UPDATE task_blockers SET cleared_at=?,resolution_comment_id=? WHERE id=?",
      this.w.now(),
      comment.id,
      blocker,
    );
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
    const t = this.get(id),
      descendants = this.descendants(id).map((x) => this.get(x)),
      children = descendants.filter((c) => !c.child_count),
      done = children.filter((c) => c.is_done).length;
    return {
      id,
      title: t.title,
      total: children.length,
      done,
      closed_without_completion: children.filter((c) => c.closed_at && !c.is_done).length,
      open: children.filter((c) => !c.closed_at).length,
      blocked: children.filter((c) => c.blocked).length,
      percent_done: children.length ? Math.round((done * 100) / children.length) : 0,
      can_resolve: !t.closed_at && !t.blocked,
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
          "SELECT task_id FROM task_blockers WHERE waiting_on='task' AND waiting_on_task_id=?",
          id,
        )
        .filter((r) => this.w.access.task(r.task_id))
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
        .filter((r) => this.w.access.task(r.id))
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
          if (a.is_done !== undefined && t.is_done !== a.is_done) return false;
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
          if (mode !== "tasks_search" && t.status !== "open") return false;
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
      const access = this.w.access.projectSql("t.project_id");
      return this.w.all(
        `SELECT j.value name,COUNT(*) count FROM tasks t,json_each(t.labels) j WHERE (? IS NULL OR t.project_id=?) AND ${access.sql} GROUP BY j.value ORDER BY j.value`,
        prj,
        prj,
        ...access.args,
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
        .filter((r) => this.w.access.task(r.id))
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
        this.addBlocker(id, "task", "Complete prerequisite", dep);
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
      case "tasks_resolve":
      case "tasks_cancel": {
        this.open(t);
        if (name === "tasks_resolve" && t.blocked)
          throw new AppError(
            "task_blocked",
            "Satisfy all blockers and prerequisites before resolving",
            409,
          );
        this.w.run(
          "UPDATE tasks SET is_done=?,closed_at=? WHERE id=?",
          name === "tasks_resolve" ? 1 : 0,
          this.w.now(),
          id,
        );
        if (a.labels !== undefined)
          this.w.run("UPDATE tasks SET labels=? WHERE id=?", JSON.stringify(a.labels), id);
        if (a.comment) this.comment(id, String(a.comment));
        break;
      }
      case "tasks_reopen":
        if (!t.closed_at) throw new AppError("already_open", "The task is already open", 409);
        this.w.run("UPDATE tasks SET is_done=0,closed_at=NULL WHERE id=?", id);
        this.comment(id, String(a.reason));
        break;
      case "tasks_link_commit":
        if (!can(p, "commits:read"))
          throw new AppError("forbidden", "Commit references require commits:read", 403);
        this.w.graph.add(
          "relates_to",
          id,
          this.w.graph.commit(String(a.repository_id), String(a.commit_id)).id,
        );
        break;
      case "tasks_block":
        this.open(t);
        this.addBlocker(
          id,
          a.waiting_on as Blocker["waiting_on"],
          String(a.body),
          a.waiting_on_task_id as string | undefined,
        );
        break;
      case "tasks_clear_blocker":
        this.clearBlocker(id, String(a.blocker_id), String(a.comment));
        break;
      case "tasks_remove_blocker":
        if (
          !this.w.one(
            "SELECT id FROM task_blockers WHERE id=? AND task_id=?",
            String(a.blocker_id),
            id,
          )
        )
          throw new AppError("not_found", "Blocker not found", 404);
        this.comment(id, String(a.comment));
        this.w.run("DELETE FROM task_blockers WHERE id=? AND task_id=?", String(a.blocker_id), id);
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
        break;
      }
      default:
        throw new AppError("not_found", "Unknown task mutation", 404);
    }
    this.bump(id);
    return this.get(id);
  }
}
