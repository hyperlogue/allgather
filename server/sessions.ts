import {
  type AgentSession,
  AppError,
  can,
  type Operation,
  type Principal,
  type Role,
} from "../shared/contracts.ts";
import { inferredSessionIdentity, SessionIdentity, sessionProvider } from "./session-identity.ts";
import { digest, uid, type Workspace } from "./workspace.ts";

type Input = Record<string, unknown>;
export class Sessions {
  readonly identity: SessionIdentity;
  constructor(private w: Workspace) {
    this.identity = new SessionIdentity(
      w.db,
      () => w.now(),
      (id) => w.access.require(w.access.session(id)),
    );
  }
  resolve(id: string) {
    return this.identity.resolve(id);
  }
  get(id: string): AgentSession {
    const canonical = this.resolve(id);
    if (!this.w.one("SELECT 1 FROM agent_sessions WHERE id=?", canonical))
      throw new AppError("not_found", "Session not found", 404);
    this.w.access.require(this.w.access.session(canonical));
    return this.identity.describe(canonical)!;
  }
  role(id: string) {
    const r = this.w.one<Role>("SELECT * FROM roles WHERE id=?", id);
    if (!r) throw new AppError("not_found", "Role not found", 404);
    return r;
  }
  ensure(id: string, harness = "unknown", label?: string, projectId: string | null = null) {
    const original = id;
    id = this.resolve(id);
    const existing = this.w.one<AgentSession>("SELECT * FROM agent_sessions WHERE id=?", id);
    if (existing) this.w.access.require(this.w.access.session(id));
    else {
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
    }
    const native = inferredSessionIdentity(original, harness);
    if (native) id = this.identity.register(id, native.provider, native.native_id);
    if (projectId !== null) this.w.access.require(this.w.access.project(projectId));
    this.identity.enrich(id, {
      harness,
      label,
      ...(projectId !== null ? { project_id: projectId } : {}),
    });
    if (original !== id && !this.w.one("SELECT 1 FROM agent_sessions WHERE id=?", original))
      this.w.run(
        "INSERT OR IGNORE INTO session_aliases(alias,session_id) VALUES(?,?)",
        original,
        id,
      );
    return this.get(id);
  }
  observe(machine: string, towerId: string, record: Record<string, unknown>) {
    const provider = sessionProvider(record.harness),
      native = record.native_session_id;
    if (!provider || typeof native !== "string" || !native || native.length > 160) return;
    const fingerprint = digest(JSON.stringify([provider, native, record.display_name ?? null]));
    const linked = this.w.one<{ session_id: string; fingerprint: string }>(
      "SELECT session_id,fingerprint FROM session_tower_links WHERE machine_id=? AND tower_id=?",
      machine,
      towerId,
    );
    if (linked?.fingerprint === fingerprint) return;
    this.w.recordSessionObservation(machine, () => {
      const known = this.w.one<{ session_id: string }>(
        "SELECT session_id FROM session_identities WHERE provider=? AND native_id=?",
        provider,
        native,
      );
      const id =
        linked?.session_id ??
        known?.session_id ??
        this.ensure(
          uid("session"),
          String(record.harness),
          typeof record.display_name === "string" ? record.display_name : undefined,
        ).id;
      const canonical = this.identity.register(id, provider, native);
      const binding = this.w.one<{ provider: string; native_id: string }>(
        "SELECT provider,native_id FROM session_identities WHERE session_id=?",
        canonical,
      );
      if (binding?.provider === provider && binding.native_id === native)
        this.identity.enrich(id, {
          label: typeof record.display_name === "string" ? record.display_name : undefined,
          harness: String(record.harness),
        });
      this.w.run(
        "INSERT INTO session_tower_links VALUES(?,?,?,?) ON CONFLICT(machine_id,tower_id) DO UPDATE SET fingerprint=excluded.fingerprint",
        machine,
        towerId,
        canonical,
        fingerprint,
      );
      return { session_id: canonical };
    });
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
    const where = ["s.merged_into IS NULL"],
      args: (string | number)[] = [];
    const filter = (sql: string, ...values: (string | number)[]) => {
      where.push(sql);
      args.push(...values);
    };
    if (a.query)
      filter(
        "(EXISTS(SELECT 1 FROM agent_sessions sm WHERE (sm.id=s.id OR sm.merged_into=s.id) AND instr(lower(sm.id||' '||COALESCE(sm.label,'')||' '||sm.agent_type||' '||COALESCE(sm.native_provider,'')||':'||COALESCE(sm.native_session_id,'')),?)>0) OR EXISTS(SELECT 1 FROM session_aliases sa WHERE sa.session_id=s.id AND instr(lower(sa.alias),?)>0))",
        String(a.query).toLowerCase(),
        String(a.query).toLowerCase(),
      );
    if (a.role_id)
      filter(
        "EXISTS(SELECT 1 FROM agent_sessions sm WHERE (sm.id=s.id OR sm.merged_into=s.id) AND sm.role_id=?)",
        String(a.role_id),
      );
    if (a.machine_id)
      filter(
        "EXISTS(SELECT 1 FROM (SELECT session_id,machine_id FROM session_runtimes UNION SELECT session_id,machine_id FROM session_tower_links) r JOIN session_members sm ON sm.member_id=r.session_id WHERE sm.session_id=s.id AND r.machine_id=?)",
        String(a.machine_id),
      );
    if (a.since) filter("s.created_at>=?", String(a.since));
    if (a.until) filter("s.created_at<=?", String(a.until));
    if (project)
      filter(
        `(EXISTS(SELECT 1 FROM session_project_scopes ps JOIN session_members sm ON sm.member_id=ps.session_id WHERE sm.session_id=s.id AND ps.project_id=?) OR EXISTS(SELECT 1 FROM relations r JOIN entities e ON e.id=CASE WHEN r.source_id IN (SELECT member_id FROM session_members WHERE session_id=s.id) THEN r.target_id ELSE r.source_id END WHERE (r.source_id IN (SELECT member_id FROM session_members WHERE session_id=s.id) OR r.target_id IN (SELECT member_id FROM session_members WHERE session_id=s.id)) AND e.project_id=?) OR EXISTS(SELECT 1 FROM audit_operations o JOIN audit_changes c ON c.operation_id=o.id WHERE o.session_id IN (SELECT member_id FROM session_members WHERE session_id=s.id) AND c.project_id=?))`,
        project,
        project,
        project,
      );
    if (task)
      filter(
        `(EXISTS(SELECT 1 FROM relations r WHERE (r.source_id IN (SELECT member_id FROM session_members WHERE session_id=s.id) AND r.target_id=?) OR (r.target_id IN (SELECT member_id FROM session_members WHERE session_id=s.id) AND r.source_id=?)) OR EXISTS(SELECT 1 FROM task_comments c WHERE c.session_id IN (SELECT member_id FROM session_members WHERE session_id=s.id) AND c.task_id=?) OR EXISTS(SELECT 1 FROM audit_operations o JOIN audit_changes c ON c.operation_id=o.id WHERE o.session_id IN (SELECT member_id FROM session_members WHERE session_id=s.id) AND c.task_id=?))`,
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
      items: this.w
        .all<AgentSession>(
          `SELECT s.* ${sql} ORDER BY s.created_at DESC,s.id LIMIT ? OFFSET ?`,
          ...args,
          limit,
          cursor,
        )
        .map((row) => this.get(row.id)),
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
        this.w.graph.retire(r.id, r.name);
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
    if (
      this.w.one(
        "SELECT 1 FROM session_runtimes WHERE session_id IN (SELECT member_id FROM session_members WHERE session_id=?)",
        id,
      )
    ) {
      const native = this.w.one<{ provider: string; native_id: string }>(
        "SELECT provider,native_id FROM session_identities WHERE session_id=?",
        id,
      );
      if (
        !native ||
        native.native_id !== a.native_session_id ||
        native.provider !== sessionProvider(a.harness)
      )
        throw new AppError(
          "session_managed",
          "Managed session declarations must match the recorded provider and native identity",
          409,
        );
    }
    if (
      (a.source_namespace || a.native_session_id) &&
      (!a.source_namespace || !a.native_session_id)
    )
      throw new AppError("invalid_identity", "Supply both source_namespace and native_session_id");
    const session = this.ensure(id, String(a.harness), undefined, this.w.access.initialProject(a));
    const canonical = a.native_session_id
      ? this.identity.register(session.id, String(a.harness), String(a.native_session_id))
      : session.id;
    this.identity.enrich(session.id, {
      harness: String(a.harness),
      label: a.label as string | undefined,
      role_id: a.role_id as string | undefined,
      source_namespace: a.source_namespace as string | undefined,
      ...(a.project_id ? { project_id: this.w.access.initialProject(a)! } : {}),
    });
    return this.get(canonical);
  }
}
