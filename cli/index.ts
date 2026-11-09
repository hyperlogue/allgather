#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AppError,
  type Operation,
  operationName,
  operations,
  type Repository,
  type Task,
} from "../shared/contracts.ts";
import { PROJECT_ICON_MAX_BYTES } from "../shared/project-icon.ts";
import { parse } from "./args.ts";
import { Client } from "./client.ts";
import { currentOperator } from "./operator.ts";
import { readPairingCode } from "./pairing-code.ts";

export const HELP = `allgather — one work record for tasks, sessions, and evidence

  guide
  login [HOSTNAME_OR_URL]
  project list | create --name NAME [--slug CL] [--body TEXT] [--icon-file PNG_OR_JPEG]
  project show ID | update ID [--icon-file PNG_OR_JPEG | --remove-icon]
  task create --project ID --title TEXT [--body TEXT] [--parent ID]
  task search [QUERY] [--project ID] [--status open|blocked|closed]
  task ready [--assignee owner|session:ID|role:ID | --unassigned]
  task show ID | context ID
  task update ID [--title TEXT] [--body TEXT] [--parent ID]
  task comment ID --body TEXT [--reply ID] | comments ID
  task resolve ID [--comment TEXT] [--label REASON]
  task cancel ID [--comment TEXT] | reopen ID --reason TEXT
  task link ID --repository ID --commit SHA
  task block ID --waiting-on human|task|external [--waiting-on-task-id ID] --body TEXT
  task clear ID --blocker ID --comment TEXT
  task remove-blocker ID --blocker ID --comment TEXT
  task handoff ID --assignee KIND:ID --comment TEXT --expected-revision N --expected-log-sequence N
  role list | create --name NAME [--description TEXT] | update ID | delete ID
  session search [QUERY] [--project ID] [--task ID] [--machine ID] [--since ISO_DATE] [--until ISO_DATE]
  session list | show ID | declare ID [--harness NAME] [--role ID] [--label NAME]
  session bind-role ID --role ID
  task progress [ID] [--project ID] | task labels [--project ID]
  task plan create --project ID --file FILE
  link context ID | add --type LABEL --source-id ID --target-id ID
  link remove ID --reason TEXT | audit list [--task-id ID]
  repo add --project ID --name NAME --upstream URL [--branch main ...]
  repo update ID [--branch NAME ...] [--tag-regex REGEX] [--cache-policy metadata_only|allow_full_cache]
  repo list | sync ID | backfill ID --count N | clear-cache ID
  repo attach ID --project ID [--path-prefix PATH ...] [--remove]
  repo paths ID --project ID --path-prefix PATH ... | --clear-path-prefixes
  repo match ID [--path FILE ...]
  history search [QUERY] | show --repository ID --commit SHA
  history summary [--project ID] [--days 30] [--timezone UTC] | storage get
  artifact create --kind files|html|diff --title TEXT [--project ID] [--task ID]
  artifact publish ID --root DIR [--path PATH ...] [--ref REF] [--expected-seq N]
  artifact publish ID --patch FILE | --commit SHA | --base REF [--head WORKING|STAGED|REF]
  artifact list | search QUERY | show ID | edit ID [--title TEXT] [--input FILE]
  artifact files ID | source ID --path PATH | prompt ID
  artifact download ID --path PATH --output FILE | patch ID --output FILE
  artifact image ID --image IMAGE_ID --output FILE
  artifact comments ID [--all] [--no-ack] [--attachments-dir DIR]
  artifact thread-add ID --body TEXT [--target JSON] | comment THREAD --body TEXT
  artifact thread-edit THREAD --input FILE | thread-source THREAD
  artifact comment-show COMMENT | comment-edit COMMENT --body TEXT
  artifact claim THREAD ... | release THREAD ... | reanchor ID --input FILE
  artifact archive ID [--body TEXT] | restore ID | delete ID | listen ID | unlisten ID
  artifact submit ID | watchers ID | stat | gc [--apply]
  machine list | create --name NAME | show ID | update ID --name NAME --expected-revision N
  checkout list [--machine ID] [--repository ID] [--include-removed]
  session launch --machine ID --harness NAME --cwd PATH [--mode managed|terminal] [--project ID] [--label NAME] [--role ID] [--task ID]
  session prompt ID --body TEXT | cancel ID | runtime ID | commands ID | requests ID
  session reply --request ID --expected-revision N --response JSON
  session configure ID --config JSON | resume ID --machine ID --cwd PATH [--force]
  session reconcile --command ID --decision acknowledged|failed --reason TEXT
  session transcript events ID [--after N] | sources ID | import ID --input FILE
  request show ID | list
  api OPERATION --input FILE

Use --json for compact output. Mutations accept --key and --expected-revision.
Create a CLI pairing code in the owner web app, then paste it at the hidden login prompt.
Permissions are chosen in the web app. Use --pairing-code-stdin for noninteractive login.
Local lifecycle, browser passkey registration, and backups use the allgather-server executable.
Machine pairing and credential revocation use the owner web app.
Task fields: --label NAME (repeatable), --add-label NAME, --remove-label NAME,
  --clear-labels, --defer ISO_DATE, --undefer, --assignee owner|session:ID|role:ID|none.
Use --body-file FILE for a multiline task body or comment.
Project icon files: PNG/JPEG up to 1 MiB and 1024 × 1024 pixels; --remove-icon restores the default.
Filters: --labels-all NAME / --labels-any NAME, --parent ID, --epic ID,
  --deferred-before ISO_DATE / --deferred-after ISO_DATE, --exclude-undated,
  --is-done, --blocked, --needs-owner, --sort created|updated|title.
Deferral never prevents work. p0/p1/p2 are ordinary labels with no implicit order.
Project paths: --path-prefix is repeatable on repo add/attach/paths. Use . for the root.
  Empty lists provide no hint for shared repositories. Matching uses the longest prefix per file.
Repository URLs: --alias URL (repeatable), --clear-aliases; collection uses the primary URL.
Git budgets: --initial-fetch-limit 10000 --max-indexed-commits 100000|unlimited.
Operator: --operator-name NAME --operator-kind user|agent --agent-type TYPE --session ID.
A session may bind one role. Names and role declarations grant no access.
Session declare registers sessions started outside Allgather's Tower launch flow.
Workflow: ready → context → comment/update → resolve.
Completion is explicit. Allgather fetches upstream Git; Tower observes local checkouts.
`;
export async function main(argv = process.argv.slice(2)) {
  const { positional: p, flags: f } = parse(argv);
  const string = (key: string) => (typeof f[key] === "string" ? (f[key] as string) : undefined);
  const print = (value: unknown) =>
    console.log(JSON.stringify(value, null, f.json ? undefined : 2));
  if (!p.length || f.help || p[0] === "help") {
    console.log(HELP);
    return;
  }
  if (p[0] === "guide") {
    if (p.length > 1 || Object.keys(f).some((key) => key !== "json"))
      throw new Error("Use allgather guide without a project; task ready --project selects work.");
    const guide = {
      workflow: "ready → context → comment/update → resolve",
      guidance: [
        "Log in with allgather login <hostname-or-url>.",
        "Create a CLI pairing code and choose its permissions in the owner web app. Paste the code at the login prompt.",
        "Use task ready --project PROJECT --unassigned, or filter with --assignee session:ID / role:ID / owner. Read task context TASK before starting work.",
        "Assign work with task update TASK --assignee session:ID or role:ID. Keep work and evidence current.",
        "Use task resolve only when the requested work is complete.",
        "Keep the same --key, input, and revision guards when retrying an uncertain write.",
        "A handoff needs both --expected-revision and --expected-log-sequence from task context.",
        "Use --json for structured output and --body-file for multiline text.",
        "Operator names and roles describe attribution; they do not grant permissions.",
        "Use allgather help for commands; api OPERATION --input FILE accepts shared operations.",
      ],
    };
    if (f.json) print(guide);
    else
      console.log(["Allgather agent guide", "", guide.workflow, "", ...guide.guidance].join("\n"));
    return;
  }
  if (["server", "auth", "backup", "restore"].includes(p[0]))
    throw new Error(
      "Local server administration uses allgather-server. Run allgather-server help.",
    );
  if (f["key-file"])
    throw new Error("Recovery keys stay on the server. Use allgather login <hostname-or-url>.");
  if (p[0] === "login" && (p.length > 2 || (p[1] && f.url)))
    throw new Error("Use allgather login <hostname-or-url>.");
  const operatorKind = string("operator-kind");
  if (operatorKind && !["user", "agent"].includes(operatorKind))
    throw new Error("--operator-kind must be user or agent");
  const operator = currentOperator({
    operator_name: string("operator-name"),
    agent_type: string("agent-type"),
    operator_kind: operatorKind as "user" | "agent" | undefined,
    session_id: string("session"),
  });
  const client = new Client(
    p[0] === "login" ? (p[1] ?? string("url")) : string("url"),
    undefined,
    operator,
  );
  if (p[0] === "login") {
    if (f.scope !== undefined)
      throw new Error(
        "Choose CLI permissions when creating the pairing code in the web app; --scope is no longer supported.",
      );
    console.error(
      `Open ${client.url}/?view=connections and choose Connect CLI to create a pairing code.`,
    );
    await client.loginPairing(await readPairingCode(f["pairing-code-stdin"] === true));
    print({ authenticated: true, server: client.url });
    return;
  }
  if (p[0] === "artifact") {
    const { artifactCommand } = await import("./artifacts.ts");
    await artifactCommand(client, p, f);
    return;
  }
  let name: Operation,
    input: Record<string, unknown> = {};
  if (p[0] === "task" && p[1] === "plan" && p[2] === "create") {
    if (!f.file || !f.project) throw new Error("task plan create needs --project and --file");
    const plan = JSON.parse(readFileSync(String(f.file), "utf8"));
    name = "tasks_plan_create";
    input = {
      project_id: f.project,
      tasks: Array.isArray(plan) ? plan : plan.tasks,
      operation_key: f.key,
    };
  } else if (p[0] === "api") {
    name = operationName(p[1]);
    input = JSON.parse(readFileSync(String(f.input), "utf8"));
  } else {
    const groups: Record<string, string> = {
      project: "projects",
      task: "tasks",
      repo: "repositories",
      history: "history",
      role: "roles",
      session: "sessions",
      link: "links",
      audit: "audit",
      storage: "storage",
      request: "requests",
      machine: "machines",
      checkout: "checkouts",
    };
    const verbs: Record<string, string> = {
      list: ["task", "history"].includes(p[0]) ? "search" : "list",
      show: p[0] === "history" ? "get_commit" : "get",
      add: "create",
      connect: "update",
      link: "link_commit",
      "bind-role": "bind_role",
      "clear-cache": "clear_cache",
    };
    const taskSpecial: Record<string, string> = {
      comment: "task_comments_add",
      comments: "task_comments_list",
      clear: "tasks_clear_blocker",
      "remove-blocker": "tasks_remove_blocker",
    };
    const sessionOperations: Record<string, string> = {
      launch: "session_launch",
      prompt: "session_prompt",
      cancel: "session_cancel",
      runtime: "session_runtime_get",
      commands: "session_commands",
      requests: "session_requests",
      reply: "session_reply",
      configure: "session_configure",
      resume: "session_resume",
      reconcile: "session_reconcile",
    };
    name = operationName(
      p[0] === "session" && p[1] === "transcript"
        ? `session_transcript_${p[2]}`
        : p[0] === "repo" && p[1] === "paths"
          ? "repositories_set_paths"
          : p[0] === "repo" && p[1] === "match"
            ? "repositories_match_projects"
            : p[0] === "session" && sessionOperations[p[1]]
              ? sessionOperations[p[1]]
              : p[0] === "task" && taskSpecial[p[1]]
                ? taskSpecial[p[1]]
                : `${groups[p[0]] ?? p[0]}_${p[0] === "link" && p[1] === "add" ? "add" : (verbs[p[1]] ?? p[1] ?? "get")}`,
    );
    const aliases: Record<string, string> = {
      machine: "machine_id",
      task: "task_id",
      request: "request_id",
      command: "command_id",
      project: "project_id",
      epic: "epic_id",
      parent: "parent_id",
      repository: "repository_id",
      commit: "commit_id",
      key: "operation_key",
      session: "session_id",
      label: p[0] === "task" ? "labels" : "label",
      defer: "defer_until",
      role: "role_id",
      blocker: "blocker_id",
      reply: "reply_to",
      branch: "branches",
      upstream: "upstream_url",
      alias: "url_aliases",
      "path-prefix": "path_prefixes",
    };
    const omitted = new Set([
      "url",
      "json",
      "key-file",
      "body-file",
      "icon-file",
      "remove-icon",
      "add-label",
      "remove-label",
      "clear-labels",
      "clear-aliases",
      "clear-path-prefixes",
      "undefer",
      "exclude-undated",
      "pause",
      "resume",
    ]);
    const numeric = new Set([
      "days",
      "cursor",
      "limit",
      "expected_revision",
      "expected_log_sequence",
      "initial_fetch_limit",
      "max_indexed_commits",
      "count",
      "after",
    ]);
    for (const [flag, value] of Object.entries(f)) {
      if (omitted.has(flag)) continue;
      const key = aliases[flag] ?? flag.replaceAll("-", "_");
      input[key] = numeric.has(key) ? (value === "unlimited" ? null : Number(value)) : value;
    }
    if (f["icon-file"] || f["remove-icon"]) {
      if (!["projects_create", "projects_update"].includes(name))
        throw new Error("Project icons require project create or update");
      if (f["icon-file"] && f["remove-icon"])
        throw new Error("Choose --icon-file or --remove-icon");
      if (f["remove-icon"]) input.icon = null;
      else {
        const bytes = readFileSync(String(f["icon-file"]));
        if (bytes.length > PROJECT_ICON_MAX_BYTES)
          throw new Error("Project icons must be at most 1 MiB");
        input.icon = {
          media_type: bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : "image/png",
          base64: bytes.toString("base64"),
        };
      }
    }
    if (f["body-file"]) input.body = readFileSync(String(f["body-file"]), "utf8");
    if (f["clear-labels"]) input.labels = [];
    if (f["clear-aliases"]) input.url_aliases = [];
    if (f["clear-path-prefixes"]) input.path_prefixes = [];
    if (name === "repositories_match_projects") {
      input.paths = input.path ?? [];
      delete input.path;
    }
    if (f.undefer) input.defer_until = null;
    if (f["exclude-undated"]) input.include_undated = false;
    if (f.pause) input.sync_enabled = false;
    if (f.resume) input.sync_enabled = true;
    if (typeof input.assignee === "string") {
      const v = input.assignee;
      if (v === "none") input.assignee = null;
      else if (v === "owner") input.assignee = { kind: "owner", id: "owner" };
      else {
        const pos = v.indexOf(":");
        if (pos < 1) throw new Error("Use owner, session:ID, role:ID, or none for assignment");
        input.assignee = { kind: v.slice(0, pos), id: v.slice(pos + 1) };
      }
    }
    if (p[0] === "request" && p[2]) input.request_id = p[2];
    if (p[0] === "machine" && p[2]) input.machine_id = p[2];
    if (name === "session_transcript_import" && f.input) {
      input = { ...JSON.parse(readFileSync(String(f.input), "utf8")), ...input };
      delete input.input;
    }
    if (name === "session_prompt") {
      input.content = [{ type: "text", text: input.body ?? p.slice(3).join(" ") }];
      delete input.body;
    }
    for (const field of ["response", "config"])
      if (typeof input[field] === "string") input[field] = JSON.parse(input[field]);
    if (
      p[0] === "task" &&
      p[2] &&
      !["create", "search", "list", "ready", "labels", "progress"].includes(p[1])
    )
      input.task_id = p[2];
    if (p[0] === "project" && p[2]) input.project_id = p[2];
    if (name === "tasks_progress" && p[2]) input.epic_id = p[2];
    if (p[0] === "role" && p[2]) input.role_id = p[2];
    if (p[0] === "session" && p[1] === "transcript") {
      if (p[3]) input.target_session_id = p[3];
    } else if (p[0] === "session" && p[2] && !["search", "list", "launch"].includes(p[1]))
      input.target_session_id = p[2];
    if (name === "links_context" && p[2]) input.entity_id = p[2];
    if (p[0] === "link" && p[1] === "remove") input.relation_id = p[2];
    if (p[0] === "repo" && p[2]) input.repository_id = p[2];
    if (p[1] === "search" && p[2]) input.query = p.slice(2).join(" ");
  }
  if (operations[name].write) {
    input.operation_key ??= randomUUID();
    if (
      name === "tasks_handoff" &&
      (input.expected_revision === undefined || input.expected_log_sequence === undefined)
    )
      throw new AppError(
        "context_required",
        "Read task context, then supply its --expected-revision and --expected-log-sequence.",
      );
    if (
      input.task_id &&
      "expected_revision" in operations[name].schema.shape &&
      (input.expected_revision === undefined || f["add-label"] || f["remove-label"])
    ) {
      const t = await client.call<Task>("tasks_get", { task_id: input.task_id });
      input.expected_revision ??= t.revision;
      if (f["add-label"] || f["remove-label"]) {
        if (!["tasks_update", "tasks_resolve", "tasks_cancel"].includes(name))
          throw new Error("Label changes require task update, resolve, or cancel");
        const removed = new Set(
          ((f["remove-label"] as string[]) ?? []).map((s) => s.trim().toLowerCase()),
        );
        input.labels = [...t.labels, ...((f["add-label"] as string[]) ?? [])].filter(
          (s) => !removed.has(s.trim().toLowerCase()),
        );
      }
    }
    if (name === "repositories_set_paths" && input.expected_revision === undefined) {
      const repo = (await client.call<Repository[]>("repositories_list")).find(
        (r) => r.id === input.repository_id,
      );
      if (!repo) throw new Error("Repository not found");
      let link = repo.project_links.find((link) => link.project_id === input.project_id);
      if (!link) {
        const project = await client.call<{ id: string }>("projects_get", {
          project_id: input.project_id,
        });
        input.project_id = project.id;
        link = repo.project_links.find((link) => link.project_id === project.id);
      }
      if (!link) throw new Error("Project is not linked to this repository");
      input.expected_revision = link.revision;
    }
    if (name === "repositories_update") {
      const r = (await client.call<Repository[]>("repositories_list")).find(
        (r) => r.id === input.repository_id,
      );
      if (!r) throw new Error("Repository not found");
      input = {
        branches: r.branches,
        url_aliases: r.url_aliases,
        tag_regex: r.tag_regex,
        initial_fetch_limit: r.initial_fetch_limit,
        max_indexed_commits: r.max_indexed_commits,
        cache_policy: r.cache_policy,
        sync_enabled: !!r.sync_enabled,
        ...input,
      };
      input.expected_revision ??= r.revision;
    }
    if (
      input.expected_revision === undefined &&
      "expected_revision" in operations[name].schema.shape
    ) {
      if (name === "projects_update")
        input.expected_revision = (
          await client.call<{ revision: number }>("projects_get", { project_id: input.project_id })
        ).revision;
      else if (name === "sessions_bind_role")
        input.expected_revision = (
          await client.call<{ revision: number }>("sessions_get", {
            target_session_id: input.target_session_id,
          })
        ).revision;
      else if (name.startsWith("roles_"))
        input.expected_revision = (
          await client.call<{ id: string; revision: number }[]>("roles_list")
        ).find((r) => r.id === input.role_id)?.revision;
    }
  }
  print(await client.call(name, input));
}
if (import.meta.main)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error: {
          code: error instanceof AppError ? error.code : "command_failed",
          message: error.message,
          details: error instanceof AppError ? error.details : undefined,
        },
      }),
    );
    process.exitCode = 1;
  });
