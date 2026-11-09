import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AppError,
  can,
  type Operation,
  type OperatorContext,
  operations,
  type Principal,
  type Project,
  type Task,
} from "../shared/contracts.ts";
import { mcpOperations } from "../shared/mcp-surface.ts";
import type { ProjectIconUpload } from "../shared/project-icon.ts";
import { Access } from "./access.ts";
import { Approvals } from "./approvals.ts";
import { Artifacts } from "./artifacts.ts";
import { Audit } from "./audit.ts";
import { BlobStore, hashBytes } from "./blobs.ts";
import { connectionIdentity } from "./client-access.ts";
import { Executions } from "./executions.ts";
import { Graph } from "./graph.ts";
import { History } from "./history.ts";
import { projectIcon, setProjectIcon } from "./project-icons.ts";
import { availableProjectSlug } from "./project-slugs.ts";
import { Sessions } from "./sessions.ts";
import { Tasks } from "./tasks.ts";
import { Transcripts } from "./transcripts.ts";

type Input = Record<string, unknown>;
export const uid = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export class Workspace {
  readonly transcripts: Transcripts;
  readonly approvals: Approvals;
  readonly access: Access;
  readonly history: History;
  readonly graph: Graph;
  readonly tasks: Tasks;
  readonly sessions: Sessions;
  readonly executions: Executions;
  readonly blobs?: BlobStore;
  readonly artifacts?: Artifacts;
  private writingOperation?: string;
  private audit: Audit;
  private writingOperator?: OperatorContext;
  private writingPrincipal?: Principal;
  constructor(
    readonly db: Database,
    readonly clock: () => Date = () => new Date(),
    readonly onChange: () => void = () => {},
    readonly options: {
      dataDir?: string;
      allowLocalGit?: boolean;
      managedSessions?: boolean;
    } = {},
  ) {
    this.access = new Access(db);
    this.history = new History(this);
    this.graph = new Graph(this);
    this.tasks = new Tasks(this);
    this.sessions = new Sessions(this);
    this.executions = new Executions(this);
    if (options.dataDir) this.blobs = new BlobStore(join(options.dataDir, "blobs"));
    this.audit = new Audit(db);
    if (this.blobs) this.artifacts = new Artifacts(this, this.blobs);
    this.approvals = new Approvals(this);
    this.transcripts = new Transcripts(this);
  }
  get managedSessions() {
    return this.options.managedSessions ?? true;
  }
  one<T>(sql: string, ...args: SQLQueryBindings[]) {
    return this.db.query(sql).get(...args) as T | null;
  }
  all<T>(sql: string, ...args: SQLQueryBindings[]) {
    return this.db.query(sql).all(...args) as T[];
  }
  run(sql: string, ...args: SQLQueryBindings[]) {
    return this.db.query(sql).run(...args);
  }
  now() {
    return this.clock().toISOString();
  }
  project(id: string) {
    const project = this.one<Project>(
      "SELECT id,name,slug,body,revision,created_at FROM projects WHERE id=? OR name=?",
      id,
      id,
    );
    if (!project) throw new AppError("not_found", "Project not found", 404);
    this.access.require(this.access.project(project.id));
    return { ...project, icon: projectIcon(this.db, project.id) };
  }
  projectScope(a: Input): string[] | null {
    if (a.project_id !== undefined && a.project_ids !== undefined)
      throw new AppError("invalid_filter", "Use either project_id or project_ids, not both");
    const ids =
      a.project_ids !== undefined
        ? (a.project_ids as string[])
        : a.project_id
          ? [String(a.project_id)]
          : null;
    return ids && [...new Set(ids.map((id) => this.project(id).id))];
  }
  projectScopeSql(column: string, projects: string[] | null) {
    const json = projects && JSON.stringify(projects);
    return {
      sql: `(? IS NULL OR ${column} IN (SELECT value FROM json_each(?)))`,
      args: [json, json],
    };
  }
  task(id: string): Task {
    return this.tasks.get(id);
  }
  get operator() {
    if (!this.writingOperator) throw new Error("Operator context is not active");
    return this.writingOperator;
  }
  get operationId() {
    if (!this.writingOperation) throw new Error("Operation context is not active");
    return this.writingOperation;
  }
  get principal() {
    if (!this.writingPrincipal) throw new Error("Principal context is not active");
    return this.writingPrincipal;
  }
  identify(principal: Principal, a: Input): OperatorContext {
    const browser = principal.inlet === "browser",
      agent = !browser && (principal.inlet === "mcp" || a.operator_kind === "agent");
    const session = agent && a.session_id ? this.sessions.resolve(String(a.session_id)) : null;
    if (session && this.one("SELECT 1 FROM agent_sessions WHERE id=?", session))
      this.access.require(this.access.session(session));
    const known =
      session && this.one("SELECT 1 FROM agent_sessions WHERE id=?", session)
        ? this.sessions.get(session)
        : null;
    const role = known?.role_id ? this.sessions.role(known.role_id) : null;
    return {
      id: agent
        ? `operator-${digest(session ? `session:${session}` : `unknown:${principal.id}`).slice(0, 24)}`
        : "operator-owner",
      kind: agent ? "agent" : "user",
      name: agent
        ? String(
            a.operator_name ?? known?.label ?? principal.operator_name ?? a.agent_type ?? "Agent",
          )
        : "Owner",
      agent_type: agent ? String(a.agent_type ?? known?.agent_type ?? "unknown") : null,
      session_id: session,
      source: browser
        ? "browser"
        : principal.inlet === "mcp"
          ? "mcp"
          : String(a.operator_source ?? "explicit"),
      role_id: role?.id ?? null,
      role_name: role?.name ?? null,
    };
  }
  ensureOperator(operator: OperatorContext, projectId: string | null = null) {
    this.run(
      "INSERT OR IGNORE INTO operators VALUES(?,?,?,?,?)",
      operator.id,
      operator.kind,
      operator.name,
      operator.agent_type,
      this.now(),
    );
    if (operator.kind !== "agent" || !operator.session_id) return null;
    return this.sessions.ensure(
      operator.session_id,
      operator.agent_type ?? "unknown",
      operator.name,
      projectId,
    ).id;
  }
  participation(taskId: string) {
    if (this.operator.kind !== "agent" || !this.operator.session_id) return;
    const run = this.ensureOperator(this.operator);
    if (run) this.graph.add("works_on", run, taskId);
  }
  async dispatch(
    name: Operation,
    input: unknown,
    principal: Principal,
    options: { waitMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    return this.access.run(principal, (current) =>
      this.dispatchScoped(name, input, current, options),
    );
  }
  private async dispatchScoped(
    name: Operation,
    input: unknown,
    principal: Principal,
    options: { waitMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (principal.inlet === "mcp" && !mcpOperations.has(name))
      throw new AppError("not_found", "Operation is not available through MCP", 404);
    if (this.approvals.requires(name, principal))
      return this.approvals.request(name, input, principal, options);
    if (/^artifacts?_/.test(name)) {
      if (!this.artifacts)
        throw new AppError("storage_unavailable", "Artifact storage is not configured", 503);
      return this.artifacts.run(name, input, principal);
    }
    if (name.startsWith("transcript_")) {
      const result = this.execute(name, input, principal);
      if (name === "transcript_delete") await this.artifacts?.collectBlobs();
      if (name === "transcript_retention_update") await this.transcripts.sweep();
      return result;
    }
    if (name !== "session_assets_add") return this.execute(name, input, principal);
    if (!can(principal, operations[name].scope))
      throw new AppError("forbidden", "Session write access is required", 403);
    const parsed = operations[name].schema.safeParse(input);
    if (!parsed.success)
      throw new AppError("invalid_input", "Invalid session asset", 400, parsed.error.flatten());
    const a = parsed.data as {
      target_session_id: string;
      media_type: string;
      data: string;
      name?: string;
    };
    this.access.inputs(name, parsed.data);
    this.sessions.get(a.target_session_id);
    if (!this.blobs)
      throw new AppError("storage_unavailable", "Blob storage is not configured", 503);
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(a.media_type))
      throw new AppError("invalid_media", "Invalid media type");
    const bytes = Buffer.from(a.data, "base64");
    if (bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== a.data)
      throw new AppError("invalid_asset", "Use canonical base64 for an asset up to 20 MiB");
    this.executions.assetIdentity(
      a.target_session_id,
      null,
      hashBytes(bytes),
      a.media_type,
      a.name ?? null,
    );
    return this.blobs.publishing(async () => {
      const blob = await this.blobs!.put(bytes);
      return this.execute(name, input, principal, () =>
        this.executions.attachAsset(a.target_session_id, null, blob, a.media_type, a.name ?? null),
      );
    });
  }
  execute(
    name: Operation,
    input: unknown,
    principal: Principal,
    prepared?: () => unknown,
  ): unknown {
    return this.access.run(principal, (current) =>
      this.executeScoped(name, input, current, prepared),
    );
  }
  private executeScoped(
    name: Operation,
    input: unknown,
    principal: Principal,
    prepared?: () => unknown,
  ): unknown {
    const definition = operations[name];
    if (!can(principal, definition.scope))
      throw new AppError("forbidden", `Scope ${definition.scope} is required`, 403);
    const parsed = definition.schema.safeParse(input);
    if (!parsed.success)
      throw new AppError("invalid_input", "Invalid request", 400, parsed.error.flatten());
    const a = parsed.data as Input;
    this.access.inputs(name, a);
    if (name.startsWith("transcript_")) this.transcripts.authorize(principal);
    if (this.approvals.requires(name, principal) && !this.approvals.permits(name, a, principal))
      throw new AppError(
        "needs_approval",
        "This exact request needs owner approval through Workspace.dispatch",
        403,
      );
    if (!definition.write) return this.read(name, a, principal);
    return this.recordWrite(name, a, principal, prepared ?? (() => this.write(name, a, principal)));
  }
  // Internal notification admission has its own audit receipt before an archive commits.
  // It is deliberately not an HTTP/MCP operation or an alternate session-control grant.
  recordNotification(input: Input, principal: Principal, work: () => unknown) {
    if (!can(principal, "artifacts:contribute") && !can(principal, "artifacts:manage"))
      throw new AppError("forbidden", "Artifact write access is required", 403);
    return this.recordWrite("artifact_notification_queue", input, principal, work);
  }
  recordSessionObservation(machineId: string, work: () => unknown) {
    if (!this.one("SELECT 1 FROM machines WHERE id=?", machineId))
      throw new AppError("not_found", "Machine not found", 404);
    return this.recordWrite(
      "session_identity_observed",
      {
        operation_key: uid("observation"),
        operator_kind: "agent",
        operator_name: "Tower",
        agent_type: "tower",
      },
      {
        id: `tower:${machineId}`,
        kind: "owner",
        inlet: "tower",
        machine_id: machineId,
        scopes: [],
      },
      work,
    );
  }
  private recordWrite(name: string, a: Input, principal: Principal, work: () => unknown): unknown {
    const inputHash =
      name === "session_reply" ? this.executions.privateFingerprint(a) : digest(canonical(a));
    let changed = false;
    const result = this.db
      .transaction(() => {
        const old = this.one<{ operation: string; hash: string; result: string }>(
          "SELECT * FROM operations WHERE actor=? AND key=?",
          principal.id,
          a.operation_key as string,
        );
        if (old) {
          if (old.operation !== name || old.hash !== inputHash)
            throw new AppError(
              "key_conflict",
              "This operation key belongs to a different request",
              409,
            );
          return JSON.parse(old.result);
        }
        const operator = this.identify(principal, a),
          auditId = uid("audit");
        this.writingOperator = operator;
        this.writingPrincipal = principal;
        this.writingOperation = auditId;
        try {
          const details = Object.fromEntries(
            [
              "task_id",
              "project_id",
              "repository_id",
              "relation_id",
              "blocker_id",
              "handoff_id",
              "reason",
              "runtime_id",
              "expected_loss_revision",
              "artifact_id",
              "registration_id",
              "event",
            ]
              .filter((k) => a[k] !== undefined)
              .map((k) => [k, a[k]]),
          );
          this.audit.begin(
            auditId,
            name,
            a.operation_key as string,
            principal,
            operator,
            this.now(),
            details,
          );
          this.ensureOperator(operator, this.access.initialProject(a));
          const value = work();
          let final: unknown = value;
          if (
            value &&
            typeof value === "object" &&
            "id" in value &&
            name.startsWith("tasks_") &&
            this.one("SELECT 1 FROM tasks WHERE id=?", String(value.id))
          )
            final = this.task(String(value.id));
          else if (name === "tasks_plan_create") {
            const plan = value as { tasks: Task[]; mapping: Record<string, string> };
            final = { ...plan, tasks: plan.tasks.map((t) => this.task(t.id)) };
          }
          if (final && typeof final === "object" && !Array.isArray(final)) {
            const annotated = { ...final, audit_id: auditId };
            final = annotated;
            if (operator.session_id && name.startsWith("tasks_")) {
              const identity = this.sessions.get(operator.session_id);
              if (identity.identity_warnings?.length)
                final = {
                  ...annotated,
                  warnings: identity.identity_warnings.map((warning) => ({
                    code: "session_merge_conflict",
                    session_id: identity.id,
                    field: warning.field,
                    message: warning.message,
                  })),
                };
            }
          }
          this.run(
            "INSERT INTO operations VALUES(?,?,?,?,?)",
            principal.id,
            a.operation_key as string,
            name,
            inputHash,
            JSON.stringify(final),
          );
          changed = true;
          return final;
        } finally {
          this.writingOperator = undefined;
          this.writingPrincipal = undefined;
          this.writingOperation = undefined;
          this.audit.end();
        }
      })
      .immediate();
    if (changed) this.onChange();
    return result;
  }
  page<T>(items: T[], a: Input) {
    const start = Number(a.cursor ?? 0),
      limit = Number(a.limit ?? 50);
    return {
      items: items.slice(start, start + limit),
      total: items.length,
      next_cursor: start + limit < items.length ? start + limit : null,
    };
  }
  private read(name: Operation, a: Input, principal: Principal): unknown {
    if (name.startsWith("transcript_")) return this.transcripts.read(name, a);
    if (name === "requests_get") return this.approvals.get(String(a.request_id), principal);
    if (name === "requests_list") return this.approvals.list(a, principal);
    if (/^(machines_|checkouts_|session_)/.test(name))
      return this.executions.read(name, a, principal);
    if (name.startsWith("history_") || name.startsWith("repositories_") || name === "storage_get")
      return this.history.read(name, a, principal);
    if (name === "projects_list")
      return this.all<Project>(
        "SELECT id,name,slug,body,revision,created_at FROM projects ORDER BY name,id",
      )
        .filter((project) => this.access.project(project.id))
        .map((project) => ({ ...project, icon: projectIcon(this.db, project.id) }));
    if (name === "projects_get") return this.project(a.project_id as string);
    if (name.startsWith("roles_") || name.startsWith("sessions_"))
      return this.sessions.read(name, a, principal);
    if (name === "links_context") return this.graph.context(a, principal);
    if (name === "audit_list") return this.auditList(a);
    return this.tasks.read(name, a, principal);
  }
  private write(name: Operation, a: Input, principal: Principal): unknown {
    if (name.startsWith("transcript_")) return this.transcripts.write(name, a);
    if (/^(machines_|checkouts_|session_)/.test(name))
      return this.executions.write(name, a, principal);
    if (name.startsWith("roles_") || name.startsWith("sessions_"))
      return this.sessions.write(name, a);
    if (name.startsWith("repositories_")) {
      const result = this.history.write(name, a) as { id: string; project_id: string };
      this.graph.ensure(result.id, "repository");
      return result;
    }
    if (name === "projects_create") {
      if (this.one("SELECT 1 FROM projects WHERE name=?", a.name as string))
        throw new AppError("name_conflict", "A project with this name exists", 409);
      const id = uid("prj");
      const slug = (a.slug as string | undefined) ?? availableProjectSlug(this.db, String(a.name));
      if (this.one("SELECT 1 FROM projects WHERE slug=?", slug))
        throw new AppError("slug_conflict", "A project with this slug exists", 409);
      this.run(
        "INSERT INTO projects(id,name,slug,description,body,created_at) VALUES(?,?,?,'',?,?)",
        id,
        a.name as string,
        slug,
        a.body as string,
        this.now(),
      );
      if (a.icon !== undefined) setProjectIcon(this.db, id, a.icon as ProjectIconUpload | null);
      this.graph.ensure(id, "project", id);
      return this.project(id);
    }
    if (name === "projects_update") {
      const project = this.project(String(a.project_id));
      if (project.revision !== a.expected_revision)
        throw new AppError("revision_conflict", "Read the current project revision", 409);
      if (
        a.name &&
        this.one("SELECT 1 FROM projects WHERE name=? AND id!=?", String(a.name), project.id)
      )
        throw new AppError("name_conflict", "A project with this name exists", 409);
      this.run(
        "UPDATE projects SET name=?,body=?,revision=revision+1 WHERE id=?",
        String(a.name ?? project.name),
        String(a.body ?? project.body),
        project.id,
      );
      if (a.icon !== undefined)
        setProjectIcon(this.db, project.id, a.icon as ProjectIconUpload | null);
      return this.project(project.id);
    }
    if (name.startsWith("links_")) return this.graph.write(name, a, principal);
    return this.tasks.write(name, a, principal);
  }
  private auditList(a: Input) {
    const projects = this.projectScope(a);
    const entity = a.entity_id ? this.sessions.resolve(String(a.entity_id)) : null;
    const rows = this.all<Record<string, unknown>>(
      "SELECT * FROM audit_operations ORDER BY at DESC,rowid DESC",
    ).filter(
      (op) =>
        (!a.operator_id || op.operator_id === a.operator_id) &&
        (!a.connection_id || op.connection_id === a.connection_id) &&
        (!a.operation || op.operation === a.operation) &&
        (!a.run_id ||
          (op.session_id &&
            this.sessions.resolve(String(op.session_id)) ===
              this.sessions.resolve(String(a.run_id)))) &&
        (!a.since || String(op.at) >= String(a.since)) &&
        (!a.until || String(op.at) <= String(a.until)) &&
        (!a.entity_id ||
          this.one(
            "SELECT 1 FROM audit_changes WHERE operation_id=? AND (entity_id=? OR entity_id IN (SELECT member_id FROM session_members WHERE session_id=?))",
            op.id as string,
            entity,
            entity,
          )) &&
        (!projects ||
          this.one(
            "SELECT 1 FROM audit_changes WHERE operation_id=? AND project_id IN (SELECT value FROM json_each(?))",
            op.id as string,
            JSON.stringify(projects),
          )) &&
        (!a.task_id ||
          this.one(
            "SELECT 1 FROM audit_changes WHERE operation_id=? AND (task_id=? OR related_task_id=?)",
            op.id as string,
            a.task_id as string,
            a.task_id as string,
          )),
    );
    const page = this.page(rows, a);
    return {
      ...page,
      items: page.items.map((op) => ({
        ...op,
        connection: connectionIdentity(this.db, String(op.connection_id)),
        details: JSON.parse(String(op.details)),
        changes: this.all<
          { before_value: string | null; after_value: string | null } & Record<string, unknown>
        >(
          "SELECT * FROM audit_changes WHERE operation_id=? ORDER BY sequence",
          op.id as string,
        ).map((change) => ({
          ...change,
          before: change.before_value ? JSON.parse(change.before_value) : null,
          after: change.after_value ? JSON.parse(change.after_value) : null,
          before_value: undefined,
          after_value: undefined,
        })),
      })),
    };
  }
}
