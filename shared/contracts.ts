import { z } from "zod";
import type { ResourceGrants } from "./resource-grants.ts";
import type {
  HarnessControls,
  MachineScope,
  SessionControls,
  TerminalControls,
} from "./tower-acp.ts";
import type { CatalogSyncStatus } from "./tower-catalog.ts";
import { type TowerPolicyReport, type TowerPolicyRule, towerPolicy } from "./tower-policy.ts";

export const VERSION = "0.2.0";
export { type Scope, scopes } from "./permissions.ts";

import type { PermissionModes, Scope } from "./permissions.ts";
export interface Principal {
  permission_modes?: PermissionModes;
  approval_id?: string;
  grant_id?: string;
  resources?: ResourceGrants;
  id: string;
  scopes: readonly Scope[];
  kind: "owner" | "client";
  inlet?: "browser" | "api" | "mcp" | "tower";
  operator_name?: string;
  machine_id?: string;
  auth_binding?: { kind: "browser" | "oauth"; hash: string };
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const taskStates = ["open", "blocked", "closed"] as const;
export type TaskState = (typeof taskStates)[number];
export type Assignment = { kind: "owner"; id: "owner" } | { kind: "session" | "role"; id: string };
export interface Operator {
  id: string;
  kind: "user" | "agent" | "unknown";
  name: string;
  agent_type: string | null;
}
export interface OperatorContext extends Operator {
  session_id: string | null;
  source: string;
  role_id: string | null;
  role_name: string | null;
}
export interface Role {
  id: string;
  name: string;
  description: string;
  revision: number;
  created_at: string;
}
export interface AgentSession {
  project_id: string | null;
  id: string;
  agent_type: string;
  source_namespace: string | null;
  native_session_id: string | null;
  label: string | null;
  role_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface TaskComment {
  id: string;
  sequence: number;
  task_id: string;
  body: string;
  operator_id: string | null;
  operator_name: string;
  operator_kind: "user" | "agent" | "unknown";
  session_id: string | null;
  role_id: string | null;
  role_name: string | null;
  reply_to: string | null;
  created_at: string;
  legacy_event_id: number | null;
}
export interface Blocker {
  id: string;
  task_id: string;
  waiting_on: "human" | "external" | "task";
  waiting_on_task_id: string | null;
  body: string;
  resolution_comment_id: string | null;
  created_at: string;
  cleared_at: string | null;
  satisfied: boolean;
}
export interface Relation {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  reason: string;
  created_at: string;
}
export interface EpicProgress {
  id: string;
  title: string;
  total: number;
  done: number;
  closed_without_completion: number;
  open: number;
  blocked: number;
  percent_done: number;
  can_resolve: boolean;
}
export interface Project {
  id: string;
  slug: string;
  name: string;
  body: string;
  revision: number;
  created_at: string;
}
export interface Task {
  id: string;
  project_id: string;
  title: string;
  body: string;
  status: TaskState;
  is_done: boolean;
  labels: string[];
  defer_until: string | null;
  parent_id: string | null;
  assignee: Assignment | null;
  revision: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  blocked: boolean;
  needs_owner: boolean;
  dependencies: string[];
  child_count: number;
}
export interface TaskContext {
  task: Task;
  project: Project;
  dependencies: Task[];
  dependents: Task[];
  children: Task[];
  blockers: Blocker[];
  comments: Page<TaskComment> & { older_count: number };
  log_sequence: number;
  commits: { repository_id: string; commit_id: string; verified: number }[];
  related: Relation[];
  progress: EpicProgress | null;
}
export interface CommitFile {
  path: string;
  change?: "added" | "deleted" | "modified" | "type_changed";
  additions: number | null;
  deletions: number | null;
}
export interface GitCommit {
  id: string;
  parents: string[];
  message: string;
  author?: { name: string; email: string };
  committer?: { name: string; email: string };
  authored_at: string;
  committed_at: string;
  files: CommitFile[];
  files_complete: boolean;
  files_observed: boolean;
}
export interface RepositoryProject {
  project_id: string;
  path_prefixes: string[];
  revision: number;
}
export interface ProjectAttribution {
  project_ids: string[];
  project_id: string | null;
  basis: "single_project" | "path_prefix" | "unassigned";
  unmatched_paths: string[];
  ambiguous_paths: string[];
  paths_complete: boolean;
}
export interface IndexedCommit extends GitCommit {
  repository_id: string;
  project_attribution: ProjectAttribution;
}
export interface Repository {
  id: string;
  name: string;
  created_at: string;
  upstream_url: string | null;
  url_aliases: string[];
  branches: string[];
  tag_regex: string | null;
  initial_fetch_limit: number;
  max_indexed_commits: number | null;
  cache_policy: "metadata_only" | "allow_full_cache";
  actual_cache_mode: string;
  cache_cleanup: string;
  backfill_count: number;
  cleanup_requested: number;
  sync_enabled: number;
  sync_requested: number;
  sync_status: string;
  sync_error: string | null;
  last_sync_revision: number | null;
  last_attempt_at: string | null;
  next_sync_at: string | null;
  revision: number;
  project_ids: string[];
  project_links: RepositoryProject[];
}
export interface Page<T> {
  items: T[];
  total: number;
  next_cursor: number | null;
}
export const id = z.string().min(1).max(160);
export const text = z.string().trim().min(1).max(300);
export const note = z.string().max(128_000);
export const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const paging = {
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.number().int().min(0).default(0),
};
const repositoryPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.includes("\0") &&
      value.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
    "Use a repository-relative path without parent traversal",
  );
const pathPrefixes = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .transform((value) => value.replace(/^(\.\/)+/, "").replace(/\/+$/, ""))
      .pipe(z.union([z.literal("."), repositoryPath])),
  )
  .max(64)
  .transform((values) => [...new Set(values)].sort());
export const key = { operation_key: id };
export const revision = { ...key, expected_revision: z.number().int().positive() };
export const dateTime = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString());
const labels = z
  .array(z.string().trim().min(1).max(64))
  .max(40)
  .transform((v) => [...new Set(v.map((s) => s.toLowerCase()))].sort());
const assignment = z.union([
  z.object({ kind: z.literal("owner"), id: z.literal("owner") }).strict(),
  z.object({ kind: z.enum(["session", "role"]), id }).strict(),
]);
export const operatorMetadata = {
  operator_name: z.string().trim().min(1).max(160).optional(),
  operator_kind: z.enum(["user", "agent"]).optional(),
  agent_type: z.string().trim().min(1).max(80).optional(),
  operator_source: z.enum(["explicit", "cli_environment", "cli_process_tree"]).optional(),
  session_id: id.optional(),
};
export const spec = <S extends z.ZodObject>(
  schema: S,
  scope: Scope,
  description: string,
  write = false,
) => ({ schema: schema.safeExtend(operatorMetadata).strict(), scope, description, write });
const target = { task_id: id };
const change = { ...target, ...revision };
const taskFields = {
  title: text,
  body: note.default(""),
  labels: labels.default([]),
  defer_until: dateTime.nullable().default(null),
  assignee: assignment.nullable().default(null),
};
const taskFilters = {
  project_id: id.optional(),
  query: z.string().max(300).optional(),
  status: z.enum(taskStates).optional(),
  labels_all: labels.optional(),
  labels_any: labels.optional(),
  parent_id: id.optional(),
  epic_id: id.optional(),
  deferred_before: dateTime.optional(),
  deferred_after: dateTime.optional(),
  include_undated: z.boolean().default(true),
  is_done: z.boolean().optional(),
  blocked: z.boolean().optional(),
  needs_owner: z.boolean().optional(),
  assignee: assignment.optional(),
  unassigned: z.boolean().optional(),
  sort: z.enum(["updated", "created", "title"]).default("created"),
  ...paging,
};
const repositoryFields = {
  url_aliases: z.array(z.string().min(1).max(2048)).max(20).optional(),
  branches: z.array(z.string().min(1).max(1024)).min(1).max(100).default(["main"]),
  tag_regex: z.string().max(256).nullable().default(null),
  initial_fetch_limit: z.number().int().min(1).max(1_000_000).default(10_000),
  max_indexed_commits: z.number().int().min(1).max(10_000_000).nullable().default(100_000),
  cache_policy: z.enum(["metadata_only", "allow_full_cache"]).default("metadata_only"),
  sync_enabled: z.boolean().default(true),
};
export interface Machine {
  catalog_sync?: CatalogSyncStatus | null;
  id: string;
  name: string;
  host_id: string | null;
  capabilities: string[];
  harnesses: string[];
  harness_controls: Record<string, HarnessControls>;
  terminal_controls: Record<string, TerminalControls>;
  connection_scopes: MachineScope[];
  managed_enabled: boolean;
  tower_version: string | null;
  connected: boolean;
  last_seen_at: string | null;
  policy: TowerPolicyRule[];
  policy_report: TowerPolicyReport | null;
  policy_status: "pending" | "applied" | "rejected";
  policy_revision: number;
  revision: number;
  created_at: string;
}
export interface SessionRuntime {
  id: string;
  session_id: string;
  machine_id: string;
  /** Tower status reference scoped to machine_id; may be unresolved. Never execution authority. */
  checkout_id: string | null;
  cwd: string;
  tower_session_id: string | null;
  acp_session_id: string | null;
  native_session_id: string | null;
  protocol: string;
  controls: SessionControls | null;
  stop_requested: boolean;
  resume_requires_force: boolean;
  generation: string;
  state: "starting" | "idle" | "running" | "waiting" | "ended" | "error";
  connected: boolean;
  last_seen_at: string;
  owner_id: string | null;
  fenced: number;
  termination: "unknown" | "confirmed";
  active_prompt_id: string | null;
  loss_revision: number;
}
export interface SessionEvent {
  id: string;
  session_id: string;
  sequence: number;
  source_id: string;
  source_event_key: string;
  runtime_id: string | null;
  command_id: string | null;
  kind: string;
  payload_version: number;
  deleted_at?: string | null;
  payload: Record<string, unknown>;
  occurred_at: string | null;
  received_at: string;
  source_sequence: number | null;
}
export interface SessionCommand {
  id: string;
  session_id: string;
  runtime_id: string | null;
  operation_id: string;
  request_key: string;
  kind: "launch" | "resume" | "prompt" | "cancel" | "reply" | "configure";
  payload: Record<string, unknown>;
  state: "queued" | "sent" | "acknowledged" | "failed" | "unknown";
  result: unknown;
  created_at: string;
  updated_at: string;
}
const sessionTarget = { target_session_id: id };
const eventInput = z
  .object({
    key: id,
    kind: text,
    payload: z.record(z.string(), z.unknown()),
    at: dateTime.optional(),
    command_id: id.optional(),
  })
  .strict();
export const operations = {
  requests_get: spec(
    z.object({ request_id: id }),
    "sessions:read",
    "Read this connection's exact-request approval state and admission result. Approval is not proof that the coding agent finished.",
  ),
  requests_list: spec(
    z.object(paging),
    "sessions:read",
    "Find this connection's tracked approval requests and their private owner-review links.",
  ),
  artifacts_list: spec(
    z.object({
      state: z.enum(["active", "archived"]).optional(),
      kind: z.enum(["files", "html", "diff"]).optional(),
      project_id: id.optional(),
      ...paging,
    }),
    "artifacts:read",
    "List retained artifacts.",
  ),
  artifacts_get: spec(
    z.object({ artifact_id: id }),
    "artifacts:read",
    "Read artifact versions, discussion, and lifecycle history.",
  ),
  artifacts_create: spec(
    z.object({
      ...key,
      kind: z.enum(["files", "html", "diff"]),
      title: text.optional(),
      project_id: id.nullable().optional(),
      task_id: id.optional(),
      meta: z.record(z.string(), z.unknown()).default({}),
      remote_url: z.string().optional(),
    }),
    "artifacts:contribute",
    "Create an artifact with shared project and optional task context.",
    true,
  ),
  artifacts_publish: spec(
    z.object({
      ...key,
      artifact_id: id,
      expected_seq: z.number().int().nonnegative(),
      content: z.record(z.string(), z.unknown()),
      label: text.optional(),
      summary: note.optional(),
      provenance: z.record(z.string(), z.unknown()).default({}),
      task_id: id.optional(),
      listen: z.boolean().default(true),
    }),
    "artifacts:contribute",
    "Publish an immutable complete file/HTML capture or standalone diff.",
    true,
  ),
  artifacts_edit: spec(
    z.object({ ...key, artifact_id: id, input: z.record(z.string(), z.unknown()) }),
    "artifacts:contribute",
    "Edit artifact metadata.",
    true,
  ),
  artifacts_delete: spec(
    z.object({ ...key, artifact_id: id }),
    "artifacts:manage",
    "Delete artifact content. Deleted identity, context links, and usage history remain.",
    true,
  ),
  artifacts_archive: spec(
    z.object({ ...key, artifact_id: id, comment: note.optional() }),
    "artifacts:manage",
    "Archive an artifact with an optional separate comment.",
    true,
  ),
  artifacts_restore: spec(
    z.object({ ...key, artifact_id: id }),
    "artifacts:manage",
    "Restore an archived artifact.",
    true,
  ),
  artifacts_files: spec(
    z.object({ artifact_id: id, version_seq: z.number().int().positive() }),
    "artifacts:read",
    "List exact captured file membership.",
  ),
  artifacts_read_file: spec(
    z.object({
      artifact_id: id,
      version_seq: z.number().int().positive(),
      path: z.string().min(1).max(4096),
      start_line: z.number().int().positive().default(1),
      limit: z.number().int().min(1).max(1000).default(200),
    }),
    "artifacts:read",
    "Read a bounded range of captured UTF-8 source lines.",
  ),
  artifacts_search: spec(
    z.object({
      query: z.string().min(1).max(256),
      history: z.enum(["latest", "all"]).default("latest"),
      type: z.enum(["all", "content", "conversation"]).default("all"),
      state: z.enum(["active", "archived"]).optional(),
      kind: z.enum(["files", "html", "diff"]).optional(),
      project_id: id.optional(),
      attention: z.boolean().default(false),
      ...paging,
    }),
    "artifacts:read",
    "Search retained artifact content and conversations.",
  ),
  artifact_threads_add: spec(
    z.object({ ...key, artifact_id: id, input: z.record(z.string(), z.unknown()) }),
    "artifacts:contribute",
    "Create a native artifact/source/rendered/diff/media review thread.",
    true,
  ),
  artifact_threads_edit: spec(
    z.object({ ...key, thread_id: id, input: z.record(z.string(), z.unknown()) }),
    "artifacts:contribute",
    "Edit a thread message. Only the owner can change resolution.",
    true,
  ),
  artifact_threads_delete: spec(
    z.object({ ...key, thread_id: id }),
    "artifacts:manage",
    "Delete an editable thread and its replies.",
    true,
  ),
  artifact_comments_add: spec(
    z.object({ ...key, thread_id: id, input: z.record(z.string(), z.unknown()) }),
    "artifacts:contribute",
    "Reply with optional attachments and a guarded fix/re-anchor target.",
    true,
  ),
  artifact_comments_edit: spec(
    z.object({ ...key, comment_id: id, input: z.record(z.string(), z.unknown()) }),
    "artifacts:contribute",
    "Edit a native artifact comment with r3 author rules.",
    true,
  ),
  artifact_comments_get: spec(
    z.object({ comment_id: id }),
    "artifacts:read",
    "Read an opening, follow-up, or archive comment.",
  ),
  artifact_comments_fetch: spec(
    z.object({ artifact_id: id, threads: z.array(id).max(100).optional() }),
    "artifacts:read",
    "Fetch undelivered discussion and its exact acknowledgment fingerprint. Does not mark it delivered.",
  ),
  artifact_comments_ack: spec(
    z.object({ ...key, artifact_id: id, receipt: z.record(z.string(), z.unknown()) }),
    "artifacts:contribute",
    "Acknowledge the exact discussion snapshot after successful output.",
    true,
  ),
  artifact_threads_claim: spec(
    z.object({ ...key, thread_ids: z.array(id).min(1).max(100) }),
    "artifacts:contribute",
    "Claim review threads for the declared agent session.",
    true,
  ),
  artifact_threads_release: spec(
    z.object({ ...key, thread_ids: z.array(id).min(1).max(100) }),
    "artifacts:contribute",
    "Release this agent session’s review claims.",
    true,
  ),
  artifact_threads_reanchor: spec(
    z.object({ ...key, artifact_id: id, input: z.record(z.string(), z.unknown()) }),
    "artifacts:contribute",
    "Move current thread anchors in an atomic guarded batch. Original evidence remains immutable.",
    true,
  ),
  artifacts_listen: spec(
    z.object({
      ...key,
      artifact_id: id,
      mode: z.enum(["explicit", "fallback"]).default("explicit"),
    }),
    "artifacts:notify",
    "Subscribe this agent session to artifact notifications through Tower. Requires artifact read access.",
    true,
  ),
  artifacts_unlisten: spec(
    z.object({ ...key, artifact_id: id }),
    "artifacts:notify",
    "End this session’s artifact notification subscription.",
    true,
  ),
  artifacts_submit: spec(
    z.object({ ...key, artifact_id: id }),
    "artifacts:contribute",
    "Queue a review notification. Managed recipients also require session control and explicit machine consent.",
    true,
  ),
  artifacts_watchers: spec(
    z.object({ artifact_id: id }),
    "artifacts:read",
    "Read the selected review notification destination and connection state.",
  ),
  artifacts_usage: spec(
    z.object({ window: z.enum(["daily", "weekly"]).default("daily") }),
    "artifacts:read",
    "Read artifact usage and archived retention eligibility.",
  ),
  artifacts_gc: spec(
    z.object({ ...key, input: z.record(z.string(), z.unknown()) }),
    "admin",
    "Clean expired archived artifacts and unreferenced blobs. Shared session assets remain.",
    true,
  ),
  artifacts_viewed: spec(z.object({ artifact_id: id }), "artifacts:read", "Read viewed marks."),
  artifacts_mark_viewed: spec(
    z.object({ ...key, artifact_id: id, input: z.record(z.string(), z.unknown()) }),
    "artifacts:contribute",
    "Set a viewed mark.",
    true,
  ),
  machines_list: spec(
    z.object({}),
    "sessions:read",
    "List enrolled Tower machines and negotiated capabilities.",
  ),
  machines_get: spec(
    z.object({ machine_id: id }),
    "sessions:read",
    "Read a machine and its observed agent metadata.",
  ),
  machines_create: spec(
    z.object({ ...key, name: text }),
    "admin",
    "Enroll a Tower machine. Credentials are issued separately.",
    true,
  ),
  machines_update: spec(
    z.object({
      ...revision,
      machine_id: id,
      name: text.optional(),
      policy: towerPolicy.optional(),
    }),
    "admin",
    "Update a machine name or Tower policy.",
    true,
  ),
  checkouts_list: spec(
    z.object({
      machine_id: id.optional(),
      repository_id: id.optional(),
      include_removed: z.boolean().default(false),
    }),
    "sessions:read",
    "List dated local checkout facts. Use machine_id and Tower checkout_id together; legacy path reports have no checkout ID. Optional absent observations retain identity.",
  ),
  session_assets_add: spec(
    z.object({
      ...key,
      ...sessionTarget,
      name: z.string().max(300).optional(),
      media_type: z.string().max(160),
      data: z.string().max(28_000_000),
    }),
    "sessions:assets",
    "Capture an immutable transcript or prompt asset.",
    true,
  ),
  session_assets_list: spec(
    z.object(sessionTarget),
    "transcripts:read",
    "List captured assets owned by this session.",
  ),
  session_runtime_get: spec(
    z.object(sessionTarget),
    "sessions:read",
    "Read a session execution binding and queued commands.",
  ),
  transcript_retention_get: spec(
    z.object({}),
    "admin",
    "Read owner transcript retention settings.",
  ),
  transcript_retention_update: spec(
    z.object({
      ...key,
      expected_revision: z.number().int().positive(),
      days: z.number().int().min(1).max(3650).nullable(),
    }),
    "admin",
    "Owner browser only: configure captured transcript retention; null keeps history indefinitely.",
    true,
  ),
  transcript_delete_preview: spec(
    z.object(sessionTarget),
    "admin",
    "Preview the exact captured history boundary for owner deletion.",
  ),
  transcript_delete: spec(
    z.object({
      ...key,
      ...sessionTarget,
      through_sequence: z.number().int().nonnegative(),
      through_asset_sequence: z.number().int().nonnegative(),
    }),
    "admin",
    "Owner browser only: delete captured event bodies and unused assets through a preview boundary. Task, execution and audit records remain.",
    true,
  ),
  session_transcript_sources: spec(
    z.object(sessionTarget),
    "transcripts:read",
    "List history sources and coverage across native/ACP structured execution, external imports, and terminal lifecycle metadata.",
  ),
  session_transcript_events: spec(
    z.object({
      ...sessionTarget,
      after: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    "transcripts:read",
    "Read stored session events after a stable sequence, regardless of harness protocol. Terminal sources contain lifecycle metadata only.",
  ),
  session_transcript_import: spec(
    z.object({
      ...key,
      ...sessionTarget,
      source_key: id,
      format_version: text.default("native.v1"),
      coverage: z.enum(["complete", "partial", "unknown"]).default("unknown"),
      events: z.array(eventInput).max(200),
    }),
    "transcripts:import",
    "Import historical transcript events. Replays never create live approval requests.",
    true,
  ),
  session_launch: spec(
    z.object({
      ...key,
      machine_id: id,
      project_id: id.optional(),
      harness: text,
      mode: z.enum(["managed", "terminal"]).optional(),
      cwd: z.string().min(1).max(4096),
      role_id: id.optional(),
      task_id: id.optional(),
      label: text.optional(),
    }),
    "sessions:launch",
    "Launch an installed named harness through Tower with durable commands. mode defaults to managed; terminal requires negotiated terminal launch and explicit terminal:control consent.",
    true,
  ),
  session_prompt: spec(
    z.object({
      ...key,
      ...sessionTarget,
      content: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
    }),
    "sessions:prompt",
    "Queue a prompt only when this execution advertises the prompt control and input type; otherwise return unsupported_control. One prompt runs per session; unknown acceptance is never retried automatically.",
    true,
  ),
  session_cancel: spec(
    z.object({ ...key, ...sessionTarget }),
    "sessions:stop",
    "Queue cancellation independently of prompt input.",
    true,
  ),
  session_configure: spec(
    z.object({ ...key, ...sessionTarget, config: z.record(z.string(), z.unknown()) }),
    "sessions:configure",
    "Change negotiated session configuration.",
    true,
  ),
  session_resume: spec(
    z.object({
      ...key,
      ...sessionTarget,
      machine_id: id,
      cwd: z.string().min(1).max(4096),
      force: z.boolean().optional(),
    }),
    "sessions:resume",
    "Resume only when the machine and agent advertise support.",
    true,
  ),
  session_reply: spec(
    z.object({ ...revision, request_id: id, response: z.record(z.string(), z.unknown()) }),
    "sessions:reply",
    "Answer a currently live permission or elicitation request.",
    true,
  ),
  session_requests: spec(
    z.object(sessionTarget),
    "sessions:reply",
    "Read outstanding owner-response requests.",
  ),
  session_commands: spec(
    z.object({ ...sessionTarget, ...paging }),
    "sessions:read",
    "Read command acceptance and delivery state.",
  ),
  session_reconcile: spec(
    z.object({
      ...key,
      command_id: id,
      decision: z.enum(["acknowledged", "failed"]),
      reason: text,
    }),
    "sessions:reconcile",
    "Record an explicit reconciliation of unknown command acceptance. Does not resend.",
    true,
  ),
  projects_list: spec(z.object({}), "projects:read", "List projects."),
  projects_get: spec(z.object({ project_id: id }), "projects:read", "Read a project."),
  projects_create: spec(
    z.object({
      ...key,
      name: text,
      slug: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z][A-Z0-9]{0,15}$/)
        .optional(),
      body: note.default(""),
    }),
    "projects:write",
    "Create a project.",
    true,
  ),
  projects_update: spec(
    z.object({
      ...revision,
      project_id: id,
      slug: z.never().optional(),
      name: text.optional(),
      body: note.optional(),
    }),
    "projects:write",
    "Update a project with a revision guard.",
    true,
  ),
  tasks_search: spec(
    z.object(taskFilters),
    "tasks:read",
    "Search tasks. Date filters are explicit; defer_until has no automatic effect.",
  ),
  tasks_ready: spec(
    z.object(taskFilters),
    "tasks:read",
    "List open, unblocked tasks. Filter by assignee or unassigned explicitly; caller identity does not filter work. Apply date filters explicitly.",
  ),
  tasks_get: spec(z.object(target), "tasks:read", "Read a task and revision."),
  tasks_context: spec(
    z.object(target),
    "tasks:read",
    "Read the task, comments, blockers, prerequisites, children, and evidence.",
  ),
  tasks_create: spec(
    z.object({
      ...key,
      project_id: id,
      ...taskFields,
      parent_id: id.nullable().optional(),
      discovered_from: id.optional(),
    }),
    "tasks:write",
    "Create open work. A task with children is an epic.",
    true,
  ),
  tasks_update: spec(
    z.object({
      ...change,
      title: text.optional(),
      body: note.optional(),
      labels: labels.optional(),
      defer_until: dateTime.nullable().optional(),
      assignee: assignment.nullable().optional(),
      parent_id: id.nullable().optional(),
    }),
    "tasks:write",
    "Update task fields. Deferral is queryable data and does not prohibit work.",
    true,
  ),
  tasks_resolve: spec(
    z.object({ ...change, comment: note.optional(), labels: labels.optional() }),
    "tasks:write",
    "Resolve the task with is_done=true. All blockers must be satisfied. Parenthood is grouping only.",
    true,
  ),
  tasks_cancel: spec(
    z.object({ ...change, comment: note.optional(), labels: labels.optional() }),
    "tasks:write",
    "Close with is_done=false, even while blocked. Cancellation does not satisfy prerequisite blockers.",
    true,
  ),
  tasks_reopen: spec(
    z.object({ ...change, reason: text }),
    "tasks:write",
    "Reopen work while preserving its history.",
    true,
  ),
  tasks_link_commit: spec(
    z.object({ ...change, repository_id: id, commit_id: sha }),
    "tasks:write",
    "Reference a commit without changing task status.",
    true,
  ),
  tasks_block: spec(
    z
      .object({
        ...change,
        waiting_on: z.enum(["human", "task", "external"]),
        waiting_on_task_id: id.optional(),
        body: z.string().trim().min(1).max(32000),
      })
      .refine((v) => (v.waiting_on === "task") === !!v.waiting_on_task_id, {
        message: "Supply waiting_on_task_id only for a task blocker",
      }),
    "tasks:write",
    "Add a lightweight blocker. Task targets automatically satisfy when closed with is_done=true; human and external waits clear explicitly.",
    true,
  ),
  tasks_clear_blocker: spec(
    z.object({ ...change, blocker_id: id, comment: z.string().trim().min(1).max(128000) }),
    "tasks:write",
    "Explicitly clear a human or external blocker and record a comment. Task-backed blockers are automatic.",
    true,
  ),
  tasks_remove_blocker: spec(
    z.object({ ...change, blocker_id: id, comment: z.string().trim().min(1).max(128000) }),
    "tasks:write",
    "Remove a condition that is no longer required, recording why. History remains in the audit.",
    true,
  ),
  tasks_handoff: spec(
    z.object({
      ...change,
      expected_log_sequence: z.number().int().nonnegative(),
      assignee: assignment.nullable(),
      comment: z.string().trim().min(1).max(32000),
    }),
    "tasks:write",
    "Atomically change assignment and append context. Execution coordination is separate.",
    true,
  ),
  task_comments_list: spec(
    z.object({ ...target, ...paging }),
    "tasks:read",
    "Read append-only comments.",
  ),
  task_comments_add: spec(
    z.object({
      ...target,
      ...key,
      body: z.string().trim().min(1).max(128000),
      reply_to: id.optional(),
    }),
    "tasks:write",
    "Append a contribution or answer. Comments never implicitly clear blockers.",
    true,
  ),
  tasks_labels: spec(
    z.object({ project_id: id.optional() }),
    "tasks:read",
    "List ordinary labels and their task counts. Priority-like names have no special effects.",
  ),
  tasks_progress: spec(
    z.object({ project_id: id.optional(), epic_id: id.optional() }),
    "tasks:read",
    "Count descendant leaf tasks, separating completed work from closure without completion.",
  ),
  tasks_plan_create: spec(
    z.object({
      ...key,
      project_id: id,
      tasks: z
        .array(
          z
            .object({
              key: id,
              ...taskFields,
              parent_key: id.optional(),
              parent_id: id.optional(),
              depends_on_keys: z.array(id).max(100).default([]),
              depends_on: z.array(id).max(100).default([]),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    }),
    "tasks:write",
    "Create tasks and their structure atomically using request-local keys.",
    true,
  ),
  roles_list: spec(z.object({}), "tasks:read", "List roles. Roles have no access authority."),
  roles_create: spec(
    z.object({ ...key, name: text, description: note.default("") }),
    "tasks:write",
    "Create a role for assignment and attribution.",
    true,
  ),
  roles_update: spec(
    z.object({ ...revision, role_id: id, name: text.optional(), description: note.optional() }),
    "tasks:write",
    "Rename a role while preserving its identity.",
    true,
  ),
  roles_delete: spec(
    z.object({ ...revision, role_id: id }),
    "tasks:write",
    "Delete an unreferenced role.",
    true,
  ),
  sessions_list: spec(
    z.object({ role_id: id.optional(), query: z.string().max(300).optional(), ...paging }),
    "sessions:read",
    "List session identity metadata. Transcript access is separate.",
  ),
  sessions_search: spec(
    z.object({
      query: z.string().max(300).optional(),
      role_id: id.optional(),
      project_id: id.optional(),
      task_id: id.optional(),
      machine_id: id.optional(),
      since: dateTime.optional(),
      until: dateTime.optional(),
      ...paging,
    }),
    "sessions:read",
    "Find sessions by declared role, linked project/task, execution machine, and session creation time. Project/task filters also require tasks:read.",
  ),
  sessions_get: spec(
    z.object({ target_session_id: id }),
    "sessions:read",
    "Read session identity and declared role.",
  ),
  sessions_declare: spec(
    z.object({
      ...key,
      target_session_id: id,
      project_id: id.optional(),
      label: text.optional(),
      harness: text.default("unknown"),
      source_namespace: text.optional(),
      native_session_id: id.optional(),
      role_id: id.optional(),
    }),
    "sessions:identity",
    "Register or enrich an external session. Tower-launched sessions take metadata from launch and cannot be declared here. Does not start a process or grant execution authority.",
    true,
  ),
  sessions_bind_role: spec(
    z.object({ ...revision, target_session_id: id, role_id: id }),
    "sessions:identity",
    "Bind a session's role once. Repeating the same binding succeeds; a different role conflicts.",
    true,
  ),
  links_context: spec(
    z.object({
      entity_id: id,
      direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
      relation_type: z.string().trim().min(1).max(64).optional(),
      ...paging,
    }),
    "tasks:read",
    "Read context links whose endpoints are both readable.",
  ),
  links_add: spec(
    z.object({
      ...key,
      source_id: id,
      target_id: id,
      type: z.string().trim().min(1).max(64),
      reason: note.default(""),
    }),
    "tasks:write",
    "Add an informational context link. No label selects task workflow behavior.",
    true,
  ),
  links_remove: spec(
    z.object({ ...key, relation_id: id, reason: text }),
    "tasks:write",
    "Remove an informational context link.",
    true,
  ),
  audit_list: spec(
    z.object({
      project_id: id.optional(),
      task_id: id.optional(),
      operator_id: id.optional(),
      connection_id: id.optional(),
      run_id: id.optional(),
      entity_id: id.optional(),
      since: dateTime.optional(),
      until: dateTime.optional(),
      operation: z.string().optional(),
      ...paging,
    }),
    "admin",
    "Read operator mutations and their transactional changes.",
  ),
  repositories_list: spec(
    z.object({ project_id: id.optional() }),
    "repositories:read",
    "List shared repositories and collection coverage.",
  ),
  repositories_create: spec(
    z.object({
      ...key,
      project_id: id,
      name: text,
      upstream_url: z.string().min(1).max(2048),
      path_prefixes: pathPrefixes.optional(),
      ...repositoryFields,
    }),
    "repositories:write",
    "Connect an upstream repository for server-side Git collection.",
    true,
  ),
  repositories_update: spec(
    z.object({
      ...revision,
      repository_id: id,
      upstream_url: z.string().min(1).max(2048).optional(),
      name: text.optional(),
      url_aliases: repositoryFields.url_aliases,
      branches: repositoryFields.branches.removeDefault().optional(),
      tag_regex: repositoryFields.tag_regex.removeDefault().optional(),
      initial_fetch_limit: repositoryFields.initial_fetch_limit.removeDefault().optional(),
      max_indexed_commits: repositoryFields.max_indexed_commits.removeDefault().optional(),
      cache_policy: repositoryFields.cache_policy.removeDefault().optional(),
      sync_enabled: repositoryFields.sync_enabled.removeDefault().optional(),
    }),
    "repositories:write",
    "Configure collection, selected branches/tags, and retention.",
    true,
  ),
  repositories_attach: spec(
    z.object({
      ...key,
      repository_id: id,
      project_id: id,
      remove: z.boolean().default(false),
      path_prefixes: pathPrefixes.optional(),
    }),
    "repositories:write",
    "Share an upstream repository across projects without duplicating its index.",
    true,
  ),
  repositories_set_paths: spec(
    z.object({ ...revision, repository_id: id, project_id: id, path_prefixes: pathPrefixes }),
    "repositories:write",
    "Set path prefixes using the link revision from repositories_list. Longest literal prefix wins per file; . covers the root; empty supplies no hint for a shared repository.",
    true,
  ),
  repositories_match_projects: spec(
    z.object({
      repository_id: id,
      paths: z.array(repositoryPath).max(5000),
      paths_complete: z.boolean().default(true),
    }),
    "repositories:read",
    "Find projects by longest prefix per path. A single linked project wins directly; ties or unmatched paths do not force a single choice.",
  ),
  repositories_sync: spec(
    z.object({ ...key, repository_id: id }),
    "repositories:sync",
    "Request an upstream refresh.",
    true,
  ),
  repositories_backfill: spec(
    z.object({ ...key, repository_id: id, count: z.number().int().positive().max(1_000_000) }),
    "repositories:sync",
    "Explicitly request older commits within the retention budget.",
    true,
  ),
  repositories_clear_cache: spec(
    z.object({ ...key, repository_id: id }),
    "repositories:sync",
    "Queue cache cleanup without removing searchable metadata or references.",
    true,
  ),
  storage_get: spec(z.object({}), "admin", "Read measured storage use and sample time."),
  history_search: spec(
    z.object({
      project_id: id.optional(),
      repository_id: id.optional(),
      query: z.string().max(300).optional(),
      ...paging,
    }),
    "commits:read",
    "Search retained upstream commit messages with FTS5.",
  ),
  history_get_commit: spec(
    z.object({ repository_id: id, commit_id: sha }),
    "commits:read",
    "Read retained commit metadata or a stable reference whose metadata was evicted.",
  ),
  history_summary: spec(
    z.object({
      project_id: id.optional(),
      repository_id: id.optional(),
      days: z.number().int().min(1).max(366).default(30),
      timezone: z.string().max(100).default("UTC"),
    }),
    "commits:read",
    "Read commit frequency and touched paths with retention coverage.",
  ),
} as const;
export type Operation = keyof typeof operations;
export function can(principal: Principal, scope: Scope) {
  return principal.scopes.includes("admin") || principal.scopes.includes(scope);
}
export function operationName(name: string): Operation {
  if (!Object.hasOwn(operations, name)) throw new AppError("not_found", "Unknown operation", 404);
  return name as Operation;
}
