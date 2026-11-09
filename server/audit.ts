import type { Database } from "bun:sqlite";
import type { OperatorContext, Principal } from "../shared/contracts.ts";

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const taskTables = new Set(["task_comments", "task_blockers"]);
const artifactTables = new Set([
  "artifacts",
  "artifact_versions",
  "version_files",
  "threads",
  "comments",
  "artifact_comments",
  "thread_anchors",
  "thread_anchor_frames",
  "message_attachments",
  "artifact_events",
  "viewed_marks",
]);
const guarded = new Set([
  ...artifactTables,
  "projects",
  "project_icons",
  "tasks",
  "operators",
  "agent_sessions",
  "roles",
  "project_repositories",
  "entities",
  "relations",
  ...taskTables,
]);
const observed = new Set([
  "machines",
  "checkouts",
  "checkout_observations",
  "session_runtimes",
  "transcript_sources",
  "session_commands",
  "session_events",
  "session_event_content",
  "session_requests",
  "session_assets",
]);
const tables = [
  ...guarded,
  "repositories",
  "commit_references",
  "thread_claims",
  "worker_registrations",
  "artifact_notifications",
  ...observed,
];

/** Capture domain writes inside the operator transaction. Sync/auth writes are excluded. */
export class Audit {
  private active: string | null = null;
  constructor(private db: Database) {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS operator_write_context(operation_id TEXT NOT NULL)");
    for (const table of tables) this.install(table);
    db.exec(
      "CREATE TEMP TRIGGER IF NOT EXISTS comments_immutable_update BEFORE UPDATE ON main.task_comments BEGIN SELECT RAISE(ABORT,'Task comments are append-only'); END",
    );
    db.exec(
      "CREATE TEMP TRIGGER IF NOT EXISTS comments_immutable_delete BEFORE DELETE ON main.task_comments BEGIN SELECT RAISE(ABORT,'Task comments are append-only'); END",
    );
  }
  private install(table: string) {
    const columns = (
      this.db.query(`PRAGMA table_info(${quoted(table)})`).all() as { name: string }[]
    ).map((c) => c.name);
    const snapshot = (row: "OLD" | "NEW") =>
      `json_object(${columns
        .filter(
          (c) =>
            !(table === "task_comments" && c === "body") &&
            !(table === "project_icons" && c === "bytes") &&
            !(table === "artifact_versions" && c === "patch_body") &&
            !(
              [
                "session_commands",
                "session_events",
                "session_requests",
                "session_event_content",
              ].includes(table) && ["payload", "response"].includes(c)
            ),
        )
        .flatMap((c) => [literal(c), `${row}.${quoted(c)}`])
        .concat(table === "task_comments" ? ["'body_length'", `length(${row}.body)`] : [])
        .join(",")})`;
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const row = operation === "DELETE" ? "OLD" : "NEW";
      const before = operation === "INSERT" ? "NULL" : snapshot("OLD");
      const after = operation === "DELETE" ? "NULL" : snapshot("NEW");
      const guardName = `audit_guard_${table}_${operation}`;
      this.db.exec(`DROP TRIGGER IF EXISTS temp.${quoted(guardName)}`);
      const configColumns = [
        "branches",
        "tag_regex",
        "initial_fetch_limit",
        "max_indexed_commits",
        "cache_policy",
        "id",
        "project_id",
        "name",
        "upstream_url",
        "url_aliases",
        "refs",
        "history_limit",
        "sync_enabled",
        "revision",
      ];
      const requireContext =
        table === "thread_claims"
          ? operation === "DELETE"
            ? "0"
            : "1"
          : guarded.has(table)
            ? "1"
            : table === "repositories"
              ? operation !== "UPDATE"
                ? "1"
                : configColumns.map((c) => `OLD.${quoted(c)} IS NOT NEW.${quoted(c)}`).join(" OR ")
              : table === "machines"
                ? operation !== "UPDATE"
                  ? "1"
                  : ["id", "name", "policy", "policy_revision", "revision"]
                      .map((c) => `OLD.${quoted(c)} IS NOT NEW.${quoted(c)}`)
                      .join(" OR ")
                : table === "session_commands"
                  ? operation === "INSERT"
                    ? "1"
                    : operation === "UPDATE"
                      ? [
                          "id",
                          "session_id",
                          "runtime_id",
                          "operation_id",
                          "request_key",
                          "kind",
                          "payload",
                        ]
                          .map((c) => `OLD.${quoted(c)} IS NOT NEW.${quoted(c)}`)
                          .join(" OR ")
                      : "0"
                  : "0";
      this.db.exec(
        `CREATE TEMP TRIGGER ${quoted(guardName)} BEFORE ${operation} ON main.${quoted(table)} WHEN (SELECT operation_id FROM temp.operator_write_context LIMIT 1) IS NULL AND (${requireContext}) BEGIN SELECT RAISE(ABORT,'Operator mutation requires an audit transaction'); END`,
      );
      const task =
        table === "tasks"
          ? `${row}.id`
          : taskTables.has(table)
            ? `${row}.task_id`
            : table === "relations"
              ? `(SELECT id FROM entities WHERE id=${row}.source_id AND kind='task')`
              : "NULL";
      const related =
        table === "task_blockers"
          ? `${row}.waiting_on_task_id`
          : table === "relations"
            ? `(SELECT id FROM entities WHERE id=${row}.target_id AND kind='task')`
            : "NULL";
      const project =
        table === "projects"
          ? `${row}.id`
          : columns.includes("project_id")
            ? `${row}.project_id`
            : table === "thread_claims"
              ? `(SELECT a.project_id FROM threads t JOIN artifacts a ON a.id=t.artifact_id WHERE t.id=${row}.thread_id)`
              : artifactTables.has(table) || table === "worker_registrations"
                ? `(SELECT project_id FROM artifacts WHERE id=${columns.includes("artifact_id") ? `${row}.artifact_id` : "NULL"})`
                : `(SELECT project_id FROM tasks WHERE id=${task})`;
      const artifactEntityId: Record<string, string> = {
        project_icons: `${row}.project_id`,
        artifact_versions: `${row}.artifact_id||'@'||${row}.seq`,
        version_files: `${row}.artifact_id||'@'||${row}.version_seq||':'||${row}.path`,
        thread_anchors: `${row}.thread_id`,
        thread_claims: `${row}.thread_id`,
        viewed_marks: `${row}.artifact_id||':'||${row}.key`,
      };
      const entityId =
        artifactEntityId[table] ??
        (table === "checkout_observations"
          ? `${row}.checkout_id`
          : table === "project_repositories"
            ? `${row}.project_id||'/'||${row}.repository_id`
            : `${row}.id`);
      const triggerName = `audit_capture_${table}_${operation}`;
      this.db.exec(`DROP TRIGGER IF EXISTS temp.${quoted(triggerName)}`);
      this.db.exec(`CREATE TEMP TRIGGER ${quoted(triggerName)} AFTER ${operation} ON main.${quoted(table)} WHEN (SELECT operation_id FROM temp.operator_write_context LIMIT 1) IS NOT NULL${operation === "UPDATE" ? ` AND (${before} IS NOT ${after})` : ""} BEGIN
        INSERT INTO audit_changes(operation_id,entity_type,entity_id,change_kind,project_id,task_id,related_task_id,before_value,after_value)
        VALUES((SELECT operation_id FROM temp.operator_write_context LIMIT 1),${literal(table)},${entityId},${literal(operation.toLowerCase())},${project},${task},${related},${before},${after}); END`);
    }
  }
  begin(
    id: string,
    operation: string,
    key: string,
    principal: Principal,
    operator: OperatorContext,
    at: string,
    details: Record<string, unknown>,
  ) {
    if (this.active) throw new Error("Nested operator audit transaction");
    this.active = id;
    this.db.query("INSERT INTO temp.operator_write_context VALUES(?)").run(id);
    this.db
      .query("INSERT INTO audit_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        principal.id,
        principal.inlet ?? "api",
        operator.id,
        operator.name,
        operator.kind,
        operator.agent_type,
        operator.session_id,
        operator.source,
        operation,
        key,
        at,
        JSON.stringify(details),
        operator.role_id,
        operator.role_name,
      );
  }
  end() {
    this.db.exec("DELETE FROM temp.operator_write_context");
    this.active = null;
  }
}
