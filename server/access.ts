import type { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { AppError, type Operation, type Principal } from "../shared/contracts.ts";
import {
  noResources,
  type ResourceGrants,
  resourceGrantsSchema,
} from "../shared/resource-grants.ts";

type Input = Record<string, unknown>;
export class Access {
  private context = new AsyncLocalStorage<Principal>();
  constructor(private db: Database) {}
  run<T>(principal: Principal, work: (current: Principal) => T): T {
    let current = principal;
    if (principal.kind === "client" && principal.grant_id) {
      const grant = this.db
        .query(
          "SELECT g.scopes,g.resources,g.permissions FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.id=? AND g.client_id=? AND g.revoked=0 AND c.revoked=0",
        )
        .get(principal.grant_id, principal.id) as {
        scopes: string;
        resources: string;
        permissions: string;
      } | null;
      if (!grant)
        throw new AppError("grant_revoked", "This connection's access grant was revoked", 403);
      current = {
        ...principal,
        scopes: principal.scopes.filter((scope) => JSON.parse(grant.scopes).includes(scope)),
        resources: resourceGrantsSchema.parse(JSON.parse(grant.resources)),
        permission_modes: JSON.parse(grant.permissions),
      };
    }
    return this.context.run(current, () => work(current));
  }
  private get grants(): ResourceGrants | null {
    const p = this.context.getStore();
    return p?.kind === "client" ? (p.resources ?? noResources) : null;
  }
  get restricted() {
    return this.grants !== null;
  }
  private row<T>(sql: string, id: string) {
    return this.db.query(sql).get(id) as T | null;
  }
  private includes(ids: ResourceGrants["project_ids"], id: string) {
    return ids === "*" || ids.includes(id);
  }
  project(id: string | null) {
    const grants = this.grants;
    return !grants || (id === null ? grants.unassigned : this.includes(grants.project_ids, id));
  }
  machine(id: string) {
    return !this.grants || this.includes(this.grants.machine_ids, id);
  }
  task(id: string) {
    const row = this.row<{ project_id: string }>("SELECT project_id FROM tasks WHERE id=?", id);
    return !!row && this.project(row.project_id);
  }
  repository(id: string | null) {
    if (id === null) return this.project(null);
    const rows = this.db
      .query("SELECT project_id FROM project_repositories WHERE repository_id=?")
      .all(id) as { project_id: string }[];
    return rows.length ? rows.every((row) => this.project(row.project_id)) : this.project(null);
  }
  session(id: string) {
    const resolved =
      this.row<{ session_id: string }>("SELECT session_id FROM session_aliases WHERE alias=?", id)
        ?.session_id ?? id;
    const row = this.row<{ project_id: string | null }>(
      "SELECT project_id FROM agent_sessions WHERE id=?",
      resolved,
    );
    if (!row || !this.project(row.project_id)) return false;
    return (
      this.db
        .query("SELECT DISTINCT machine_id FROM session_runtimes WHERE session_id=?")
        .all(resolved) as { machine_id: string }[]
    ).every((r) => this.machine(r.machine_id));
  }
  artifact(id: string) {
    const row = this.row<{ project_id: string | null }>(
      "SELECT project_id FROM artifacts WHERE id=?",
      id,
    );
    return !!row && this.project(row.project_id);
  }
  entity(id: string) {
    const entity = this.row<{ kind: string; project_id: string | null }>(
      "SELECT kind,project_id FROM entities WHERE id=?",
      id,
    );
    if (!entity) {
      const match = /^commit:([^:]+):[a-f0-9]+$/.exec(id);
      return !!match && this.repository(match[1]);
    }
    if (entity.kind === "session") return this.session(id);
    if (entity.kind === "repository") return this.repository(id);
    if (entity.kind === "commit")
      return this.repository(
        this.row<{ repository_id: string }>(
          "SELECT repository_id FROM commit_references WHERE id=?",
          id,
        )?.repository_id ?? null,
      );
    if (entity.kind === "session_event") {
      const event = this.row<{ session_id: string }>(
        "SELECT session_id FROM session_events WHERE id=?",
        id,
      );
      return !!event && this.session(event.session_id);
    }
    if (entity.kind === "role") return this.project(null);
    return this.project(entity.project_id);
  }
  towerRecord(machine: string, record: Record<string, unknown>) {
    if (!this.machine(machine)) return false;
    const session = this.db
      .query(
        "SELECT session_id FROM session_runtimes WHERE machine_id=? AND tower_session_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(machine, String(record.id)) as { session_id: string } | null;
    if (session) return this.session(session.session_id);
    const checkout =
      typeof record.checkout_id === "string"
        ? (this.db
            .query("SELECT repository_id FROM tower_checkouts WHERE machine_id=? AND checkout_id=?")
            .get(machine, record.checkout_id) as { repository_id: string | null } | null)
        : null;
    return this.repository(checkout?.repository_id ?? null);
  }
  require(allowed: boolean) {
    if (!allowed)
      throw new AppError(
        "resource_not_granted",
        "This connection is not granted access to the requested project or machine",
        403,
      );
  }
  global() {
    const g = this.grants;
    return !g || (g.project_ids === "*" && g.machine_ids === "*" && g.unassigned);
  }
  projectSql(column: string) {
    const g = this.grants;
    if (!g) return { sql: "1=1", args: [] as (string | number)[] };
    return {
      sql: `((${column} IS NULL AND ?) OR (${column} IS NOT NULL AND ${g.project_ids === "*" ? "1=1" : `${column} IN (SELECT value FROM json_each(?))`}))`,
      args: [
        Number(g.unassigned),
        ...(g.project_ids === "*" ? [] : [JSON.stringify(g.project_ids)]),
      ],
    };
  }
  machineSql(column: string) {
    const g = this.grants;
    return !g || g.machine_ids === "*"
      ? { sql: "1=1", args: [] as string[] }
      : {
          sql: `${column} IN (SELECT value FROM json_each(?))`,
          args: [JSON.stringify(g.machine_ids)],
        };
  }
  repositorySql(column: string) {
    if (!this.grants) return { sql: "1=1", args: [] as (string | number)[] };
    const projects = this.projectSql("gr.project_id");
    return {
      sql: `(EXISTS(SELECT 1 FROM project_repositories gr WHERE gr.repository_id=${column}) OR ?) AND NOT EXISTS(SELECT 1 FROM project_repositories gr WHERE gr.repository_id=${column} AND NOT ${projects.sql})`,
      args: [Number(this.project(null)), ...projects.args],
    };
  }
  sessionSql(alias: string) {
    const project = this.projectSql(`${alias}.project_id`),
      machine = this.machineSql("gr.machine_id");
    return {
      sql: `${project.sql} AND NOT EXISTS(SELECT 1 FROM session_runtimes gr WHERE gr.session_id=${alias}.id AND NOT (${machine.sql}))`,
      args: [...project.args, ...machine.args],
    };
  }
  private artifactFor(kind: "thread" | "comment", id: string) {
    const known = this.row<{ artifact_id: string }>(
      "SELECT artifact_id FROM artifact_entities WHERE entity_id=?",
      id,
    )?.artifact_id;
    if (known) return known;
    return this.row<{ artifact_id: string }>(
      kind === "thread"
        ? "SELECT artifact_id FROM threads WHERE id=?"
        : "SELECT t.artifact_id FROM comments c JOIN threads t ON t.id=c.thread_id WHERE c.id=?",
      id,
    )?.artifact_id;
  }
  initialProject(a: Input): string | null {
    if (a.project_id === null) return null;
    if (typeof a.project_id === "string")
      return (
        (
          this.db
            .query("SELECT id FROM projects WHERE id=? OR name=?")
            .get(a.project_id, a.project_id) as { id: string } | null
        )?.id ?? a.project_id
      );
    if (typeof a.task_id === "string")
      return (
        this.row<{ project_id: string }>("SELECT project_id FROM tasks WHERE id=?", a.task_id)
          ?.project_id ?? null
      );
    if (typeof a.artifact_id === "string")
      return (
        this.row<{ project_id: string | null }>(
          "SELECT project_id FROM artifacts WHERE id=?",
          a.artifact_id,
        )?.project_id ?? null
      );
    if (typeof a.thread_id === "string" || typeof a.comment_id === "string") {
      const artifact = this.artifactFor(
        typeof a.thread_id === "string" ? "thread" : "comment",
        String(a.thread_id ?? a.comment_id),
      );
      return artifact
        ? (this.row<{ project_id: string | null }>(
            "SELECT project_id FROM artifacts WHERE id=?",
            artifact,
          )?.project_id ?? null)
        : null;
    }
    if (typeof a.blocker_id === "string")
      return (
        this.row<{ project_id: string }>(
          "SELECT t.project_id FROM task_blockers b JOIN tasks t ON t.id=b.task_id WHERE b.id=?",
          a.blocker_id,
        )?.project_id ?? null
      );
    return null;
  }
  inputs(name: Operation, a: Input) {
    if (!this.restricted || name.startsWith("requests_")) return;
    if (["audit_list", "storage_get", "artifacts_gc", "artifacts_usage"].includes(name))
      this.require(this.global());
    if (["roles_create", "roles_update", "roles_delete"].includes(name))
      this.require(this.project(null));
    if (name === "projects_create") this.require(this.grants!.project_ids === "*");
    if (name === "machines_create") this.require(this.grants!.machine_ids === "*");
    if (typeof a.project_id === "string") {
      const p = this.db
        .query("SELECT id FROM projects WHERE id=? OR name=?")
        .get(a.project_id, a.project_id) as { id: string } | null;
      this.require(!!p && this.project(p.id));
    }
    if (typeof a.machine_id === "string") this.require(this.machine(a.machine_id));
    if (typeof a.repository_id === "string") this.require(this.repository(a.repository_id));
    for (const key of ["task_id", "parent_id", "epic_id", "waiting_on_task_id"])
      if (typeof a[key] === "string") this.require(this.task(a[key]));
    if (
      typeof a.target_session_id === "string" &&
      (name !== "sessions_declare" ||
        this.row("SELECT id FROM agent_sessions WHERE id=?", a.target_session_id))
    )
      this.require(this.session(a.target_session_id));
    if (name === "session_launch" || name === "sessions_declare" || name === "artifacts_create")
      this.require(this.project(this.initialProject(a)));
    if (typeof a.artifact_id === "string") this.require(this.artifact(a.artifact_id));
    for (const [field, kind] of [
      ["thread_id", "thread"],
      ["comment_id", "comment"],
    ] as const)
      if (typeof a[field] === "string") {
        const artifact = this.artifactFor(kind, a[field]);
        this.require(!!artifact && this.artifact(artifact));
      }
    if (Array.isArray(a.thread_ids))
      for (const id of a.thread_ids) {
        const artifact = this.artifactFor("thread", String(id));
        this.require(!!artifact && this.artifact(artifact));
      }
    if (typeof a.entity_id === "string") this.require(this.entity(a.entity_id));
    if (name === "links_add") {
      this.require(this.entity(String(a.source_id)));
      this.require(this.entity(String(a.target_id)));
    }
    if (name === "links_remove") {
      const r = this.row<{ source_id: string; target_id: string }>(
        "SELECT source_id,target_id FROM relations WHERE id=?",
        String(a.relation_id),
      );
      this.require(!!r && this.entity(r.source_id) && this.entity(r.target_id));
    }
    for (const [field, table] of [
      ["request_id", "session_requests"],
      ["command_id", "session_commands"],
    ] as const)
      if (typeof a[field] === "string") {
        const row = this.row<{ session_id: string }>(
          `SELECT session_id FROM ${table} WHERE id=?`,
          a[field],
        );
        this.require(!!row && this.session(row.session_id));
      }
    if (typeof a.blocker_id === "string") {
      const row = this.row<{ task_id: string }>(
        "SELECT task_id FROM task_blockers WHERE id=?",
        a.blocker_id,
      );
      this.require(!!row && this.task(row.task_id));
    }
    if (name === "artifacts_edit") {
      const project = (a.input as Input)?.projectId;
      if (project !== undefined)
        this.require(this.project(project === null ? null : String(project)));
    }
  }
}
