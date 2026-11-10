import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact } from "../shared/artifacts.ts";
import type { AgentSession, Page, Project, Task } from "../shared/contracts.ts";
import { call } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { type View, views } from "./navigation.tsx";
import { ProjectIcon } from "./project-icon.tsx";
import { scopeFilter, scopeName, singleProject } from "./project-scope.ts";

interface Result {
  id: string;
  title: string;
  group: string;
  icon: IconName;
  project?: Project;
  hint?: string;
  run: () => void;
}
export function CommandPalette({
  scope,
  projects,
  navigate,
  chooseProject,
  newProject,
  editProject,
  close,
}: {
  scope: string[];
  projects: Project[];
  navigate: (view: View, params?: Record<string, string>) => void;
  chooseProject: (id: string) => void;
  newProject: () => void;
  editProject: (project: Project) => void;
  close: () => void;
}) {
  const project = singleProject(scope);
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [matches, setMatches] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const go = useCallback(
    (view: View, params?: Record<string, string>) => {
      close();
      navigate(view, params);
    },
    [close, navigate],
  );
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector("input")?.focus();
  }, []);
  useEffect(() => {
    let active = true;
    const text = query.trim();
    setMatches([]);
    setError("");
    setLoading(!!text);
    if (!text) return;
    const timer = setTimeout(() => {
      void Promise.all([
        call<Page<Task>>("tasks_search", {
          query: text,
          ...scopeFilter(scope),
          limit: 6,
        }),
        call<Page<AgentSession>>("sessions_search", {
          query: text,
          ...scopeFilter(scope),
          limit: 4,
        }),
        call<{ artifacts: Artifact[] }>("artifacts_search", {
          query: text,
          ...scopeFilter(scope),
          limit: 4,
        }),
      ])
        .then(([tasks, sessions, artifacts]) => {
          if (!active) return;
          setMatches([
            ...tasks.items.map((t) => ({
              id: t.id,
              title: t.title,
              group: "Tasks",
              icon: "tasks" as const,
              hint: t.id,
              run: () => go("tasks", { task: t.id }),
            })),
            ...sessions.items.map((s) => ({
              id: s.id,
              title: s.label ?? s.id,
              group: "Sessions",
              icon: "sessions" as const,
              hint: s.agent_type,
              run: () => go("sessions", { session: s.id }),
            })),
            ...artifacts.artifacts.map((a) => ({
              id: a.id,
              title: a.title ?? a.id,
              group: "Library",
              icon: "artifacts" as const,
              hint: a.kind,
              run: () => go("artifacts", { artifact: a.id }),
            })),
          ]);
          setLoading(false);
        })
        .catch((e) => {
          if (active) {
            setError(e.message);
            setLoading(false);
          }
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, scope, go]);
  const selection = new URLSearchParams(location.search);
  const selectedTask = selection.get("view") === "tasks" ? selection.get("task") : null;
  const actions: Result[] = [
    {
      id: "new-session",
      title: "New session",
      group: "Actions",
      icon: "sessions",
      run: () => go("sessions", { action: "new-session" }),
    },
    ...(selectedTask
      ? [
          {
            id: "edit-task",
            title: "Edit or assign selected task…",
            group: "Actions",
            icon: "tasks" as const,
            run: () => go("tasks", { task: selectedTask, action: "edit-task" }),
          },
        ]
      : []),
    ...(scope.length > 1
      ? []
      : [
          {
            id: "new-task",
            title: "New task",
            group: "Actions",
            icon: "plus" as const,
            run: () => (project ? go("tasks", { action: "new-task" }) : (close(), newProject())),
          },
        ]),
    ...projects
      .filter((p) => p.id === project)
      .map((p) => ({
        id: "edit-project",
        title: `Edit ${p.name}…`,
        group: "Actions",
        icon: "settings" as const,
        run: () => {
          close();
          editProject(p);
        },
      })),
    {
      id: "new-project",
      title: "New project",
      group: "Actions",
      icon: "plus",
      run: () => {
        close();
        newProject();
      },
    },
    ...views.map(([view, label]) => ({
      id: view,
      title: label,
      group: "Go to",
      icon: view as IconName,
      run: () => go(view),
    })),
    ...projects.map((p) => ({
      id: p.id,
      title: p.name,
      project: p,
      group: "Projects",
      icon: "tasks" as const,
      run: () => {
        close();
        chooseProject(p.id);
      },
    })),
  ];
  const results = [
    ...actions.filter((r) =>
      r.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ),
    ...matches,
  ];
  const index = Math.min(selected, Math.max(0, results.length - 1));
  useEffect(() => {
    document.getElementById(`palette-result-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  return (
    <dialog className="command-palette" ref={dialog} onCancel={close} aria-label="Search or jump">
      <div className="palette-search">
        <Icon name="search" />
        <input
          role="combobox"
          aria-label="Search workspace"
          aria-autocomplete="list"
          aria-controls="palette-results"
          aria-expanded="true"
          aria-activedescendant={results.length ? `palette-result-${index}` : undefined}
          value={query}
          maxLength={256}
          placeholder="Search tasks, sessions, artifacts, or jump…"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setSelected(
                (index + (e.key === "ArrowDown" ? 1 : -1) + results.length) %
                  Math.max(1, results.length),
              );
            }
            if (e.key === "Enter" && results[index]) {
              e.preventDefault();
              results[index].run();
            }
          }}
        />
        <button type="button" className="quiet" aria-label="Close search" onClick={close}>
          <kbd>esc</kbd>
        </button>
      </div>
      <div className="palette-scope">
        {scopeName(projects.filter((p) => scope.includes(p.id)))}
        <span>Search scope</span>
      </div>
      <div id="palette-results" role="listbox" aria-label="Workspace results">
        {results.map((r, i) => (
          <div key={`${r.group}:${r.id}`}>
            {(i === 0 || r.group !== results[i - 1].group) && (
              <div className="palette-group">{r.group}</div>
            )}
            <button
              type="button"
              tabIndex={-1}
              id={`palette-result-${i}`}
              role="option"
              aria-selected={i === index}
              className={`palette-result ${i === index ? "selected" : ""}`}
              onMouseMove={() => setSelected(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={r.run}
            >
              {r.project ? <ProjectIcon project={r.project} /> : <Icon name={r.icon} />}
              <span>{r.title}</span>
              {r.hint && <small title={r.hint}>{r.hint}</small>}
              <kbd>↵</kbd>
            </button>
          </div>
        ))}
        {!results.length && !loading && <p className="empty-copy">No matching results.</p>}
        <p className={error ? "error" : "palette-status"} role="status">
          {error || (loading ? "Searching…" : "")}
        </p>
      </div>
      <footer>
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> navigate
        </span>
        <span>
          <kbd>↵</kbd> open
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </footer>
    </dialog>
  );
}
