import { useEffect, useState } from "react";
import type { IndexedCommit, Page, Project, Repository } from "../shared/contracts.ts";
import { call, mutation } from "./api.ts";
import { Checkouts } from "./checkouts.tsx";
import { ContextLink } from "./context.tsx";
import { CopyId } from "./copy-id.tsx";
import { scopeFilter, singleProject } from "./project-scope.ts";
import { Banner, Button, Checkbox, Dialog, ErrorText, PageHeading, useAction } from "./ui.tsx";
export interface Repo extends Repository {
  indexed_count: number;
  sync: {
    status: string;
    error: string | null;
    last_success: {
      at: string;
      refs: Record<string, string>;
      reachable_count: number;
      truncated: boolean;
    } | null;
  };
}
interface Summary {
  total: number;
  merges: number;
  commits_with_partial_files: number;
  from: string;
  through: string;
  daily: { date: string; commits: number; merges: number }[];
  paths: { repository_id: string; path: string; changes: number }[];
  coverage_note: string;
}
interface Storage {
  at: string | null;
  database_bytes: number;
  wal_bytes: number;
  blob_store_bytes: number;
  cache_bytes_by_repo: Record<string, number>;
  free_bytes: number | null;
  growth?: {
    since: string;
    total_bytes: number;
    database_bytes: number;
    blob_store_bytes: number;
    cache_bytes: number;
  } | null;
}
const size = (bytes: number | undefined) =>
  bytes === undefined
    ? "—"
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
function RepositoryEditor({
  project,
  repo,
  close,
  changed,
}: {
  project: string;
  repo?: Repo;
  close: () => void;
  changed: () => void;
}) {
  const [name, setName] = useState(repo?.name ?? ""),
    [url, setUrl] = useState(repo?.upstream_url ?? ""),
    [branches, setBranches] = useState(repo?.branches.join("\n") ?? "main"),
    [tags, setTags] = useState(repo?.tag_regex ?? ""),
    [aliases, setAliases] = useState(repo?.url_aliases?.join("\n") ?? ""),
    [prefixes, setPrefixes] = useState(""),
    [initial, setInitial] = useState(repo?.initial_fetch_limit ?? 10000),
    [cap, setCap] = useState(
      repo?.max_indexed_commits === null ? "" : String(repo?.max_indexed_commits ?? 100000),
    ),
    [policy, setPolicy] = useState(repo?.cache_policy ?? "metadata_only"),
    [enabled, setEnabled] = useState(repo ? !!repo.sync_enabled : true),
    { busy, error, run } = useAction();
  return (
    <Dialog title={repo ? "Repository settings" : "Connect upstream"} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const values = {
              name,
              upstream_url: url,
              url_aliases: aliases
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
              branches: branches
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
              tag_regex: tags || null,
              initial_fetch_limit: initial,
              max_indexed_commits: cap ? Number(cap) : null,
              cache_policy: policy,
              sync_enabled: enabled,
              ...mutation(),
            };
            await call(
              repo ? "repositories_update" : "repositories_create",
              repo
                ? { ...values, repository_id: repo.id, expected_revision: repo.revision }
                : {
                    ...values,
                    project_id: project,
                    path_prefixes: prefixes
                      .split("\n")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  },
            );
            changed();
            close();
          });
        }}
      >
        <label>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Upstream URL
          <input
            required
            readOnly={!!repo?.upstream_url}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="git@example.com:team/project.git"
          />
        </label>
        <label>
          Other URLs for this repository
          <textarea
            rows={2}
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="One SSH or HTTPS alias per line"
          />
          <small>
            Match checkout and artifact links. Collection still uses the upstream URL above.
          </small>
        </label>
        {!repo && (
          <label>
            Project path prefixes
            <textarea
              rows={2}
              value={prefixes}
              onChange={(e) => setPrefixes(e.target.value)}
              placeholder="apps/web/\npackages/ui/"
            />
            <small>
              Optional, one per line. Used when the repository is shared. Use . for the whole
              repository.
            </small>
          </label>
        )}
        <label>
          Branches, one per line
          <textarea
            required
            rows={3}
            value={branches}
            onChange={(e) => setBranches(e.target.value)}
          />
        </label>
        <label>
          Tag regex
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="^v[0-9]+\\.[0-9]+\\.[0-9]+$"
          />
        </label>
        <div className="form-row">
          <label>
            Initial commits
            <input
              type="number"
              min={1}
              max={1000000}
              value={initial}
              onChange={(e) => setInitial(Number(e.target.value))}
            />
          </label>
          <label>
            Retained commits
            <input
              type="number"
              min={1}
              max={10000000}
              value={cap}
              placeholder="Unlimited"
              onChange={(e) => setCap(e.target.value)}
            />
          </label>
        </div>
        <label>
          Cache policy
          <select value={policy} onChange={(e) => setPolicy(e.target.value as typeof policy)}>
            <option value="metadata_only">Metadata only</option>
            <option value="allow_full_cache">Allow full cache</option>
          </select>
        </label>
        <Checkbox
          label="Automatic refresh"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <p className="muted small">
          AllGather fetches upstream using the server’s SSH or HTTPS credentials. At the retained
          limit, the oldest metadata is removed. Switching cache policy queues a rebuild.
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <Button variant="primary" type="submit" disabled={busy}>
            Save connection
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function RepositoryProjectsEditor({
  repo,
  project,
  projects,
  close,
  changed,
}: {
  repo: Repo;
  project: string;
  projects: Project[];
  close: () => void;
  changed: () => void;
}) {
  const initial = project || repo.project_links[0]?.project_id || projects[0]?.id || "";
  const [selected, setSelected] = useState(initial);
  const [prefixes, setPrefixes] = useState(
    repo.project_links.find((l) => l.project_id === initial)?.path_prefixes.join("\n") ?? "",
  );
  const { busy, error, run } = useAction();
  const link = repo.project_links.find((l) => l.project_id === selected);
  const name = projects.find((p) => p.id === selected)?.name ?? selected;
  return (
    <Dialog title={`Projects for ${repo.name}`} close={close}>
      <p>
        Link this repository to one or more projects. Each project can use multiple repositories.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const input = {
              repository_id: repo.id,
              project_id: selected,
              path_prefixes: prefixes
                .split("\n")
                .map((p) => p.trim())
                .filter(Boolean),
              ...mutation(),
            };
            if (link)
              await call("repositories_set_paths", { ...input, expected_revision: link.revision });
            else await call("repositories_attach", input);
            changed();
            close();
          });
        }}
      >
        <label>
          Project
          <select
            required
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setPrefixes(
                repo.project_links
                  .find((l) => l.project_id === e.target.value)
                  ?.path_prefixes.join("\n") ?? "",
              );
            }}
          >
            {!projects.length && <option value="">Create a project first</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {repo.project_ids.includes(p.id) ? " (linked)" : ""}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          {link ? "This project is linked to the repository." : "This project is not linked yet."}
        </p>
        <label>
          Path prefixes
          <textarea
            rows={5}
            value={prefixes}
            onChange={(e) => setPrefixes(e.target.value)}
            placeholder="apps/web/\npackages/ui/"
          />
        </label>
        <p className="muted small">
          Optional, one repository-relative prefix per line. A repository linked to one project uses
          that project directly. For shared repositories, the longest matching prefix selects the
          project; . covers the repository root.
        </p>
        <p className="muted small">
          Changing a mapping keeps the repository and its indexed history. No new Git fetch is
          needed.
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="actions">
          {link && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    `Unlink ${repo.name} from ${name}? The repository and its indexed history will be kept.`,
                  )
                )
                  void run(async () => {
                    await call("repositories_attach", {
                      repository_id: repo.id,
                      project_id: selected,
                      remove: true,
                      ...mutation(),
                    });
                    changed();
                    close();
                  });
              }}
            >
              Unlink project
            </Button>
          )}
          <button type="button" onClick={close}>
            Cancel
          </button>
          <Button type="submit" variant="primary" disabled={busy || !selected}>
            {link ? "Save project paths" : "Link project"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
export function HistoryView({
  scope,
  projects,
  repos,
  refresh,
  changed,
}: {
  scope: string[];
  projects: Project[];
  repos: Repo[];
  refresh: number;
  changed: () => void;
}) {
  const project = singleProject(scope);
  const [summary, setSummary] = useState<Summary | null>(null),
    [page, setPage] = useState<Page<IndexedCommit>>({
      items: [],
      total: 0,
      next_cursor: null,
    }),
    [storage, setStorage] = useState<Storage | null>(null),
    [query, setQuery] = useState(""),
    [cursor, setCursor] = useState(0),
    [connection, setConnection] = useState<Repo | "new" | null>(null),
    [projectMapping, setProjectMapping] = useState<Repo | null>(null),
    [selected, setSelected] = useState<IndexedCommit | null>(null),
    [backfill, setBackfill] = useState<Repo | null>(null),
    [count, setCount] = useState(10000),
    [loadError, setLoadError] = useState(""),
    { busy, error, run } = useAction();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh counters reload committed server state.
  useEffect(() => {
    let live = true;
    void Promise.all([
      call<Summary>("history_summary", scopeFilter(scope)),
      call<typeof page>("history_search", { ...scopeFilter(scope), query, cursor }),
      call<Storage>("storage_get"),
    ])
      .then(([s, p, d]) => {
        if (live) {
          setSummary(s);
          setPage(p);
          setStorage(d);
          setLoadError("");
        }
      })
      .catch((e) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [scope, refresh, query, cursor]);
  const action = (name: "repositories_sync" | "repositories_clear_cache", id: string) =>
    void run(async () => {
      await call(name, { repository_id: id, ...mutation() });
      changed();
    });
  const maximum = Math.max(1, ...(summary?.daily.map((d) => d.commits) ?? []));
  return (
    <div className="history-view">
      <PageHeading>
        <div>
          <h1>Git history</h1>
          <p>Published work across your upstream repositories.</p>
        </div>
        <Button variant="primary" disabled={!project} onClick={() => setConnection("new")}>
          Connect upstream
        </Button>
      </PageHeading>
      <ErrorText>{loadError || error}</ErrorText>
      {summary && (
        <>
          <div className="metrics">
            <div>
              <strong>{summary.total}</strong>
              <span>Commits in 30 days</span>
            </div>
            <div>
              <strong>{summary.merges}</strong>
              <span>Merge commits</span>
            </div>
            <div>
              <strong>{repos.length}</strong>
              <span>Repositories</span>
            </div>
          </div>
          <div
            className="chart"
            role="img"
            aria-label={`${summary.total} retained commits in the last 30 days`}
          >
            {summary.daily.map((d) => (
              <div className="chart-column" key={d.date} title={`${d.date}: ${d.commits} commits`}>
                <span style={{ height: `${(d.commits / maximum) * 100}%`, minHeight: 2 }} />
              </div>
            ))}
          </div>
          <div className="chart-labels">
            <span>{summary.from}</span>
            <span>{summary.through}</span>
          </div>
          <p className="muted small">
            {summary.coverage_note} Commit counts describe activity, not productivity.
          </p>
        </>
      )}
      {projectMapping && (
        <RepositoryProjectsEditor
          repo={projectMapping}
          project={project}
          projects={projects}
          close={() => setProjectMapping(null)}
          changed={changed}
        />
      )}
      <section className="history-section">
        <h2>Repositories</h2>
        {!!scope.length && (
          <p className="muted small">
            Showing repositories linked to the selected projects. Select All projects in the sidebar
            to link an existing repository.
          </p>
        )}
        {repos.map((r) => (
          <article className="repo-row" key={r.id}>
            <div className="section-line">
              <div>
                <strong>{r.name}</strong>
                <code>{r.upstream_url}</code>
                <small className="repo-projects">
                  {r.project_links.length
                    ? `Projects: ${r.project_links.map((link) => projects.find((p) => p.id === link.project_id)?.name ?? link.project_id).join(", ")}`
                    : "No projects linked"}
                </small>
              </div>
              <div className="heading-actions">
                <button
                  type="button"
                  disabled={busy || r.sync.status === "running"}
                  onClick={() => action("repositories_sync", r.id)}
                >
                  Sync now
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const current = (await call<Repo[]>("repositories_list")).find(
                        (repo) => repo.id === r.id,
                      );
                      if (!current) throw new Error("Repository is no longer available");
                      setProjectMapping(current);
                    })
                  }
                >
                  Manage projects
                </button>
                <button type="button" onClick={() => setConnection(r)}>
                  Settings
                </button>
              </div>
            </div>
            <p>
              {r.sync.status} · {r.indexed_count.toLocaleString()} retained /{" "}
              {r.max_indexed_commits?.toLocaleString() ?? "unlimited"} · {r.branches.join(", ")}
            </p>
            {r.sync.error && <Banner tone="danger">{r.sync.error}</Banner>}
            <p className="muted small">
              {r.sync.last_success
                ? `Last collected ${new Date(r.sync.last_success.at).toLocaleString()}`
                : "No successful collection yet"}{" "}
              · {r.actual_cache_mode} cache · {size(storage?.cache_bytes_by_repo?.[r.id])}
            </p>
            <div className="heading-actions">
              <Button variant="quiet" onClick={() => setBackfill(r)}>
                Fetch older history
              </Button>
              <Button
                variant="quiet"
                disabled={busy}
                onClick={() => action("repositories_clear_cache", r.id)}
              >
                Clear cache
              </Button>
              <small>Cleanup: {r.cache_cleanup}</small>
            </div>
          </article>
        ))}
        {!repos.length && (
          <p className="muted">Connect an SSH or HTTPS upstream to collect commits.</p>
        )}
      </section>
      <Checkouts repositories={repos} filtered={!!scope.length} refresh={refresh} />
      <section className="history-section">
        <div className="section-line">
          <h2>Commits</h2>
          <label className="search">
            <span className="sr-only">Search commit messages</span>
            <input
              placeholder="Search commit messages"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
            />
          </label>
        </div>
        <ul className="commit-list">
          {page.items.map((c) => (
            <li key={c.repository_id + c.id}>
              <button type="button" onClick={() => setSelected(c)}>
                <span>
                  {c.message.split("\n")[0]}
                  <small>
                    {c.author?.name ?? "Unknown author"} ·{" "}
                    {new Date(c.committed_at).toLocaleDateString()}
                    {c.project_attribution.basis === "unassigned"
                      ? " · No project match"
                      : c.project_attribution.project_ids.length > 1
                        ? ` · ${c.project_attribution.project_ids.length} project matches`
                        : ""}
                  </small>
                </span>
                <code>{c.id.slice(0, 8)}</code>
              </button>
            </li>
          ))}
        </ul>
        {!page.items.length && <p className="muted">No retained commits match this view.</p>}
        <div className="pagination">
          <button
            type="button"
            disabled={!cursor}
            onClick={() => setCursor(Math.max(0, cursor - 50))}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={page.next_cursor === null}
            onClick={() => setCursor(page.next_cursor!)}
          >
            Next
          </button>
        </div>
      </section>
      <section className="history-section">
        <h2>Paths that change most</h2>
        {summary?.commits_with_partial_files ? (
          <Banner>
            Path coverage is incomplete for {summary.commits_with_partial_files} commits.
          </Banner>
        ) : null}
        <ul className="plain-list">
          {summary?.paths.slice(0, 20).map((p) => (
            <li key={p.repository_id + p.path} className="hot-path">
              <code>{p.path}</code>
              <span>{p.changes} changes</span>
              <meter
                min={0}
                max={Math.max(1, ...(summary?.paths.map((path) => path.changes) ?? []))}
                value={p.changes}
                aria-label={`${p.path}: ${p.changes} changes`}
              />
            </li>
          ))}
        </ul>
      </section>
      <section className="history-section">
        <h2>Storage</h2>
        {storage?.at ? (
          <>
            <div className="metrics">
              <div>
                <strong>{size((storage.database_bytes ?? 0) + (storage.wal_bytes ?? 0))}</strong>
                <span>SQLite and WAL</span>
              </div>
              <div>
                <strong>{size(storage.blob_store_bytes)}</strong>
                <span>Artifact and session content</span>
              </div>
              <div>
                <strong>{storage.free_bytes === null ? "—" : size(storage.free_bytes)}</strong>
                <span>Free on data volume</span>
              </div>
            </div>
            {storage.growth && (
              <p className="small">
                {storage.growth.total_bytes >= 0 ? "+" : "−"}
                {size(Math.abs(storage.growth.total_bytes))} since{" "}
                {new Date(storage.growth.since).toLocaleString()}{" "}
                <span className="muted">· measured storage change, up to 24 hours</span>
              </p>
            )}
            <p className="muted small">
              Measured {new Date(storage.at).toLocaleString()}. Cache cleanup and database file
              reclamation can lag behind metadata eviction.
            </p>
          </>
        ) : (
          <p className="muted">Storage measurements are pending.</p>
        )}
      </section>
      {connection && (
        <RepositoryEditor
          project={project}
          repo={connection === "new" ? undefined : connection}
          close={() => setConnection(null)}
          changed={changed}
        />
      )}
      {backfill && (
        <Dialog title="Fetch older history" close={() => setBackfill(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await call("repositories_backfill", {
                  repository_id: backfill.id,
                  count,
                  ...mutation(),
                });
                setBackfill(null);
                changed();
              });
            }}
          >
            <p>
              Older history must fit within the retained-commit limit. Increase that limit in
              Settings if necessary.
            </p>
            <label>
              Additional commits
              <input
                type="number"
                min={1}
                max={1000000}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </label>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" variant="primary" disabled={busy}>
              Request backfill
            </Button>
          </form>
        </Dialog>
      )}
      {selected && (
        <Dialog title="Commit" close={() => setSelected(null)}>
          <CopyId value={selected.id} />
          <p className="commit-message">{selected.message}</p>
          <ContextLink id={`commit:${selected.repository_id}:${selected.id}`} />
          <p className="muted small">
            {selected.author?.name} · {new Date(selected.committed_at).toLocaleString()}
          </p>
          {!selected.files_complete && (
            <Banner>Some parent tree data is outside the retained cache.</Banner>
          )}
          <ul className="plain-list">
            {selected.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
                <small>{f.change ?? "changed"}</small>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </div>
  );
}
