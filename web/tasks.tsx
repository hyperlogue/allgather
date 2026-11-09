import { Fragment, useEffect, useState } from "react";
import { connectionActorLabel } from "../shared/client-access.ts";
import type {
  AgentSession,
  Assignment,
  Operation,
  Page,
  Repository,
  Role,
  Task,
  TaskComment,
  TaskContext,
} from "../shared/contracts.ts";
import { call, mutation } from "./api.ts";
import { ContextLink } from "./context.tsx";
import { TaskBlocker, TaskMarkdown } from "./task-blocker.tsx";
import { Dialog, ErrorText, PageHeading, useAction } from "./ui.tsx";

function useDraft<T>(key: string, initial: T): [T, (value: T) => void, () => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? initial;
    } catch {
      return initial;
    }
  });
  return [
    value,
    (v) => {
      setValue(v);
      sessionStorage.setItem(key, JSON.stringify(v));
    },
    () => sessionStorage.removeItem(key),
  ];
}
const parseLabels = (s: string) =>
  s
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const assignmentValue = (a: Assignment | null) => (a ? `${a.kind}:${a.id}` : "");
const parseAssignment = (s: string): Assignment | null =>
  !s
    ? null
    : s === "owner:owner"
      ? { kind: "owner", id: "owner" }
      : { kind: s.startsWith("role:") ? "role" : "session", id: s.slice(s.indexOf(":") + 1) };
function AssignmentField({
  value,
  set,
  roles,
  sessions,
}: {
  value: string;
  set: (s: string) => void;
  roles: Role[];
  sessions: AgentSession[];
}) {
  return (
    <label>
      Assigned to
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Unassigned</option>
        <option value="owner:owner">Owner</option>
        {roles.map((r) => (
          <option key={r.id} value={`role:${r.id}`}>
            {r.name} · role
          </option>
        ))}
        {sessions.map((s) => (
          <option key={s.id} value={`session:${s.id}`}>
            {s.label ?? s.id} · session
          </option>
        ))}
      </select>
    </label>
  );
}
function TaskEditor({
  task,
  project,
  close,
  changed,
  roles,
  sessions,
}: {
  task?: Task;
  project: string;
  close: () => void;
  changed: (id: string) => void;
  roles: Role[];
  sessions: AgentSession[];
}) {
  const [draft, set, clear] = useDraft(`task-draft:${task?.id ?? project}`, {
    title: task?.title ?? "",
    body: task?.body ?? "",
    labels: task?.labels.join(", ") ?? "",
    parent_id: task?.parent_id ?? "",
    defer_until: task?.defer_until ?? "",
    assignee: assignmentValue(task?.assignee ?? null),
    revision: task?.revision,
  });
  const { busy, error, run } = useAction();
  return (
    <Dialog title={task ? "Edit task" : "New task"} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const values = {
              title: draft.title,
              body: draft.body,
              labels: parseLabels(draft.labels),
              parent_id: draft.parent_id || null,
              defer_until: draft.defer_until ? new Date(draft.defer_until).toISOString() : null,
              assignee: parseAssignment(draft.assignee),
              ...mutation(),
            };
            const t = await call<Task>(
              task ? "tasks_update" : "tasks_create",
              task
                ? { ...values, task_id: task.id, expected_revision: draft.revision }
                : { ...values, project_id: project },
            );
            clear();
            changed(t.id);
            close();
          });
        }}
      >
        <label>
          Title
          <input
            required
            maxLength={300}
            value={draft.title}
            onChange={(e) => set({ ...draft, title: e.target.value })}
          />
        </label>
        <label>
          Task body
          <textarea
            rows={9}
            value={draft.body}
            onChange={(e) => set({ ...draft, body: e.target.value })}
            placeholder="Describe the result and what must be true when it is done."
          />
        </label>
        <label>
          Labels
          <input
            value={draft.labels}
            onChange={(e) => set({ ...draft, labels: e.target.value })}
            placeholder="backend, p1"
          />
        </label>
        <AssignmentField
          value={draft.assignee}
          set={(assignee) => set({ ...draft, assignee })}
          roles={roles}
          sessions={sessions}
        />
        <details>
          <summary>Parent and review time</summary>
          <label>
            Parent task ID
            <input
              value={draft.parent_id}
              onChange={(e) => set({ ...draft, parent_id: e.target.value })}
            />
          </label>
          <label>
            Defer until
            <input
              value={draft.defer_until}
              onChange={(e) => set({ ...draft, defer_until: e.target.value })}
              placeholder="2027-01-15T09:00:00Z"
            />
          </label>
          <p className="muted small">
            This timestamp is available to filters. It does not stop work or change a claim.
          </p>
        </details>
        <ErrorText>{error}</ErrorText>
        <div className="actions">
          <button type="button" onClick={close}>
            Keep draft
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {task ? "Save changes" : "Create task"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function AddPlan({
  project,
  close,
  changed,
}: {
  project: string;
  close: () => void;
  changed: (id: string) => void;
}) {
  const [draft, set, clear] = useDraft("plan-draft:" + project, { title: "", items: "" }),
    { busy, error, run } = useAction();
  return (
    <Dialog title="Add a plan" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const children = draft.items
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            if (!children.length) throw new Error("Add at least one task");
            const result = await call<{ mapping: Record<string, string> }>("tasks_plan_create", {
              project_id: project,
              tasks: [
                { key: "epic", title: draft.title },
                ...children.map((title, i) => ({ key: `task-${i}`, title, parent_key: "epic" })),
              ],
              ...mutation(),
            });
            clear();
            changed(result.mapping.epic);
            close();
          });
        }}
      >
        <label>
          Plan title
          <input
            required
            value={draft.title}
            onChange={(e) => set({ ...draft, title: e.target.value })}
          />
        </label>
        <label>
          Tasks, one per line
          <textarea
            rows={8}
            required
            value={draft.items}
            onChange={(e) => set({ ...draft, items: e.target.value })}
          />
        </label>
        <ErrorText>{error}</ErrorText>
        <button className="primary" disabled={busy} type="submit">
          Create plan
        </button>
      </form>
    </Dialog>
  );
}
function TaskDetail({
  id,
  refresh,
  changed,
  select,
  close,
  repos,
  roles,
  sessions,
}: {
  id: string;
  refresh: number;
  changed: () => void;
  select: (id: string) => void;
  close: () => void;
  repos: Repository[];
  roles: Role[];
  sessions: AgentSession[];
}) {
  const [context, setContext] = useState<TaskContext | null>(null),
    [loadError, setLoadError] = useState(""),
    [edit, setEdit] = useState(
      () => new URLSearchParams(location.search).get("action") === "edit-task",
    ),
    [action, setAction] = useState(""),
    [actionBody, setActionBody] = useState(""),
    [target, setTarget] = useState(""),
    [waiting, setWaiting] = useState("human"),
    [closureLabels, setClosureLabels] = useState(""),
    [assignment, setAssignment] = useState(""),
    [repository, setRepository] = useState(repos[0]?.id ?? ""),
    [commit, setCommit] = useState(""),
    [older, setOlder] = useState<TaskComment[]>([]),
    [reply, setReply] = useState<string | undefined>(),
    [linkLabel, setLinkLabel] = useState("relates_to"),
    [guards, setGuards] = useState({ revision: 0, sequence: 0 });
  const [comment, setComment, clearComment] = useDraft("comment-draft:" + id, ""),
    { busy, error, run } = useAction();
  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.get("action") === "edit-task") {
      url.searchParams.delete("action");
      history.replaceState(null, "", url);
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh counters reload committed server state.
  useEffect(() => {
    let active = true;
    void call<TaskContext>("tasks_context", { task_id: id })
      .then((c) => {
        if (active) {
          setContext(c);
          setLoadError("");
        }
      })
      .catch((e) => active && setLoadError(e.message));
    return () => {
      active = false;
    };
  }, [id, refresh]);
  if (loadError) return <ErrorText>{loadError}</ErrorText>;
  if (!context) return <p className="muted">Loading task…</p>;
  const c = context,
    t = c.task;
  const mutate = async (name: Operation, values: Record<string, unknown> = {}) => {
    await call(name, { task_id: id, expected_revision: t.revision, ...values, ...mutation() });
    changed();
  };
  const openAction = (name: string) => {
    setGuards({ revision: t.revision, sequence: c.log_sequence });
    setActionBody("");
    setTarget("");
    setClosureLabels(t.labels.join(", "));
    setAction(name);
  };
  const assigned =
    t.assignee?.kind === "owner"
      ? "Owner"
      : t.assignee?.kind === "role"
        ? (roles.find((r) => r.id === t.assignee?.id)?.name ?? t.assignee.id)
        : (sessions.find((s) => s.id === t.assignee?.id)?.label ?? t.assignee?.id);
  return (
    <section className="detail-container" aria-label="Task details">
      <button type="button" className="quiet close-detail" onClick={close}>
        Close task
      </button>
      <div className="task-detail">
        <div className="detail-top">
          <code>{t.id}</code>
          <span>{t.status}</span>
        </div>
        <h2>{t.title}</h2>
        <dl className="task-properties">
          <dt>Status</dt>
          <dd>
            <span className={`state-dot ${t.status}`} aria-hidden="true" />
            {t.status}
          </dd>
          <dt>Assignee</dt>
          <dd>{assigned || "Unassigned"}</dd>
          {t.closed_at && (
            <>
              <dt>Completed</dt>
              <dd>{t.is_done ? "Yes" : "No"}</dd>
            </>
          )}
          <dt>Labels</dt>
          <dd>
            <div className="labels">
              {t.labels.length ? (
                t.labels.map((label) => (
                  <span className="label-chip" key={label}>
                    {label}
                  </span>
                ))
              ) : (
                <span className="muted">None</span>
              )}
            </div>
          </dd>
          <dt>Priority</dt>
          <dd>
            <span className="unavailable-label">Not available yet</span>
          </dd>
        </dl>
        <div className="task-actions">
          <button type="button" onClick={() => setEdit(true)}>
            Edit
          </button>
          {!t.closed_at ? (
            <>
              <button
                type="button"
                className="primary"
                disabled={busy || t.blocked}
                onClick={() => openAction("tasks_resolve")}
              >
                Resolve
              </button>
              <button
                type="button"
                onClick={() => {
                  openAction("tasks_handoff");
                  setAssignment(assignmentValue(t.assignee));
                }}
              >
                Hand off
              </button>
              <button type="button" onClick={() => openAction("tasks_cancel")}>
                Cancel task
              </button>
            </>
          ) : (
            <button type="button" onClick={() => openAction("tasks_reopen")}>
              Reopen
            </button>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="task-body">
          <TaskMarkdown body={t.body || "No task body yet."} />
        </div>
        {t.defer_until && (
          <p className="muted small">Defer until {new Date(t.defer_until).toLocaleString()}</p>
        )}
        {c.progress && (
          <div className="epic-progress">
            <progress max={c.progress.total || 1} value={c.progress.done} />
            <p>
              {c.progress.done} done · {c.progress.closed_without_completion} closed without
              completion · {c.progress.open} open
            </p>
          </div>
        )}
        {c.children.length > 0 && (
          <section className="detail-section">
            <h3>Child tasks</h3>
            <ul className="plain-list">
              {c.children.map((child) => (
                <li key={child.id}>
                  <button type="button" className="link-button" onClick={() => select(child.id)}>
                    {child.title}
                  </button>
                  <small>{child.status}</small>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="detail-section">
          <h3>Blockers</h3>
          {c.blockers.map((b) => (
            <div key={b.id}>
              {b.waiting_on === "task" && (
                <div className="section-line">
                  {b.waiting_on_task_id ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => select(b.waiting_on_task_id!)}
                    >
                      {b.waiting_on_task_id} · {b.satisfied ? "Satisfied" : "Waiting"}
                    </button>
                  ) : (
                    <span>Restricted prerequisite</span>
                  )}
                </div>
              )}
              <TaskBlocker
                blocker={b}
                busy={busy}
                clear={() => {
                  openAction("tasks_clear_blocker");
                  setTarget(b.id);
                }}
                answer={(body) =>
                  void run(async () => {
                    await call("task_comments_add", { task_id: id, body, ...mutation() });
                    changed();
                  })
                }
              />
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => {
                  openAction("tasks_remove_blocker");
                  setTarget(b.id);
                }}
              >
                Remove blocker
              </button>
            </div>
          ))}
          {!c.blockers.some((b) => !b.satisfied) && (
            <p className="muted">No unsatisfied blockers.</p>
          )}
          {!t.closed_at && (
            <button type="button" className="quiet" onClick={() => openAction("tasks_block")}>
              Add a blocker
            </button>
          )}
        </section>
        <section className="detail-section">
          <div className="section-line">
            <h3>Evidence and context</h3>
            <div>
              <button
                type="button"
                className="quiet"
                onClick={() => openAction("tasks_link_commit")}
              >
                Link commit
              </button>
              <button type="button" className="quiet" onClick={() => openAction("links_add")}>
                Add link
              </button>
            </div>
          </div>
          {c.related.map((r) => (
            <div className="context-row" key={r.id}>
              <span>{r.type}</span>
              <ContextLink
                id={r.source_id === id ? r.target_id : r.source_id}
                label={r.source_id === id ? r.target_id : r.source_id}
              />
              {r.reason && <small>{r.reason}</small>}
            </div>
          ))}
          {c.commits.map((commit) => (
            <small key={commit.repository_id + commit.commit_id}>
              {commit.commit_id.slice(0, 12)} ·{" "}
              {commit.verified ? "metadata available" : "reference only"}
            </small>
          ))}
        </section>
        <section className="detail-section">
          <h3>Work log</h3>
          {c.comments.older_count > older.length && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const cursor = Math.max(0, c.comments.older_count - older.length - 50),
                    page = await call<Page<TaskComment>>("task_comments_list", {
                      task_id: id,
                      cursor,
                      limit: Math.min(50, c.comments.older_count - older.length),
                    });
                  setOlder([...page.items, ...older]);
                })
              }
            >
              Load older comments
            </button>
          )}
          <ol className="comments">
            {[...older, ...c.comments.items].map((entry) => (
              <li key={entry.id}>
                <strong>{connectionActorLabel(entry.connection, entry.operator_name)}</strong>
                {entry.role_name && <span> · {entry.role_name}</span>}
                <small>
                  {entry.session_id ? `${entry.session_id} · ` : ""}
                  {new Date(entry.created_at).toLocaleString()}
                </small>
                {entry.reply_to && <small>Reply to {entry.reply_to}</small>}
                <TaskMarkdown body={entry.body} />
                <button type="button" className="quiet" onClick={() => setReply(entry.id)}>
                  Reply
                </button>
              </li>
            ))}
          </ol>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await call("task_comments_add", {
                  task_id: id,
                  body: comment,
                  reply_to: reply,
                  ...mutation(),
                });
                setComment("");
                clearComment();
                setReply(undefined);
                changed();
              });
            }}
          >
            <label>
              {reply ? "Reply" : "Add a comment"}
              <textarea
                rows={4}
                required
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </label>
            {reply && (
              <button type="button" className="quiet" onClick={() => setReply(undefined)}>
                Cancel reply
              </button>
            )}
            <button type="submit" disabled={busy || !comment.trim()}>
              Add comment
            </button>
          </form>
        </section>
      </div>
      {edit && (
        <TaskEditor
          task={t}
          project={t.project_id}
          close={() => setEdit(false)}
          changed={() => changed()}
          roles={roles}
          sessions={sessions}
        />
      )}
      {action && (
        <Dialog
          title={
            {
              tasks_handoff: "Hand off work",
              tasks_resolve: "Resolve task",
              tasks_cancel: "Cancel task",
              tasks_reopen: "Reopen task",
              tasks_block: "Add a blocker",
              tasks_clear_blocker: "Clear blocker",
              tasks_remove_blocker: "Remove blocker",
              tasks_link_commit: "Link commit",
              links_add: "Add context link",
            }[action] ?? action
          }
          close={() => setAction("")}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const values: Record<string, unknown> = { expected_revision: guards.revision };
                if (action === "tasks_handoff") {
                  values.assignee = parseAssignment(assignment);
                  values.expected_log_sequence = guards.sequence;
                  values.comment = actionBody;
                }
                if (
                  [
                    "tasks_resolve",
                    "tasks_cancel",
                    "tasks_clear_blocker",
                    "tasks_remove_blocker",
                  ].includes(action)
                )
                  values.comment = actionBody;
                if (action === "tasks_reopen") values.reason = actionBody;
                if (["tasks_clear_blocker", "tasks_remove_blocker"].includes(action))
                  values.blocker_id = target;
                if (["tasks_resolve", "tasks_cancel"].includes(action))
                  values.labels = parseLabels(closureLabels);
                if (action === "tasks_block") {
                  values.body = actionBody;
                  values.waiting_on = waiting;
                  if (waiting === "task") values.waiting_on_task_id = target;
                }
                if (action === "tasks_link_commit") {
                  values.repository_id = repository;
                  values.commit_id = commit;
                }
                if (action === "links_add")
                  await call("links_add", {
                    source_id: id,
                    target_id: target,
                    type: linkLabel,
                    reason: actionBody,
                    ...mutation(),
                  });
                else await mutate(action as Operation, values);
                setAction("");
                setActionBody("");
                setTarget("");
                changed();
              });
            }}
          >
            {action === "tasks_handoff" && (
              <AssignmentField
                value={assignment}
                set={setAssignment}
                roles={roles}
                sessions={sessions}
              />
            )}
            {action === "tasks_block" && (
              <label>
                Waiting on
                <select value={waiting} onChange={(e) => setWaiting(e.target.value)}>
                  <option value="human">Human</option>
                  <option value="task">Task</option>
                  <option value="external">External</option>
                </select>
              </label>
            )}
            {(action === "links_add" || (action === "tasks_block" && waiting === "task")) && (
              <label>
                {action === "links_add" ? "Target entity ID" : "Prerequisite task ID"}
                <input required value={target} onChange={(e) => setTarget(e.target.value)} />
              </label>
            )}
            {action === "links_add" && (
              <label>
                Link label
                <input required value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} />
              </label>
            )}
            {action === "tasks_link_commit" && (
              <>
                <label>
                  Repository
                  <select
                    required
                    value={repository}
                    onChange={(e) => setRepository(e.target.value)}
                  >
                    <option value="">Choose a repository</option>
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Full commit hash
                  <input required value={commit} onChange={(e) => setCommit(e.target.value)} />
                </label>
              </>
            )}
            {action !== "tasks_link_commit" && (
              <label>
                Context
                <textarea
                  required={!["links_add", "tasks_resolve", "tasks_cancel"].includes(action)}
                  rows={4}
                  value={actionBody}
                  onChange={(e) => setActionBody(e.target.value)}
                />
              </label>
            )}
            {["tasks_resolve", "tasks_cancel"].includes(action) && (
              <label>
                Closure labels
                <input
                  value={closureLabels}
                  onChange={(e) => setClosureLabels(e.target.value)}
                  placeholder="Optional reasons, separated by commas"
                />
              </label>
            )}
            <ErrorText>{error}</ErrorText>
            <button type="submit" className="primary" disabled={busy}>
              Save
            </button>
          </form>
        </Dialog>
      )}
    </section>
  );
}
export function TasksView({
  project,
  title,
  repos,
  refresh,
  changed,
  newProject,
}: {
  project: string;
  title: string;
  repos: Repository[];
  refresh: number;
  changed: () => void;
  newProject: () => void;
}) {
  const [page, setPage] = useState<Page<Task>>({ items: [], total: 0, next_cursor: null }),
    [selected, setSelected] = useState(new URLSearchParams(location.search).get("task") ?? ""),
    [query, setQuery] = useState(""),
    [view, setView] = useState("all"),
    [labels, setLabels] = useState(""),
    [assignedRole, setAssignedRole] = useState(""),
    [sort, setSort] = useState("created"),
    [before, setBefore] = useState(""),
    [undated, setUndated] = useState(true),
    [cursor, setCursor] = useState(0),
    [roles, setRoles] = useState<Role[]>([]),
    [sessions, setSessions] = useState<AgentSession[]>([]),
    [error, setError] = useState(""),
    [create, setCreate] = useState(false),
    [plan, setPlan] = useState(false),
    [loadedKey, setLoadedKey] = useState("");
  const viewKey = JSON.stringify([
    project,
    query,
    view,
    labels,
    assignedRole,
    sort,
    before,
    undated,
    cursor,
  ]);
  const loading = loadedKey !== viewKey;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh counters reload committed server state.
  useEffect(() => {
    let live = true;
    void Promise.all([
      call<Page<Task>>(view === "available" ? "tasks_ready" : "tasks_search", {
        project_id: project || undefined,
        query,
        status: ["open", "blocked", "closed"].includes(view) ? view : undefined,
        needs_owner: view === "owner" ? true : undefined,
        labels_all: parseLabels(labels),
        assignee: assignedRole ? { kind: "role", id: assignedRole } : undefined,
        sort,
        deferred_before: before ? new Date(before).toISOString() : undefined,
        include_undated: undated,
        cursor,
      }),
      call<Role[]>("roles_list"),
      call<Page<AgentSession>>("sessions_list", { limit: 100 }),
    ])
      .then(([p, r, s]) => {
        if (live) {
          setPage(p);
          setRoles(r);
          setSessions(s.items);
          setError("");
          setLoadedKey(viewKey);
        }
      })
      .catch((e) => {
        if (!live) return;
        setError(e.message);
        setLoadedKey(viewKey);
      });
    return () => {
      live = false;
    };
  }, [viewKey, refresh]);
  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.get("action") !== "new-task") return;
    url.searchParams.delete("action");
    history.replaceState(null, "", url);
    if (project) setCreate(true);
    else newProject();
  }, [project, newProject]);
  const group = (task: Task) => task.status;
  const groups = [
    ["blocked", "Blocked"],
    ["open", "Open"],
    ["closed", "Closed"],
  ]
    .map(([id, label]) => ({
      id,
      label,
      items: loading ? [] : page.items.filter((task) => group(task) === id),
    }))
    .filter((group) => group.items.length);
  const select = (id: string) => {
      setSelected(id);
      const url = new URL(location.href);
      if (id) url.searchParams.set("task", id);
      else url.searchParams.delete("task");
      history.replaceState(null, "", url);
    },
    created = (id: string) => {
      select(id);
      changed();
    };
  return (
    <>
      <PageHeading>
        <div>
          <h1>{title}</h1>
          <p>{loading ? "Loading tasks…" : `${page.total} tasks`}</p>
        </div>
        <div className="heading-actions">
          <button type="button" onClick={() => (project ? setPlan(true) : newProject())}>
            Add a plan
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => (project ? setCreate(true) : newProject())}
          >
            New task
          </button>
        </div>
      </PageHeading>
      <div className="task-toolbar">
        <fieldset className="filters">
          <legend className="sr-only">Task view</legend>
          {[
            ["all", "All"],
            ["open", "Open"],
            ["owner", "Needs owner"],
            ["blocked", "Blocked"],
            ["closed", "Closed"],
          ].map(([key, label]) => (
            <button
              type="button"
              key={key}
              aria-pressed={view === key}
              onClick={() => {
                setView(key);
                setCursor(0);
              }}
            >
              {label}
            </button>
          ))}
        </fieldset>
        <label className="search">
          <span className="sr-only">Search tasks</span>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            placeholder="Search tasks"
          />
        </label>
        <details className="filter-details">
          <summary>More filters</summary>
          <div className="filter-grid">
            <label>
              All labels
              <input
                value={labels}
                onChange={(e) => {
                  setLabels(e.target.value);
                  setCursor(0);
                }}
                placeholder="backend, p0"
              />
            </label>
            <label>
              Assigned role
              <select
                value={assignedRole}
                onChange={(e) => {
                  setAssignedRole(e.target.value);
                  setCursor(0);
                }}
              >
                <option value="">Any role</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Order
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="created">Created</option>
                <option value="updated">Updated</option>
                <option value="title">Title</option>
              </select>
            </label>
            <label>
              Defer until before
              <input
                type="datetime-local"
                value={before}
                onChange={(e) => {
                  setBefore(e.target.value);
                  setCursor(0);
                }}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={undated}
                onChange={(e) => setUndated(e.target.checked)}
              />
              Include tasks without a date
            </label>
          </div>
        </details>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className={`work-area ${selected ? "has-detail" : ""}`}>
        <section className="task-list" aria-label="Tasks" aria-busy={loading}>
          {groups.map(({ id, label, items }) => (
            <Fragment key={id}>
              <h2 className="task-group-heading">
                <span className={`state-dot ${id}`} aria-hidden="true" />
                {label}
                <span className="count">{items.length}</span>
              </h2>
              {items.map((task) => (
                <button
                  type="button"
                  key={task.id}
                  className={`task-row ${selected === task.id ? "selected" : ""}`}
                  onClick={() => select(task.id)}
                >
                  <span className={`state-dot ${group(task)}`} aria-hidden="true" />
                  <code className="task-id" title={task.id}>
                    {task.id.slice(-8)}
                  </code>
                  <span className="task-row-main">
                    <strong>{task.title}</strong>
                    {task.child_count > 0 && <small>{task.child_count} child tasks</small>}
                  </span>
                  <span className="task-row-labels">
                    {task.labels.slice(0, 2).map((label) => (
                      <span className="label-chip" key={label}>
                        {label}
                      </span>
                    ))}
                  </span>
                  {task.blocked && (
                    <span className="agent-chip waiting">
                      {task.needs_owner ? "Needs human" : "Blocked"}
                    </span>
                  )}
                </button>
              ))}
            </Fragment>
          ))}
          {loading && (
            <div className="task-list-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              Loading tasks…
            </div>
          )}
          {!loading && !page.items.length && (
            <div className="empty">
              <h2>No tasks in this view</h2>
              <p>Create work or adjust the filters.</p>
            </div>
          )}
          <div className="pagination">
            <button
              type="button"
              disabled={loading || !cursor}
              onClick={() => setCursor(Math.max(0, cursor - 50))}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={loading || page.next_cursor === null}
              onClick={() => setCursor(page.next_cursor!)}
            >
              Next
            </button>
          </div>
        </section>
        {selected && (
          <TaskDetail
            key={selected}
            id={selected}
            refresh={refresh}
            changed={changed}
            select={select}
            close={() => select("")}
            repos={repos}
            roles={roles}
            sessions={sessions}
          />
        )}
      </div>
      {create && (
        <TaskEditor
          project={project}
          close={() => setCreate(false)}
          changed={created}
          roles={roles}
          sessions={sessions}
        />
      )}{" "}
      {plan && <AddPlan project={project} close={() => setPlan(false)} changed={created} />}
    </>
  );
}
