import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { AgentSession, Page, Project, SessionRuntime } from "../shared/contracts.ts";
import { call } from "./api.ts";
import logoUrl from "./brand/logo-small.svg";
import { Icon, type IconName } from "./icons.tsx";
import { ProjectIcon } from "./project-icon.tsx";
import { projectColor, scopeFilter, scopeName, scopeRail } from "./project-scope.ts";

export const scopedViews = [
  ["tasks", "Tasks"],
  ["sessions", "Sessions"],
  ["artifacts", "Artifacts"],
  ["history", "Git history"],
  ["activity", "Activity"],
] as const;
export const workspaceViews = [
  ["approvals", "Approvals"],
  ["connections", "Connections"],
  ["settings", "Settings"],
] as const;
export const views = [...scopedViews, ...workspaceViews] as const;
export type View = (typeof views)[number][0];
export function readView(value: string | null): View {
  return views.find(([view]) => view === value)?.[0] ?? "tasks";
}
export function isScopedView(view: View) {
  return scopedViews.some(([name]) => name === view);
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
function ProjectMarks({ selected, collapsed }: { selected: Project[]; collapsed: boolean }) {
  if (!selected.length)
    return (
      <span className="scope-marks">
        <img className="scope-mark" src={logoUrl} alt="" />
      </span>
    );
  if (selected.length === 1)
    return (
      <span className="scope-marks">
        {selected[0].icon ? (
          <ProjectIcon project={selected[0]} />
        ) : (
          <span className="scope-mark" style={{ background: projectColor(selected[0]) }}>
            {selected[0].slug.slice(0, 2)}
          </span>
        )}
      </span>
    );
  if (collapsed)
    return (
      <span className="scope-marks">
        <span className="scope-mark" style={{ background: scopeRail(selected) ?? undefined }}>
          {selected.length}
        </span>
      </span>
    );
  return (
    <span className="scope-marks stacked">
      {selected.slice(0, 3).map((p, i) => (
        <span
          key={p.id}
          className="scope-mark"
          style={{ background: projectColor(p), left: i * 3, top: i * 3 }}
        />
      ))}
    </span>
  );
}
function ProjectSwitcher({
  scope,
  projects,
  collapsed,
  choose,
  newProject,
}: {
  scope: string[];
  projects: Project[];
  collapsed: boolean;
  choose: (ids: string[]) => void;
  newProject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = projects.filter((p) => scope.includes(p.id));
  const name = scopeName(selected);
  const detail = !selected.length
    ? `${projects.length} project${projects.length === 1 ? "" : "s"}`
    : selected.length === 1
      ? selected[0].slug
      : selected.map((p) => p.name).join(", ");
  useEffect(() => {
    if (!open) return;
    (
      root.current?.querySelector<HTMLElement>('.scope-option[aria-current="true"]') ??
      root.current?.querySelector<HTMLElement>(".scope-option")
    )?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        root.current?.querySelector<HTMLElement>(".scope-switch")?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const options = [
          ...(root.current?.querySelectorAll<HTMLElement>(".scope-popover button, .scope-check") ??
            []),
        ];
        const index = options.indexOf(document.activeElement as HTMLElement);
        options[
          (index + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
        ]?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  const pick = (ids: string[]) => {
    choose(ids);
    setOpen(false);
  };
  return (
    <div className="scope-switcher" ref={root}>
      <button
        type="button"
        className="scope-switch"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Project filter: ${name}`}
        title={collapsed ? `Project filter: ${name}` : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <ProjectMarks selected={selected} collapsed={collapsed} />
        <span className="scope-name sidebar-label">
          <b>{name}</b>
          <small>{detail}</small>
        </span>
        <span className="scope-chevron sidebar-label">
          <Icon name="updown" />
        </span>
      </button>
      {open && (
        <div className="scope-popover" role="dialog" aria-label="Project filter">
          <button
            type="button"
            className="scope-option"
            aria-current={!scope.length}
            onClick={() => pick([])}
          >
            <img className="scope-swatch" src={logoUrl} alt="" />
            <span>All projects</span>
            <small>{projects.length}</small>
          </button>
          <hr />
          <ul className="scope-list" aria-label="Projects">
            {projects.map((p) => {
              const included = scope.includes(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    className="scope-option"
                    aria-current={included && scope.length === 1}
                    title={`View only ${p.name}`}
                    onClick={() => pick([p.id])}
                  >
                    <span className="scope-swatch" style={{ background: projectColor(p) }} />
                    <span>{p.name}</span>
                    <small>{p.slug}</small>
                  </button>
                  <input
                    type="checkbox"
                    className="scope-check"
                    checked={included}
                    aria-label={`Include ${p.name}`}
                    title={
                      included ? `Remove ${p.name} from the filter` : `Add ${p.name} to the filter`
                    }
                    onChange={() =>
                      choose(included ? scope.filter((id) => id !== p.id) : [...scope, p.id])
                    }
                  />
                </li>
              );
            })}
          </ul>
          <hr />
          <button
            type="button"
            className="scope-option"
            aria-label="New project"
            onClick={() => {
              setOpen(false);
              newProject();
            }}
          >
            <Icon name="plus" />
            <span>New project…</span>
          </button>
        </div>
      )}
    </div>
  );
}
type SessionRow = { session: AgentSession; runtime: SessionRuntime | null };
function useRecentSessions(scope: string[], refresh: number) {
  const [state, setState] = useState<{ rows: SessionRow[]; error: boolean }>({
    rows: [],
    error: false,
  });
  const key = scope.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Server events and scope changes reload the snapshot.
  useEffect(() => {
    let active = true;
    void call<Page<AgentSession>>("sessions_search", {
      limit: 5,
      ...scopeFilter(scope),
    })
      .then((page) =>
        Promise.all(
          page.items.map(async (session) => {
            const { runtime } = await call<{ runtime: SessionRuntime | null }>(
              "session_runtime_get",
              { target_session_id: session.id },
            );
            return { session, runtime };
          }),
        ),
      )
      .then((rows) => {
        if (active) setState({ rows, error: false });
      })
      .catch(() => {
        if (active) setState({ rows: [], error: true });
      });
    return () => {
      active = false;
    };
  }, [key, refresh]);
  return state;
}
export function Sidebar({
  view,
  scope,
  projects,
  pending,
  connected,
  collapsed,
  refresh,
  navigate,
  choose,
  newProject,
  search,
  toggle,
}: {
  view: View;
  scope: string[];
  projects: Project[];
  pending: number;
  connected: boolean;
  collapsed: boolean;
  refresh: number;
  navigate: (view: View, params?: Record<string, string>) => void;
  choose: (ids: string[]) => void;
  newProject: () => void;
  search: () => void;
  toggle: () => void;
}) {
  const sessions = useRecentSessions(scope, refresh);
  const selected = projects.filter((p) => scope.includes(p.id));
  const rail = scopeRail(selected);
  const viewButton = ([name, label]: readonly [View, string]) => (
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
  );
  return (
    <aside className="app-header" aria-label="Workspace sidebar">
      <div className="sidebar-top">
        <ProjectSwitcher
          scope={scope}
          projects={projects}
          collapsed={collapsed}
          choose={choose}
          newProject={newProject}
        />
        <button
          type="button"
          className="sidebar-search"
          aria-label="Search or jump"
          title="Search or jump (Ctrl/⌘ K)"
          onClick={search}
        >
          <Icon name="search" />
        </button>
      </div>
      <div className="sidebar-scroll">
        <div
          className={`sidebar-scope ${rail ? "railed" : ""}`}
          style={rail ? ({ "--scope-rail": rail } as CSSProperties) : undefined}
        >
          {!!selected.length && (
            <div className="sidebar-section-title scope-title">
              <span className="scope-dots" aria-hidden="true">
                {selected.slice(0, 4).map((p) => (
                  <i key={p.id} style={{ background: projectColor(p) }} />
                ))}
              </span>
              <span className="sidebar-label">In {scopeName(selected)}</span>
            </div>
          )}
          <nav aria-label="Filtered by project">{scopedViews.map(viewButton)}</nav>
          <div className="sidebar-section-title">
            <span className="sidebar-label">Recent sessions</span>
          </div>
          <nav aria-label="Recent sessions">
            {sessions.rows.map(({ session, runtime }) => (
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
          {!sessions.rows.length && (
            <p className="sidebar-empty sidebar-label">
              {sessions.error
                ? "Sessions unavailable"
                : selected.length
                  ? `No sessions in ${scopeName(selected)} yet`
                  : "No sessions yet"}
            </p>
          )}
        </div>
        <div className="sidebar-section-title">
          <span className="sidebar-label">Workspace</span>
          <span className="sidebar-label section-hint">all projects</span>
        </div>
        <nav aria-label="Workspace">{workspaceViews.map(viewButton)}</nav>
      </div>
      <div className="sidebar-status">
        <span
          className="connection-status"
          role="status"
          title={connected ? "Server connected" : "Reconnecting to server"}
        >
          <span className={`presence ${connected ? "running" : "offline"}`} />
          <span className="sidebar-label connection-label">
            {connected ? "Connected" : "Reconnecting"}
          </span>
        </span>
        <button
          type="button"
          className="sidebar-fold"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar ([)" : "Collapse sidebar ([)"}
        >
          <Icon name="panel" />
        </button>
      </div>
    </aside>
  );
}
