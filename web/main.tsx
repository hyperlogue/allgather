import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Project } from "../shared/contracts.ts";
import { Activity } from "./activity.tsx";
import { call, mutation, request } from "./api.ts";
import { ArtifactsView } from "./artifacts.tsx";
import { HistoryView, type Repo } from "./history.tsx";
import { SessionsView } from "./sessions.tsx";
import { TasksView } from "./tasks.tsx";
import { TowerEnrollmentView } from "./tower-enrollment.tsx";
import { Dialog, ErrorText, useAction } from "./ui.tsx";

function Brand() {
  return (
    <span className="brand">
      <span aria-hidden="true" className="brand-mark">
        ▦
      </span>
      allgather
    </span>
  );
}
function Login({ done }: { done: () => void }) {
  const [key, setKey] = useState("");
  const { busy, error, run } = useAction();
  return (
    <main className="login">
      <Brand />
      <h1>Your work, together.</h1>
      <p>Use a one-time code from your Allgather server to sign in.</p>
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
      <p className="muted small">
        Create a code locally with allgather-server auth create-token. Codes expire after ten
        minutes.
      </p>
    </main>
  );
}
function Consent() {
  const [info, setInfo] = useState<{
      name: string;
      scopes: string[];
      redirect_uri: string;
      audience: "mcp" | "api";
      resource: string;
    } | null>(null),
    [loadError, setLoadError] = useState(""),
    [operatorName, setOperatorName] = useState("");
  const { busy, error, run } = useAction();
  useEffect(() => {
    void request<typeof info>(`/api/oauth/request${location.search}`)
      .then((value) => {
        setInfo(value);
        setOperatorName(value?.name ?? "");
      })
      .catch((e) => setLoadError(e.message));
  }, []);
  const params = Object.fromEntries(new URLSearchParams(location.search));
  return (
    <main className="login">
      <Brand />
      <h1>Connect an agent</h1>
      <ErrorText>{loadError || error}</ErrorText>
      {info ? (
        <>
          <p>
            <strong>{info.name}</strong> requests access to your allgather data.
          </p>
          <p>
            {info.audience === "mcp" ? "MCP connector access" : "Private API and CLI access"}:{" "}
            {info.resource}
          </p>
          <p className="notice">
            The application supplied this name. Allgather has not verified its identity. Approve
            only a connection you started.
          </p>
          {info.scopes.includes("admin") && (
            <p className="notice">
              Administrative API access includes machine credentials, policy changes and backups.
            </p>
          )}
          <label>
            Agent name
            <input
              maxLength={160}
              value={operatorName}
              onChange={(e) => setOperatorName(e.target.value)}
            />
          </label>
          <ul className="scope-list">
            {info.scopes.map((s) => (
              <li key={s}>
                {{
                  "tasks:read": "Read tasks and projects",
                  "tasks:write": "Create and change tasks",
                  "history:read": "Read Git history",
                  offline_access: "Keep access until you revoke it",
                }[s] ?? s}
              </li>
            ))}
          </ul>
          <p className="muted small">
            Return to {new URL(info.redirect_uri).host}. You can revoke access from Connections.
          </p>
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const url = new URL(info.redirect_uri);
                url.searchParams.set("error", "access_denied");
                if (params.state) url.searchParams.set("state", params.state);
                location.assign(url.toString());
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await request<{ redirect_uri: string }>("/api/oauth/authorize", {
                    ...params,
                    operator_name: operatorName,
                  });
                  location.assign(result.redirect_uri);
                })
              }
            >
              Allow access
            </button>
          </div>
        </>
      ) : (
        !loadError && <p>Reading the access request…</p>
      )}
    </main>
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
function Connections({ mcp }: { mcp: string }) {
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
        Add this URL in your client's MCP settings. Sign in to allgather and approve the requested
        access.
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
          No clients yet. Each client will ask for a separate access grant.
        </p>
      )}
      <div className="history-section">
        <h2>Access rules</h2>
        <p>
          Connections can read tasks, change tasks, and read Git history according to their granted
          scopes. They cannot run shell commands or change Git repositories.
        </p>
        <p className="muted small">
          Revocation stops the client's current tokens and future refresh attempts. Your browser and
          CLI remain connected.
        </p>
      </div>
    </div>
  );
}
function WorkspaceApp({ signOut, mcp }: { signOut: () => void; mcp: string }) {
  const [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState(new URLSearchParams(location.search).get("project") ?? ""),
    [repos, setRepos] = useState<Repo[]>([]),
    [view, setView] = useState(new URLSearchParams(location.search).get("view") ?? "tasks"),
    [newProject, setNewProject] = useState(false),
    [refresh, setRefresh] = useState(0),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(true);
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
    <>
      <header className="app-header">
        <Brand />
        <div className="project-picker">
          <label className="sr-only" htmlFor="project-select">
            Project
          </label>
          <select
            id="project-select"
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              const url = new URL(location.href);
              url.searchParams.set("project", e.target.value);
              url.searchParams.delete("task");
              history.replaceState(null, "", url);
            }}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="quiet"
            aria-label="New project"
            onClick={() => setNewProject(true)}
          >
            +
          </button>
        </div>
        <nav aria-label="Main navigation">
          {["tasks", "sessions", "artifacts", "history", "activity", "connections"].map((name) => (
            <button
              type="button"
              key={name}
              aria-current={view === name ? "page" : undefined}
              onClick={() => {
                setView(name);
                const url = new URL(location.href);
                url.searchParams.set("view", name);
                history.replaceState(null, "", url);
              }}
            >
              {
                {
                  tasks: "Tasks",
                  sessions: "Sessions",
                  artifacts: "Artifacts",
                  history: "Git history",
                  activity: "Activity",
                  connections: "Connections",
                }[name]
              }
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="quiet signout"
          onClick={() => void request("/api/logout", {}).then(signOut)}
        >
          Sign out
        </button>
      </header>
      {!connected && (
        <div className="connection-notice" role="status">
          Connection interrupted. The page will refresh after reconnection.
        </div>
      )}
      <main className="app-main">
        <ErrorText>{error}</ErrorText>
        {view === "tasks" ? (
          <TasksView
            key={project}
            project={project}
            title={projects.find((p) => p.id === project)?.name ?? "All tasks"}
            repos={repos}
            refresh={refresh}
            changed={changed}
            newProject={() => setNewProject(true)}
          />
        ) : view === "artifacts" ? (
          <ArtifactsView project={project} refresh={refresh} changed={changed} />
        ) : view === "sessions" ? (
          <SessionsView project={project} refresh={refresh} changed={changed} />
        ) : view === "history" ? (
          <HistoryView project={project} repos={repos} refresh={refresh} changed={changed} />
        ) : view === "activity" ? (
          <Activity project={project} refresh={refresh} />
        ) : (
          <Connections mcp={mcp} />
        )}
      </main>
      {newProject && (
        <NewProject
          close={() => setNewProject(false)}
          created={(p) => {
            setProject(p.id);
            changed();
          }}
        />
      )}
    </>
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
      <main className="login">
        <Brand />
        <ErrorText>{error}</ErrorText>
        <button type="button" onClick={load}>
          Try again
        </button>
      </main>
    );
  if (!session)
    return (
      <main className="login">
        <Brand />
        <p>Connecting…</p>
      </main>
    );
  if (!session.authenticated) return <Login done={load} />;
  if (location.pathname.startsWith("/tower/enroll/")) return <TowerEnrollmentView />;
  if (location.pathname === "/oauth/authorize") return <Consent />;
  return <WorkspaceApp mcp={session.mcp_url} signOut={load} />;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
