import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Project } from "../shared/contracts.ts";
import { Activity } from "./activity.tsx";
import { call, mutation, request } from "./api.ts";
import { ApprovalsView, useApprovals } from "./approvals.tsx";
import { ArtifactsView } from "./artifacts.tsx";
import { CommandPalette } from "./command-palette.tsx";
import { Consent } from "./consent.tsx";
import { HistoryView, type Repo } from "./history.tsx";
import { Icon } from "./icons.tsx";
import { MachineConnections } from "./machine-connections.tsx";
import { McpPairing } from "./mcp-pairing.tsx";
import { initialCollapsed, isEditing, readView, Sidebar, type View, views } from "./navigation.tsx";
import { SessionsView } from "./sessions.tsx";
import { SettingsView } from "./settings.tsx";
import { TasksView } from "./tasks.tsx";
import { TowerEnrollmentView } from "./tower-enrollment.tsx";
import { Brand, Dialog, ErrorText, LoginFrame, useAction } from "./ui.tsx";

function Login({ done }: { done: () => void }) {
  const [key, setKey] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const command = "allgather-server auth create-token";
  const { busy, error, run } = useAction();
  return (
    <LoginFrame>
      <Brand />
      <h1>Sign in to AllGather</h1>
      <p>Use a one-time code from your AllGather server to sign in.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await request("/api/login", { key });
            setKey("");
            done();
          });
        }}
      >
        <label>
          Login code
          <input
            autoComplete="one-time-code"
            type="password"
            required
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <ErrorText>{error}</ErrorText>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="muted small">Run this command on your AllGather server to get a login code:</p>
      <div className="login-command">
        <code>{command}</code>
        <button
          type="button"
          aria-label="Copy login command"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command);
              setCopyStatus("Command copied.");
            } catch {
              setCopyStatus("Could not copy. Select and copy the command above.");
            }
          }}
        >
          Copy
        </button>
      </div>
      <p className="muted small" role="status">
        {copyStatus}
      </p>
      <p className="muted small">Codes work once and expire after ten minutes.</p>
    </LoginFrame>
  );
}
function NewProject({ close, created }: { close: () => void; created: (p: Project) => void }) {
  const [name, setName] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Dialog title="New project" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const p = await call<Project>("projects_create", { name, ...mutation() });
            created(p);
            close();
          });
        }}
      >
        <label>
          Name
          <input required maxLength={300} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Create project
          </button>
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
  const [clients, setClients] = useState<
    { id: string; name: string; revoked: number; created_at: string }[]
  >([]);
  const { busy, error, run } = useAction();
  const load = useCallback(() => request<typeof clients>("/api/clients").then(setClients), []);
  useEffect(() => {
    void run(async () => {
      await load();
    });
  }, [load, run]);
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
        <p className="notice">
          This server uses a local address. Configure an HTTPS public URL before connecting a hosted
          agent.
        </p>
      )}
      <ErrorText>{error}</ErrorText>
      <h2>Registered clients</h2>
      {clients.length ? (
        <ul className="plain-list">
          {clients.map((client) => (
            <li key={client.id}>
              <span>
                <strong>{client.name}</strong>
                <small>
                  {client.revoked
                    ? "Revoked"
                    : `Registered ${new Date(client.created_at).toLocaleDateString()}`}
                </small>
              </span>
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
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-copy">
          No clients yet. Each pairing connects one client with the access you choose.
        </p>
      )}
      <MachineConnections refresh={refresh} manage={manageMachines} />
      <div className="pairing-panels">
        <McpPairing changed={() => void load()} />
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
function WorkspaceApp({ mcp }: { mcp: string }) {
  const [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState(new URLSearchParams(location.search).get("project") ?? ""),
    [repos, setRepos] = useState<Repo[]>([]),
    [view, setView] = useState<View>(readView(new URLSearchParams(location.search).get("view"))),
    [collapsed, setCollapsed] = useState(initialCollapsed),
    [palette, setPalette] = useState(false),
    [routeRevision, setRouteRevision] = useState(0),
    [newProject, setNewProject] = useState(false),
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
  const chooseProject = useCallback((id: string) => {
    const url = new URL(location.href);
    url.searchParams.set("project", id);
    url.searchParams.set("view", "tasks");
    url.searchParams.delete("task");
    url.searchParams.delete("action");
    history.pushState(null, "", url);
    setProject(id);
    setView("tasks");
    if (matchMedia("(max-width: 760px)").matches) setCollapsed(true);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("allgather-sidebar-collapsed", String(collapsed));
    } catch {}
  }, [collapsed]);
  useEffect(() => {
    const back = () => {
      const p = new URLSearchParams(location.search);
      setProject(p.get("project") ?? "");
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
      call<Repo[]>("repositories_list", { project_id: project || undefined }),
    ])
      .then(([ps, rs]) => {
        if (!live) return;
        setProjects(ps);
        setRepos(rs);
        setError("");
        if (!initialized.current) {
          initialized.current = true;
          if (!new URLSearchParams(location.search).has("project"))
            setProject((current) => current || ps[0]?.id || "");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [project, refresh]);
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
        project={project}
        projects={projects}
        pending={pendingApprovals.length}
        connected={connected}
        collapsed={collapsed}
        refresh={refresh}
        navigate={navigate}
        chooseProject={chooseProject}
        newProject={() => setNewProject(true)}
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
          <div className="project-picker">
            <label className="sr-only" htmlFor="project-select">
              Project
            </label>
            <select
              id="project-select"
              value={project}
              onChange={(e) => chooseProject(e.target.value)}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <span className="breadcrumb-separator">/</span>
          <span className="workspace-view-title">{views.find(([name]) => name === view)?.[1]}</span>
          <div id="view-heading" />
          <button
            type="button"
            className="quiet topbar-search"
            aria-label="Open workspace search"
            onClick={() => setPalette(true)}
          >
            <Icon name="search" />
          </button>
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
              key={`${project}:${routeRevision}`}
              project={project}
              title={projects.find((p) => p.id === project)?.name ?? "All tasks"}
              repos={repos}
              refresh={refresh}
              changed={changed}
              newProject={() => setNewProject(true)}
            />
          ) : view === "artifacts" ? (
            <ArtifactsView
              key={routeRevision}
              project={project}
              refresh={refresh}
              changed={changed}
            />
          ) : view === "sessions" ? (
            <SessionsView
              key={routeRevision}
              project={project}
              refresh={refresh}
              changed={changed}
            />
          ) : view === "history" ? (
            <HistoryView project={project} repos={repos} refresh={refresh} changed={changed} />
          ) : view === "approvals" ? (
            <ApprovalsView rows={approvals} changed={changed} />
          ) : view === "settings" ? (
            <SettingsView />
          ) : view === "activity" ? (
            <Activity project={project} refresh={refresh} />
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
          project={project}
          projects={projects}
          navigate={navigate}
          chooseProject={chooseProject}
          newProject={() => setNewProject(true)}
          close={closePalette}
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
  if (!session.authenticated) return <Login done={load} />;
  if (location.pathname.startsWith("/tower/enroll/")) return <TowerEnrollmentView />;
  if (location.pathname === "/oauth/authorize") return <Consent />;
  return <WorkspaceApp mcp={session.mcp_url} />;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
