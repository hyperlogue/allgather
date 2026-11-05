import {
  type AgentSession,
  AppError,
  can,
  type Operation,
  type Principal,
  type Role,
} from "../shared/contracts.ts";
import { uid, type Workspace } from "./workspace.ts";

type Input = Record<string, unknown>;
export class Sessions {
  constructor(private w: Workspace) {}
  resolve(id: string) {
    return (
      this.w.one<{ session_id: string }>("SELECT session_id FROM session_aliases WHERE alias=?", id)
        ?.session_id ?? id
    );
  }
  get(id: string): AgentSession {
    const row = this.w.one<AgentSession>(
      "SELECT * FROM agent_sessions WHERE id=?",
      this.resolve(id),
    );
    if (!row) throw new AppError("not_found", "Session not found", 404);
    this.w.access.require(this.w.access.session(row.id));
    return row;
  }
  role(id: string) {
    const r = this.w.one<Role>("SELECT * FROM roles WHERE id=?", id);
    if (!r) throw new AppError("not_found", "Role not found", 404);
    return r;
  }
  ensure(id: string, harness = "unknown", label?: string, projectId: string | null = null) {
    id = this.resolve(id);
    const existing = this.w.one<AgentSession>("SELECT * FROM agent_sessions WHERE id=?", id);
    if (existing) {
      this.w.access.require(this.w.access.session(existing.id));
      return existing;
    }
    this.w.access.require(this.w.access.project(projectId));
    this.w.graph.ensure(id, "session", projectId);
    this.w.run(
      "INSERT INTO agent_sessions(id,agent_type,label,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?)",
      id,
      harness,
      label ?? null,
      this.w.now(),
      this.w.now(),
      projectId,
    );
    return this.get(id);
  }
  private bind(id: string, role: string) {
    const s = this.get(id);
    this.role(role);
    if (s.role_id === role) return s;
    if (s.role_id)
      throw new AppError(
        "role_conflict",
        "This session already has a role. Use a new session for a different role.",
        409,
      );
    this.w.run(
      "UPDATE agent_sessions SET role_id=?,revision=revision+1,updated_at=? WHERE id=?",
      role,
      this.w.now(),
      s.id,
    );
    return this.get(s.id);
  }
  read(name: Operation, a: Input, p: Principal) {
    if (name === "roles_list")
      return this.w.access.project(null)
        ? this.w.all<Role>("SELECT * FROM roles ORDER BY name,id")
        : [];
    if (name === "sessions_get") return this.get(String(a.target_session_id));
    if ((a.project_id || a.task_id) && !can(p, "tasks:read"))
      throw new AppError("forbidden", "Work filters require tasks:read", 403);
    const project = a.project_id ? this.w.project(String(a.project_id)).id : null,
      task = a.task_id ? this.w.task(String(a.task_id)).id : null;
    if (a.machine_id) this.w.executions.machine(String(a.machine_id));
    if (a.since && a.until && String(a.since) > String(a.until))
      throw new AppError("invalid_range", "The start time must precede the end time");
    const where = ["1=1"],
      args: (string | number)[] = [];
    const filter = (sql: string, ...values: (string | number)[]) => {
      where.push(sql);
      args.push(...values);
    };
    if (a.query)
      filter(
        "instr(lower(s.id||' '||COALESCE(s.label,'')||' '||s.agent_type),?)>0",
        String(a.query).toLowerCase(),
      );
    if (a.role_id) filter("s.role_id=?", String(a.role_id));
    if (a.machine_id)
      filter(
        "EXISTS(SELECT 1 FROM session_runtimes r WHERE r.session_id=s.id AND r.machine_id=?)",
        String(a.machine_id),
      );
    if (a.since) filter("s.created_at>=?", String(a.since));
    if (a.until) filter("s.created_at<=?", String(a.until));
    if (project)
      filter(
        `(s.project_id=? OR EXISTS(SELECT 1 FROM relations r JOIN entities e ON e.id=CASE WHEN r.source_id=s.id THEN r.target_id ELSE r.source_id END WHERE (r.source_id=s.id OR r.target_id=s.id) AND e.project_id=?) OR EXISTS(SELECT 1 FROM audit_operations o JOIN audit_changes c ON c.operation_id=o.id WHERE o.session_id=s.id AND c.project_id=?))`,
        project,
        project,
        project,
      );
    if (task)
      filter(
        `(EXISTS(SELECT 1 FROM relations r WHERE (r.source_id=s.id AND r.target_id=?) OR (r.target_id=s.id AND r.source_id=?)) OR EXISTS(SELECT 1 FROM task_comments c WHERE c.session_id=s.id AND c.task_id=?) OR EXISTS(SELECT 1 FROM audit_operations o JOIN audit_changes c ON c.operation_id=o.id WHERE o.session_id=s.id AND c.task_id=?))`,
        task,
        task,
        task,
        task,
      );
    const access = this.w.access.sessionSql("s");
    filter(access.sql, ...access.args);
    const sql = `FROM agent_sessions s WHERE ${where.join(" AND ")}`,
      total = this.w.one<{ n: number }>(`SELECT COUNT(*) n ${sql}`, ...args)!.n,
      cursor = Number(a.cursor ?? 0),
      limit = Number(a.limit ?? 50);
    return {
      items: this.w.all<AgentSession>(
        `SELECT s.* ${sql} ORDER BY s.created_at DESC,s.id LIMIT ? OFFSET ?`,
        ...args,
        limit,
        cursor,
      ),
      total,
      next_cursor: cursor + limit < total ? cursor + limit : null,
    };
  }

  write(name: Operation, a: Input) {
    if (name === "roles_create") {
      const id = uid("role");
      if (this.w.one("SELECT 1 FROM roles WHERE name=?", String(a.name)))
        throw new AppError("name_conflict", "A role with this name exists", 409);
      this.w.run(
        "INSERT INTO roles(id,name,description,created_at) VALUES(?,?,?,?)",
        id,
        String(a.name),
        String(a.description),
        this.w.now(),
      );
      this.w.graph.ensure(id, "role");
      return this.role(id);
    }
    if (name === "roles_update" || name === "roles_delete") {
      const r = this.role(String(a.role_id));
      if (r.revision !== a.expected_revision)
        throw new AppError("revision_conflict", "Read the current role revision", 409);
      if (name === "roles_delete") {
        if (
          this.w.one(
            "SELECT 1 FROM agent_sessions WHERE role_id=? UNION ALL SELECT 1 FROM tasks WHERE json_extract(assignee,'$.kind')='role' AND json_extract(assignee,'$.id')=? UNION ALL SELECT 1 FROM audit_operations WHERE role_id=? UNION ALL SELECT 1 FROM task_comments WHERE role_id=? UNION ALL SELECT 1 FROM relations WHERE source_id=? OR target_id=? LIMIT 1",
            r.id,
            r.id,
            r.id,
            r.id,
            r.id,
            r.id,
          )
        )
          throw new AppError(
            "role_in_use",
            "Referenced roles must remain available for history",
            409,
          );
        this.w.run("DELETE FROM entities WHERE id=?", r.id);
        this.w.run("DELETE FROM roles WHERE id=?", r.id);
        return { id: r.id, deleted: true };
      }
      if (a.name && this.w.one("SELECT 1 FROM roles WHERE name=? AND id!=?", String(a.name), r.id))
        throw new AppError("name_conflict", "A role with this name exists", 409);
      this.w.run(
        "UPDATE roles SET name=?,description=?,revision=revision+1 WHERE id=?",
        String(a.name ?? r.name),
        String(a.description ?? r.description),
        r.id,
      );
      return this.role(r.id);
    }
    const id = this.resolve(String(a.target_session_id));
    if (name === "sessions_bind_role") {
      const s = this.get(id);
      if (s.role_id === a.role_id) return s;
      if (s.revision !== a.expected_revision)
        throw new AppError("revision_conflict", "Read the current session revision", 409);
      return this.bind(id, String(a.role_id));
    }
    if (this.w.one("SELECT 1 FROM session_runtimes WHERE session_id=?", id))
      throw new AppError(
        "session_managed",
        "Tower-launched sessions take identity and metadata from launch; declare is for external sessions",
        409,
      );
    const s = this.ensure(
      id,
      String(a.harness),
      a.label as string | undefined,
      this.w.access.initialProject(a),
    );
    if (a.project_id !== undefined && s.project_id !== this.w.access.initialProject(a))
      throw new AppError(
        "session_project_conflict",
        "An existing session's project cannot be replaced",
        409,
      );
    if (a.source_namespace || a.native_session_id) {
      if (!a.source_namespace || !a.native_session_id)
        throw new AppError(
          "invalid_identity",
          "Supply both source_namespace and native_session_id",
        );
      const match = this.w.one<{ id: string }>(
        "SELECT id FROM agent_sessions WHERE source_namespace=? AND native_session_id=?",
        String(a.source_namespace),
        String(a.native_session_id),
      );
      if (match && match.id !== id)
        throw new AppError(
          "session_identity_conflict",
          "This native session is already declared",
          409,
          { session_id: match.id },
        );
      if (
        s.native_session_id &&
        (s.native_session_id !== a.native_session_id || s.source_namespace !== a.source_namespace)
      )
        throw new AppError(
          "session_identity_conflict",
          "A session identity cannot be replaced",
          409,
        );
      if (!s.native_session_id)
        this.w.run(
          "UPDATE agent_sessions SET source_namespace=?,native_session_id=?,revision=revision+1,updated_at=? WHERE id=?",
          String(a.source_namespace),
          String(a.native_session_id),
          this.w.now(),
          id,
        );
    }
    if (s.agent_type === "unknown" && a.harness !== "unknown")
      this.w.run(
        "UPDATE agent_sessions SET agent_type=?,revision=revision+1,updated_at=? WHERE id=?",
        String(a.harness),
        this.w.now(),
        id,
      );
    if (a.label && !s.label)
      this.w.run(
        "UPDATE agent_sessions SET label=?,revision=revision+1,updated_at=? WHERE id=?",
        String(a.label),
        this.w.now(),
        id,
      );
    return a.role_id ? this.bind(id, String(a.role_id)) : this.get(id);
  }
}
