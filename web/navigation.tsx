import { useEffect, useState } from "react";
import type { AgentSession, Page, Project, SessionRuntime } from "../shared/contracts.ts";
import { call } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { Brand } from "./ui.tsx";

export const views = [
  ["tasks", "Tasks"],
  ["sessions", "Sessions"],
  ["artifacts", "Artifacts"],
  ["history", "Git history"],
  ["activity", "Activity"],
  ["approvals", "Approvals"],
  ["connections", "Connections"],
  ["settings", "Settings"],
] as const;
export type View = (typeof views)[number][0];
export function readView(value: string | null): View {
  return views.find(([view]) => view === value)?.[0] ?? "tasks";
}
export function isEditing(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest("input, textarea, select, [contenteditable=true], [role=textbox]")
  );
}
export function initialCollapsed() {
  try {
    const saved = localStorage.getItem("allgather-sidebar-collapsed");
    return saved === null ? matchMedia("(max-width: 760px)").matches : saved === "true";
  } catch {
    return matchMedia("(max-width: 760px)").matches;
  }
}
export function Sidebar({
  view,
  project,
  projects,
  pending,
  connected,
  collapsed,
  refresh,
  navigate,
  chooseProject,
  newProject,
  search,
  toggle,
}: {
  view: View;
  project: string;
  projects: Project[];
  pending: number;
  connected: boolean;
  collapsed: boolean;
  refresh: number;
  navigate: (view: View, params?: Record<string, string>) => void;
  chooseProject: (id: string) => void;
  newProject: () => void;
  search: () => void;
  toggle: () => void;
}) {
  const [sessions, setSessions] = useState<
    { session: AgentSession; runtime: SessionRuntime | null }[]
  >([]);
  const [error, setError] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Server events invalidate the session snapshot.
  useEffect(() => {
    let active = true;
    void call<Page<AgentSession>>("sessions_list", { limit: 5 })
      .then(async (page) => {
        const rows = await Promise.all(
          page.items.map(async (session) => {
            const { runtime } = await call<{ runtime: SessionRuntime | null }>(
              "session_runtime_get",
              { target_session_id: session.id },
            );
            return { session, runtime };
          }),
        );
        if (active) {
          setSessions(rows);
          setError(false);
        }
      })
      .catch(() => {
        if (active) {
          setSessions([]);
          setError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  return (
    <aside className="app-header" aria-label="Workspace sidebar">
      <div className="sidebar-brand">
        <Brand />
      </div>
      <button
        type="button"
        className="sidebar-search"
        aria-label="Search or jump"
        title="Search or jump (Ctrl/⌘ K)"
        onClick={search}
      >
        <Icon name="search" />
        <span className="sidebar-label">Search or jump…</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="sidebar-scroll">
        <nav aria-label="Main navigation">
          {views.map(([name, label]) => (
            <button
              type="button"
              key={name}
              aria-label={label}
              title={collapsed ? label : undefined}
              aria-current={view === name ? "page" : undefined}
              onClick={() => navigate(name)}
            >
              <Icon name={name as IconName} />
              <span className="sidebar-label">{label}</span>
              {name === "approvals" && pending > 0 && (
                <span className="nav-count" data-count={pending} aria-hidden="true" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-section-title">
          <span className="sidebar-label">Projects</span>
          <button type="button" aria-label="New project" title="New project" onClick={newProject}>
            <Icon name="plus" />
          </button>
        </div>
        <nav aria-label="Projects">
          <button
            type="button"
            title="All projects"
            aria-pressed={!project}
            onClick={() => chooseProject("")}
          >
            <span className="project-dot" />
            <span className="sidebar-label">All projects</span>
          </button>
          {projects.map((p) => (
            <button
              type="button"
              key={p.id}
              title={p.name}
              aria-pressed={project === p.id}
              onClick={() => chooseProject(p.id)}
            >
              <span className="project-dot" />
              <span className="sidebar-label">{p.name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-section-title">
          <span className="sidebar-label">Recent sessions</span>
        </div>
        <nav aria-label="Recent sessions">
          {sessions.map(({ session, runtime }) => (
            <button
              type="button"
              key={session.id}
              title={`${session.label ?? session.id} · ${runtime?.state ?? "Recorded"}`}
              onClick={() => navigate("sessions", { session: session.id })}
            >
              <span className="agent-avatar">{session.agent_type.slice(0, 2).toUpperCase()}</span>
              <span className="sidebar-label">{session.label ?? session.id}</span>
              {runtime && (
                <span
                  className={`presence ${runtime.connected && !runtime.fenced ? runtime.state : "offline"}`}
                  role="img"
                  aria-label={runtime.connected ? runtime.state : "Offline"}
                />
              )}
            </button>
          ))}
        </nav>
        {!sessions.length && (
          <p className="sidebar-empty sidebar-label">
            {error ? "Sessions unavailable" : "No sessions yet"}
          </p>
        )}
      </div>
      <button
        type="button"
        className="sidebar-fold"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar ([)" : "Collapse sidebar ([)"}
      >
        <Icon name="panel" />
        <span className="sidebar-label">Collapse</span>
        <kbd>[</kbd>
      </button>
      <div
        className="sidebar-owner"
        title={connected ? "Owner · Connected" : "Owner · Reconnecting"}
      >
        <span className="owner-avatar">O</span>
        <span className="sidebar-label">Owner</span>
        <span className={`presence ${connected ? "running" : "offline"}`} />
        <span className="sidebar-label connection-label">
          {connected ? "Connected" : "Reconnecting"}
        </span>
      </div>
    </aside>
  );
}
