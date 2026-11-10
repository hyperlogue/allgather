import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RegisteredClient } from "../shared/client-access.ts";
import type { Project } from "../shared/contracts.ts";
import type { ProjectIconUpload } from "../shared/project-icon.ts";
import { suggestedProjectSlug } from "../shared/project-slug.ts";
import { Activity } from "./activity.tsx";
import { call, mutation, request } from "./api.ts";
import { ApprovalsView, useApprovals } from "./approvals.tsx";
import { CliPairing } from "./cli-pairing.tsx";
import { ClientGrants } from "./client-grants.tsx";
import { CommandPalette } from "./command-palette.tsx";
import { CopyId } from "./copy-id.tsx";
import { HistoryView, type Repo } from "./history.tsx";
import { LibraryView } from "./library.tsx";
import { Login } from "./login.tsx";
import { MachineConnections } from "./machine-connections.tsx";
import { McpPairing } from "./mcp-pairing.tsx";
import {
  initialCollapsed,
  isEditing,
  isScopedView,
  readView,
  Sidebar,
  type View,
  views,
} from "./navigation.tsx";
import { ProjectEditorDialog, ProjectIcon, ProjectIconInput } from "./project-icon.tsx";
import { projectColor, scopeFilter, scopeName } from "./project-scope.ts";
import { SessionsView } from "./sessions.tsx";
import { SettingsView } from "./settings.tsx";
import { TasksView } from "./tasks.tsx";
import { TowerEnrollmentView } from "./tower-enrollment.tsx";
import {
  Banner,
  Brand,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorText,
  LoginFrame,
  useAction,
} from "./ui.tsx";

function NewProject({ close, created }: { close: () => void; created: (p: Project) => void }) {
  const [name, setName] = useState("");
  const [fallback, setFallback] = useState(false);
  const [slug, setSlug] = useState<string | null>(null);
  const [icon, setIcon] = useState<ProjectIconUpload | null>(null);
  const [iconLoading, setIconLoading] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <Dialog title="New project" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (iconLoading) return;
          void run(async () => {
            const p = await call<Project>("projects_create", {
              name,
              is_fallback: fallback || undefined,
              icon,
              slug: slug ?? suggestedProjectSlug(name),
              ...mutation(),
            });
            created(p);
            close();
          });
        }}
      >
        <label>
          Name
          <input required maxLength={300} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Slug
          <input
            required
            maxLength={16}
            pattern="[A-Z][A-Z0-9]*"
            value={slug ?? suggestedProjectSlug(name)}
            onChange={(e) => setSlug(e.target.value.toUpperCase())}
          />
        </label>
        <p className="muted small">
          Task IDs start at {slug ?? suggestedProjectSlug(name)}-1. The slug cannot change after
          creation.
        </p>
        <Checkbox
          label="Use when no project can be inferred"
          checked={fallback}
          onChange={(e) => setFallback(e.target.checked)}
        />
        <ProjectIconInput
          value={icon}
          change={setIcon}
          pending={setIconLoading}
          disabled={busy || iconLoading}
        />
        <ErrorText>{error}</ErrorText>
        <div className="actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <Button type="submit" variant="primary" disabled={busy || iconLoading}>
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function Connections({
  mcp,
  refresh,
  manageMachines,
}: {
  mcp: string;
  refresh: number;
  manageMachines: () => void;
}) {
  const [clients, setClients] = useState<RegisteredClient[]>([]);
  const [editing, setEditing] = useState<RegisteredClient | null>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(() => request<typeof clients>("/api/clients").then(setClients), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh the client list when server updates arrive.
  useEffect(() => {
    void run(async () => {
      await load();
    });
  }, [load, run, refresh]);
  const reloadAccess = async () => {
    const next = await request<RegisteredClient[]>("/api/clients");
    setClients(next);
    setEditing((previous) => next.find((c) => c.id === previous?.id) ?? null);
  };
  useEffect(() => {
    const timer = setInterval(() => void run(load), 30000);
    return () => clearInterval(timer);
  }, [load, run]);
  const selected = editing;
  return (
    <div className="connections">
      <h1>Agent connections</h1>
      <p>Let Grok Bot and ChatGPT read and change tasks through MCP.</p>
      <div className="connection-address">
        <label>
          MCP server URL
          <input readOnly value={mcp} />
        </label>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              await navigator.clipboard.writeText(mcp);
            })
          }
        >
          Copy URL
        </button>
      </div>
      <p className="muted">
        Open pairing below, then add this URL in your client's MCP settings and enter the pairing
        code on the page it opens.
      </p>
      {mcp.startsWith("http:") && (
        <Banner>
          This server uses a local address. Configure an HTTPS public URL before connecting a hosted
          agent.
        </Banner>
      )}
      <ErrorText>{error}</ErrorText>
      <h2>Registered clients</h2>
      <p className="muted small">
        Last used records authenticated API/MCP requests and token refreshes. Older usage is
        unavailable.
      </p>
      {clients.length ? (
        <ul className="plain-list registered-clients">
          {clients.map((client) => (
            <li key={client.id}>
              <span>
                <strong>{client.name}</strong>
                <small>
                  {client.audience === "mcp" ? "MCP connector" : "CLI / API client"} ·{" "}
                  <CopyId value={client.id} />
                </small>
                <small>
                  {client.last_used_at ? (
                    <>
                      Last used{" "}
                      <time dateTime={client.last_used_at}>
                        {new Date(client.last_used_at).toLocaleString()}
                      </time>
                    </>
                  ) : (
                    "No usage recorded"
                  )}
                </small>
                <small>
                  {client.revoked
                    ? "Revoked"
                    : `Registered ${new Date(client.created_at).toLocaleDateString()}`}
                </small>
              </span>
              <div className="actions">
                <button type="button" onClick={() => setEditing(client)}>
                  Manage access
                </button>
                {!client.revoked && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Revoke ${client.name}'s access?`))
                        void run(async () => {
                          await request(`/api/clients/${client.id}/revoke`, {});
                          await load();
                        });
                    }}
                  >
                    Revoke
                  </button>
                )}
                {!!client.revoked && (
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          `Delete ${client.name}? It will be hidden from Connections. Its identity and history are kept as a deleted account.`,
                        )
                      )
                        void run(async () => {
                          await request(`/api/clients/${encodeURIComponent(client.id)}/delete`, {});
                          if (editing?.id === client.id) setEditing(null);
                          await load();
                        });
                    }}
                  >
                    Delete connection
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>
          No clients yet. Each pairing connects one client with the access you choose.
        </EmptyState>
      )}
      {selected && (
        <ClientGrants client={selected} close={() => setEditing(null)} saved={reloadAccess} />
      )}
      <MachineConnections refresh={refresh} manage={manageMachines} />
      <div className="pairing-panels">
        <CliPairing refresh={refresh} changed={() => void load()} />
        <McpPairing refresh={refresh} changed={() => void load()} />
      </div>
      <div className="history-section">
        <h2>Access rules</h2>
        <p>
          Each connection has its own granted permissions. Session launch and prompts can run coding
          agents on machines. Grant these controls only when you intend to allow execution.
        </p>
        <p className="muted small">
          Revocation stops the client's current tokens and future refresh attempts. Your browser and
          CLI remain connected.
        </p>
      </div>
    </div>
  );
}
function readScope(search: string) {
  const value = new URLSearchParams(search).get("project");
  return value ? value.split(",").filter(Boolean) : [];
}
function savedScope() {
  try {
    const saved = localStorage.getItem("allgather-project-scope");
    return saved === null ? null : saved.split(",").filter(Boolean);
  } catch {
    return null;
  }
}
function WorkspaceApp({ mcp }: { mcp: string }) {
  const [projects, setProjects] = useState<Project[]>([]),
    [scope, setScope] = useState(() =>
      new URLSearchParams(location.search).has("project")
        ? readScope(location.search)
        : (savedScope() ?? []),
    ),
    [repos, setRepos] = useState<Repo[]>([]),
    [view, setView] = useState<View>(readView(new URLSearchParams(location.search).get("view"))),
    [collapsed, setCollapsed] = useState(initialCollapsed),
    [palette, setPalette] = useState(false),
    [routeRevision, setRouteRevision] = useState(0),
    [newProject, setNewProject] = useState(false),
    [editingProject, setEditingProject] = useState<Project | null>(null),
    [refresh, setRefresh] = useState(0),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(true);
  const navigate = useCallback((next: View, params: Record<string, string> = {}) => {
    const url = new URL(location.href);
    url.searchParams.set("view", next);
    url.searchParams.delete("action");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    history.pushState(null, "", url);
    setView(next);
    if (Object.keys(params).length) setRouteRevision((value) => value + 1);
    if (matchMedia("(max-width: 760px)").matches) setCollapsed(true);
  }, []);
  const choose = useCallback((ids: string[]) => {
    const url = new URL(location.href);
    url.searchParams.set("project", ids.join(","));
    for (const key of ["task", "session", "action"]) url.searchParams.delete(key);
    history.pushState(null, "", url);
    setScope(ids);
    setRouteRevision((r) => r + 1);
    try {
      localStorage.setItem("allgather-project-scope", ids.join(","));
    } catch {}
    if (matchMedia("(max-width: 760px)").matches) setCollapsed(true);
  }, []);
  const chooseProject = useCallback(
    (id: string) => {
      choose(id ? [id] : []);
      setView("tasks");
      const url = new URL(location.href);
      url.searchParams.set("view", "tasks");
      history.replaceState(null, "", url);
    },
    [choose],
  );
  useEffect(() => {
    try {
      localStorage.setItem("allgather-sidebar-collapsed", String(collapsed));
    } catch {}
  }, [collapsed]);
  useEffect(() => {
    const back = () => {
      const p = new URLSearchParams(location.search);
      setScope(readScope(location.search));
      setView(readView(p.get("view")));
      setRouteRevision((r) => r + 1);
    };
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if (
        e.key === "[" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditing(e.target) &&
        !document.querySelector("dialog[open]")
      ) {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("popstate", back);
    };
  }, []);
  const closePalette = useCallback(() => setPalette(false), []);
  const approvals = useApprovals(refresh);
  const pendingApprovals = approvals.filter((row) => row.state === "needs_approval");
  const initialized = useRef(false);
  const changed = useCallback(() => setRefresh((x) => x + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Server events invalidate this snapshot.
  useEffect(() => {
    let live = true;
    void Promise.all([
      call<Project[]>("projects_list"),
      call<Repo[]>("repositories_list", scopeFilter(scope)),
    ])
      .then(([ps, rs]) => {
        if (!live) return;
        setProjects(ps);
        setRepos(rs);
        setError("");
        if (!initialized.current) {
          initialized.current = true;
          setScope((current) => {
            const known = current.filter((id) => ps.some((p) => p.id === id));
            if (known.length || new URLSearchParams(location.search).has("project")) return known;
            return savedScope() === null && ps[0] ? [ps[0].id] : known;
          });
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [scope, refresh]);
  useEffect(() => {
    const events = new EventSource("/api/events");
    events.addEventListener("ready", () => {
      setConnected(true);
      changed();
    });
    events.addEventListener("change", changed);
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, [changed]);
  return (
    <div className={`workspace-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <Sidebar
        view={view}
        scope={scope}
        projects={projects}
        pending={pendingApprovals.length}
        connected={connected}
        collapsed={collapsed}
        refresh={refresh}
        navigate={navigate}
        choose={choose}
        newProject={() => setNewProject(true)}
        editProject={setEditingProject}
        search={() => setPalette(true)}
        toggle={() => setCollapsed((v) => !v)}
      />
      {!collapsed && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close sidebar"
          onClick={() => setCollapsed(true)}
        />
      )}
      <div className="workspace-body">
        <header className="workspace-topbar">
          <div className="topbar-scope">
            {!isScopedView(view) ? (
              <span className="scope-note">Workspace</span>
            ) : scope.length ? (
              projects
                .filter((p) => scope.includes(p.id))
                .map((p) =>
                  scope.length === 1 ? (
                    <span key={p.id} className="scope-single">
                      <Button
                        variant="quiet"
                        className="project-icon-button"
                        aria-label="Edit project"
                        title={`Edit ${p.name}`}
                        onClick={() => setEditingProject(p)}
                      >
                        <ProjectIcon project={p} />
                      </Button>
                      <span className="scope-project-name">{p.name}</span>
                    </span>
                  ) : (
                    <span key={p.id} className="scope-chip">
                      <i style={{ background: projectColor(p) }} />
                      {p.name}
                    </span>
                  ),
                )
            ) : (
              <span className="scope-note">All projects</span>
            )}
          </div>
          <span className="breadcrumb-separator">/</span>
          <span className="workspace-view-title">{views.find(([name]) => name === view)?.[1]}</span>
          <div id="view-heading" />
        </header>
        {pendingApprovals.length > 0 && view !== "approvals" && (
          <div className="approval-notice" role="status">
            <span>
              {pendingApprovals.length} agent request{pendingApprovals.length === 1 ? "" : "s"} need
              your approval.
            </span>
            <button
              type="button"
              onClick={() => {
                navigate("approvals");
              }}
            >
              Review requests
            </button>
          </div>
        )}
        {!connected && (
          <div className="connection-notice" role="status">
            Connection interrupted. The page will refresh after reconnection.
          </div>
        )}
        <main className="app-main" data-view={view}>
          <ErrorText>{error}</ErrorText>
          {view === "tasks" ? (
            <TasksView
              key={`${scope.join(",")}:${routeRevision}`}
              scope={scope}
              title={
                scope.length ? scopeName(projects.filter((p) => scope.includes(p.id))) : "All tasks"
              }
              repos={repos}
              refresh={refresh}
              changed={changed}
              newProject={() => setNewProject(true)}
            />
          ) : view === "artifacts" ? (
            <LibraryView key={routeRevision} scope={scope} refresh={refresh} changed={changed} />
          ) : view === "sessions" ? (
            <SessionsView key={routeRevision} scope={scope} refresh={refresh} changed={changed} />
          ) : view === "history" ? (
            <HistoryView
              scope={scope}
              projects={projects}
              repos={repos}
              refresh={refresh}
              changed={changed}
            />
          ) : view === "approvals" ? (
            <ApprovalsView rows={approvals} changed={changed} />
          ) : view === "settings" ? (
            <SettingsView />
          ) : view === "activity" ? (
            <Activity scope={scope} refresh={refresh} />
          ) : (
            <Connections
              mcp={mcp}
              refresh={refresh}
              manageMachines={() => navigate("sessions", { action: "machines" })}
            />
          )}
        </main>
      </div>
      {palette && (
        <CommandPalette
          scope={scope}
          projects={projects}
          navigate={navigate}
          chooseProject={chooseProject}
          newProject={() => setNewProject(true)}
          editProject={setEditingProject}
          close={closePalette}
        />
      )}
      {editingProject && (
        <ProjectEditorDialog
          project={editingProject}
          close={() => setEditingProject(null)}
          saved={changed}
        />
      )}
      {newProject && (
        <NewProject
          close={() => setNewProject(false)}
          created={(p) => {
            chooseProject(p.id);
            changed();
          }}
        />
      )}
    </div>
  );
}
function App() {
  const [session, setSession] = useState<{ authenticated: boolean; mcp_url: string } | null>(null),
    [error, setError] = useState("");
  const load = useCallback(() => {
    void request<NonNullable<typeof session>>("/api/session")
      .then(setSession)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  if (error)
    return (
      <LoginFrame>
        <Brand />
        <ErrorText>{error}</ErrorText>
        <button type="button" onClick={load}>
          Try again
        </button>
      </LoginFrame>
    );
  if (!session)
    return (
      <LoginFrame>
        <Brand />
        <p>Connecting…</p>
      </LoginFrame>
    );
  if (location.pathname === "/welcome") return <Login welcome done={load} />;
  if (!session.authenticated) return <Login done={load} />;
  if (location.pathname.startsWith("/tower/enroll/")) return <TowerEnrollmentView />;
  return <WorkspaceApp mcp={session.mcp_url} />;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
