import {
  AppError,
  can,
  type GitCommit,
  type IndexedCommit,
  type Operation,
  type Principal,
  type Repository,
} from "../shared/contracts.ts";
import { type GitCollection, remoteUrl, validateSelection } from "./native-git.ts";
import { RepositoryProjects } from "./repository-projects.ts";
import { uid, type Workspace } from "./workspace.ts";

type Input = Record<string, unknown>;
export class History {
  readonly projects: RepositoryProjects;
  constructor(private w: Workspace) {
    this.projects = new RepositoryProjects(w.db);
  }
  repository(id: string): Repository {
    const r = this.w.one<Record<string, unknown>>("SELECT * FROM repositories WHERE id=?", id);
    if (!r) throw new AppError("not_found", "Repository not found", 404);
    this.w.access.require(this.w.access.repository(id));
    const links = this.projects.list(id);
    // Earlier layouts remain migratable; they are not a second public model.
    for (const field of [
      "project_id",
      "upstream_id",
      "refs",
      "history_limit",
      "collection_checkpoint",
    ])
      delete r[field];
    return {
      ...r,
      branches: JSON.parse(String(r.branches)),
      url_aliases: JSON.parse(String(r.url_aliases)),
      project_ids: links.map((link) => link.project_id),
      project_links: links,
    } as unknown as Repository;
  }
  findUpstream(value: string) {
    let url: string;
    try {
      url = remoteUrl(value, this.w.options.allowLocalGit);
    } catch {
      return null;
    }
    return this.w.one<{ id: string }>(
      "SELECT r.id FROM repositories r WHERE r.upstream_url=? OR EXISTS(SELECT 1 FROM json_each(r.url_aliases) a WHERE a.value=?)",
      url,
      url,
    );
  }
  private aliases(values: string[], primary: string, id?: string) {
    const aliases = [
      ...new Set(values.map((v) => remoteUrl(v, this.w.options.allowLocalGit))),
    ].filter((v) => v !== primary);
    for (const alias of aliases) {
      const match = this.findUpstream(alias);
      if (match && match.id !== id)
        throw new AppError(
          "repository_alias_conflict",
          "This URL already identifies another repository",
          409,
        );
    }
    return aliases;
  }
  repositories(projects: string[] | null = null) {
    const scope = this.w.projectScopeSql("pr.project_id", projects);
    return this.w
      .all<{ id: string }>(
        `SELECT id FROM repositories WHERE (? IS NULL OR EXISTS(SELECT 1 FROM project_repositories pr WHERE pr.repository_id=repositories.id AND ${scope.sql})) ORDER BY name,id`,
        scope.args[0],
        ...scope.args,
      )
      .filter(({ id }) => this.w.access.repository(id))
      .map(({ id }) => {
        const r = this.repository(id),
          scan = this.w.one<{
            captured_at: string;
            refs: string;
            reachable: string;
            truncated: number;
          }>(
            "SELECT s.* FROM sources src JOIN scans s ON s.id=src.success_scan WHERE src.repository_id=? AND src.source_id='upstream'",
            id,
          ),
          count = this.w.one<{ n: number }>(
            "SELECT COUNT(*) n FROM commits WHERE repository_id=? AND verified_upstream=1",
            id,
          )!.n;
        return {
          ...r,
          indexed_count: count,
          sync: {
            status: r.sync_status,
            error: r.sync_error,
            last_attempt_at: r.last_attempt_at,
            next_sync_at: r.next_sync_at,
            last_success: scan
              ? {
                  at: scan.captured_at,
                  refs: JSON.parse(scan.refs),
                  reachable_count: count,
                  truncated: !!scan.truncated,
                }
              : null,
          },
        };
      });
  }
  checkpoint(id: string) {
    const row = this.w.one<{ collection_checkpoint: string | null }>(
      "SELECT collection_checkpoint FROM repositories WHERE id=?",
      id,
    );
    return row?.collection_checkpoint
      ? (JSON.parse(row.collection_checkpoint) as GitCollection["checkpoint"])
      : null;
  }
  private unpack(c: Record<string, unknown>): GitCommit & { repository_id: string } {
    const files = JSON.parse(String(c.files)) as GitCommit["files"];
    return {
      id: String(c.id),
      repository_id: String(c.repository_id),
      parents: JSON.parse(String(c.parents)),
      message: String(c.message),
      author: c.author ? JSON.parse(String(c.author)) : undefined,
      committer: c.committer ? JSON.parse(String(c.committer)) : undefined,
      authored_at: String(c.authored_at),
      committed_at: String(c.committed_at),
      files,
      files_complete: !!c.files_complete,
      files_observed: !!c.files_observed,
    };
  }
  private attributed(
    c: Record<string, unknown>,
    resolve = this.projects.resolver(),
  ): IndexedCommit {
    const commit = this.unpack(c);
    return {
      ...commit,
      project_attribution: resolve(
        commit.repository_id,
        commit.files.map((file) => file.path),
        commit.files_complete,
      ),
    };
  }
  cached(repository: string, id: string) {
    const c = this.w.one<Record<string, unknown>>(
      "SELECT * FROM commits WHERE repository_id=? AND id=? AND verified_upstream=1",
      repository,
      id,
    );
    return c ? this.unpack(c) : null;
  }
  private selection(a: Input) {
    const projects = this.w.projectScope(a);
    const args: (string | number | null)[] = [
      (a.repository_id as string) ?? null,
      (a.repository_id as string) ?? null,
    ];
    let match = projects ? ` AND ${RepositoryProjects.commitFilter}` : "";
    if (projects) args.push(JSON.stringify(projects));
    if (a.query) {
      const terms = String(a.query).trim().split(/\s+/).filter(Boolean).slice(0, 16);
      if (terms.length) {
        match +=
          " AND EXISTS(SELECT 1 FROM commit_search s WHERE s.repository_id=c.repository_id AND s.commit_id=c.id AND commit_search MATCH ?)";
        args.push(terms.map((t) => '"' + t.replaceAll('"', '""') + '"*').join(" AND "));
      }
    }
    if (a.after) {
      match += " AND c.committed_at>=?";
      args.push(String(a.after));
    }
    if (a.before) {
      match += " AND c.committed_at<=?";
      args.push(String(a.before));
    }
    const access = this.w.access.repositorySql("c.repository_id");
    match += ` AND (${access.sql})`;
    args.push(...access.args);
    return {
      sql: `FROM commits c WHERE c.verified_upstream=1 AND (? IS NULL OR c.repository_id=?)${match}`,
      args,
    };
  }
  private current(a: Input) {
    const { sql, args } = this.selection(a);
    return this.w
      .all<Record<string, unknown>>(`SELECT c.* ${sql} ORDER BY c.committed_at DESC,c.id`, ...args)
      .map((c) => this.unpack(c));
  }
  private search(a: Input) {
    const resolve = this.projects.resolver();
    const { sql, args } = this.selection(a),
      limit = Number(a.limit),
      cursor = Number(a.cursor),
      total = this.w.one<{ n: number }>(`SELECT COUNT(*) n ${sql}`, ...args)!.n;
    return {
      items: this.w
        .all<Record<string, unknown>>(
          `SELECT c.* ${sql} ORDER BY c.committed_at DESC,c.id LIMIT ? OFFSET ?`,
          ...args,
          limit,
          cursor,
        )
        .map((c) => this.attributed(c, resolve)),
      total,
      next_cursor: cursor + limit < total ? cursor + limit : null,
    };
  }

  read(name: Operation, a: Input, p: Principal): unknown {
    if (name === "repositories_list") return this.repositories(this.w.projectScope(a));
    if (name === "repositories_match_projects") {
      const repository = this.repository(String(a.repository_id));
      return this.projects.resolve(repository.id, a.paths as string[], a.paths_complete as boolean);
    }
    if (name === "storage_get") {
      const row = this.w.one<{ at: string; value: string }>(
        "SELECT * FROM storage_observations WHERE id=1",
      );
      return row ? { at: row.at, ...JSON.parse(row.value) } : { at: null, pending: true };
    }
    if (name === "history_search") return this.search(a);
    if (name === "history_get_commit") {
      this.repository(String(a.repository_id));
      const id = `commit:${a.repository_id}:${a.commit_id}`,
        row = this.w.one<Record<string, unknown>>(
          "SELECT * FROM commits WHERE repository_id=? AND id=?",
          String(a.repository_id),
          String(a.commit_id),
        );
      if (!row && !this.w.one("SELECT 1 FROM commit_references WHERE id=?", id))
        throw new AppError("not_found", "Commit has not been observed or referenced", 404);
      return {
        ...(row
          ? this.attributed(row)
          : {
              id: a.commit_id,
              repository_id: a.repository_id,
              project_attribution: this.projects.resolve(String(a.repository_id), [], false),
            }),
        metadata_available: !!row,
        provenance: row ? (row.verified_upstream ? "upstream" : "legacy_local") : "reference_only",
        tasks: can(p, "tasks:read")
          ? this.w
              .all<{ task_id: string; title: string }>(
                "SELECT DISTINCT t.id task_id,t.title FROM relations r JOIN tasks t ON t.id=CASE WHEN r.source_id=? THEN r.target_id ELSE r.source_id END WHERE r.source_id=? OR r.target_id=?",
                id,
                id,
                id,
              )
              .filter((t) => this.w.access.task(t.task_id))
          : undefined,
      };
    }
    const timezone = String(a.timezone);
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      throw new AppError("invalid_timezone", "Use a valid IANA time zone");
    }
    const date = (value: string) => {
        const parts = formatter.formatToParts(new Date(value));
        return ["year", "month", "day"]
          .map((k) => parts.find((p) => p.type === k)!.value)
          .join("-");
      },
      today = date(this.w.now()),
      end = new Date(today + "T00:00:00Z"),
      days = Number(a.days),
      from = new Date(end.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10),
      all = this.current({
        ...a,
        after: new Date(Date.parse(from + "T00:00:00Z") - 86400000).toISOString(),
        before: new Date(end.getTime() + 2 * 86400000).toISOString(),
      }).filter((c) => date(c.committed_at) >= from && date(c.committed_at) <= today),
      daily = Array.from({ length: days }, (_, i) => ({
        date: new Date(end.getTime() - (days - 1 - i) * 86400000).toISOString().slice(0, 10),
        commits: 0,
        merges: 0,
      })),
      paths = new Map<string, { repository_id: string; path: string; changes: number }>();
    const resolve = this.projects.resolver();
    const projects = this.w.projectScope(a);
    for (const c of all) {
      const day = daily.find((d) => d.date === date(c.committed_at));
      if (day) {
        day.commits++;
        if (c.parents.length > 1) day.merges++;
      }
      for (const f of c.files) {
        if (
          projects &&
          !resolve(c.repository_id, [f.path]).project_ids.some((id) => projects.includes(id))
        )
          continue;
        const key = c.repository_id + "\0" + f.path,
          item = paths.get(key) ?? { repository_id: c.repository_id, path: f.path, changes: 0 };
        item.changes++;
        paths.set(key, item);
      }
    }
    const weekly = new Map<string, { week: string; commits: number; merges: number }>();
    for (const d of daily) {
      const t = new Date(d.date + "T00:00:00Z");
      t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
      const week = t.toISOString().slice(0, 10),
        w = weekly.get(week) ?? { week, commits: 0, merges: 0 };
      w.commits += d.commits;
      w.merges += d.merges;
      weekly.set(week, w);
    }
    return {
      timezone,
      from,
      through: today,
      total: all.length,
      merges: all.filter((c) => c.parents.length > 1).length,
      daily,
      weekly: [...weekly.values()],
      paths: [...paths.values()]
        .sort((a, b) => b.changes - a.changes || a.path.localeCompare(b.path))
        .slice(0, 100),
      commits_with_partial_files: all.filter((c) => !c.files_complete).length,
      repositories: this.repositories(projects).filter(
        (r) => !a.repository_id || r.id === a.repository_id,
      ),
      coverage_note:
        "Counts describe retained upstream metadata. Project views use current longest-prefix matches; shared commits can appear in more than one project. Unmatched or unobserved paths can leave project views incomplete, as can initial limits and oldest-commit GC.",
    };
  }
  write(name: Operation, a: Input): unknown {
    if (name === "repositories_create") {
      const project = this.w.project(String(a.project_id)),
        url = remoteUrl(String(a.upstream_url), this.w.options.allowLocalGit),
        same = this.findUpstream(url);
      if (same) {
        const existing = this.repository(same.id),
          aliases = this.aliases(
            (a.url_aliases as string[]) ?? [],
            existing.upstream_url!,
            same.id,
          );
        if (aliases.some((url) => !existing.url_aliases.includes(url)))
          throw new AppError(
            "repository_alias_conflict",
            "Use repository update to change URLs on an existing repository",
            409,
          );
        this.projects.attach(same.id, project.id, a.path_prefixes as string[] | undefined);
        return this.repository(same.id);
      }
      validateSelection(a.branches as string[], a.tag_regex as string | null);
      const aliases = this.aliases((a.url_aliases as string[]) ?? [], url);
      const id = uid("repo");
      this.w.run(
        "INSERT INTO repositories(id,project_id,name,created_at,upstream_url,branches,tag_regex,initial_fetch_limit,max_indexed_commits,cache_policy,sync_enabled,sync_requested,sync_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        project.id,
        String(a.name),
        this.w.now(),
        url,
        JSON.stringify(a.branches),
        a.tag_regex as string | null,
        Number(a.initial_fetch_limit),
        a.max_indexed_commits as number | null,
        String(a.cache_policy),
        Number(a.sync_enabled),
        Number(a.sync_enabled),
        a.sync_enabled ? "queued" : "paused",
      );
      this.w.run("UPDATE repositories SET url_aliases=? WHERE id=?", JSON.stringify(aliases), id);
      this.projects.attach(id, project.id, a.path_prefixes as string[] | undefined);
      return this.repository(id);
    }
    const r = this.repository(String(a.repository_id));
    if (name === "repositories_attach") {
      const project = this.w.project(String(a.project_id));
      if (a.remove && a.path_prefixes !== undefined)
        throw new AppError("invalid_input", "Do not set paths when removing a repository link");
      if (a.remove)
        this.w.run(
          "DELETE FROM project_repositories WHERE project_id=? AND repository_id=?",
          project.id,
          r.id,
        );
      else this.projects.attach(r.id, project.id, a.path_prefixes as string[] | undefined);
      return this.repository(r.id);
    }
    if (name === "repositories_set_paths") {
      const project = this.w.project(String(a.project_id));
      this.projects.setPaths(
        r.id,
        project.id,
        a.path_prefixes as string[],
        Number(a.expected_revision),
      );
      return this.repository(r.id);
    }
    if (name === "repositories_sync") {
      this.w.run(
        "UPDATE repositories SET sync_requested=1,sync_status=CASE WHEN sync_status='running' THEN sync_status ELSE 'queued' END WHERE id=?",
        r.id,
      );
      return this.repository(r.id);
    }
    if (name === "repositories_clear_cache") {
      this.w.run(
        "UPDATE repositories SET cleanup_requested=1,cache_cleanup='pending' WHERE id=?",
        r.id,
      );
      return this.repository(r.id);
    }
    if (name === "repositories_backfill") {
      const count = this.w.one<{ n: number }>(
        "SELECT COUNT(*) n FROM commits WHERE repository_id=?",
        r.id,
      )!.n;
      if (r.max_indexed_commits !== null && count >= r.max_indexed_commits)
        throw new AppError(
          "retention_full",
          "Raise the retention cap before requesting older history",
          409,
        );
      this.w.run(
        "UPDATE repositories SET backfill_count=?,sync_requested=1,sync_status=CASE WHEN sync_status='running' THEN sync_status ELSE 'queued' END WHERE id=?",
        Number(a.count),
        r.id,
      );
      return this.repository(r.id);
    }
    if (r.revision !== a.expected_revision)
      throw new AppError("revision_conflict", "Read the current repository revision", 409);
    a = {
      branches: r.branches,
      tag_regex: r.tag_regex,
      initial_fetch_limit: r.initial_fetch_limit,
      max_indexed_commits: r.max_indexed_commits,
      cache_policy: r.cache_policy,
      sync_enabled: !!r.sync_enabled,
      ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)),
    };
    const url = a.upstream_url
      ? remoteUrl(String(a.upstream_url), this.w.options.allowLocalGit)
      : r.upstream_url;
    if (r.upstream_url && url !== r.upstream_url)
      throw new AppError(
        "repository_identity",
        "Create a new repository to use a different upstream; existing commit references must retain their source",
        409,
      );
    const aliases = this.aliases((a.url_aliases as string[]) ?? r.url_aliases, url!, r.id);
    validateSelection(a.branches as string[], a.tag_regex as string | null);
    this.w.run("UPDATE repositories SET url_aliases=? WHERE id=?", JSON.stringify(aliases), r.id);
    this.w.run(
      "UPDATE repositories SET name=?,upstream_url=?,branches=?,tag_regex=?,initial_fetch_limit=?,max_indexed_commits=?,cache_policy=?,sync_enabled=?,revision=revision+1,sync_requested=?,sync_status=?,cache_cleanup=CASE WHEN cache_policy!=? THEN 'pending' ELSE cache_cleanup END,cleanup_requested=CASE WHEN cache_policy!=? THEN 1 ELSE cleanup_requested END WHERE id=?",
      String(a.name ?? r.name),
      url,
      JSON.stringify(a.branches),
      a.tag_regex as string | null,
      Number(a.initial_fetch_limit),
      a.max_indexed_commits as number | null,
      String(a.cache_policy),
      Number(a.sync_enabled),
      Number(a.sync_enabled),
      a.sync_enabled ? "queued" : "paused",
      String(a.cache_policy),
      String(a.cache_policy),
      r.id,
    );
    return this.repository(r.id);
  }
  beginSync(id: string) {
    const r = this.repository(id);
    this.w.run(
      "UPDATE repositories SET sync_status='running',sync_requested=0,last_attempt_at=?,sync_error=NULL WHERE id=?",
      this.w.now(),
      id,
    );
    this.w.onChange();
    return r;
  }
  completeSync(repo: Repository, result: GitCollection, next: string) {
    this.w.db
      .transaction(() => {
        const current = this.repository(repo.id);
        if (current.revision !== repo.revision)
          throw new AppError("configuration_changed", "Repository settings changed", 409);
        for (const c of result.commits) {
          this.w.run(
            "INSERT OR IGNORE INTO commit_references VALUES(?,?,?)",
            `commit:${repo.id}:${c.id}`,
            repo.id,
            c.id,
          );
          this.w.run(
            "INSERT INTO commits(repository_id,id,parents,message,authored_at,committed_at,files,verified_upstream,files_complete,files_observed,author,committer) VALUES(?,?,?,?,?,?,?,1,?,?,?,?) ON CONFLICT(repository_id,id) DO UPDATE SET parents=excluded.parents,message=excluded.message,authored_at=excluded.authored_at,committed_at=excluded.committed_at,files=excluded.files,verified_upstream=1,files_complete=excluded.files_complete,files_observed=excluded.files_observed,author=excluded.author,committer=excluded.committer",
            repo.id,
            c.id,
            JSON.stringify(c.parents),
            c.message,
            c.authored_at,
            c.committed_at,
            JSON.stringify(c.files),
            Number(c.files_complete),
            Number(c.files_observed),
            c.author ? JSON.stringify(c.author) : null,
            c.committer ? JSON.stringify(c.committer) : null,
          );
        }
        if (repo.max_indexed_commits !== null)
          this.w.run(
            "DELETE FROM commits WHERE repository_id=? AND id IN (SELECT id FROM commits WHERE repository_id=? ORDER BY committed_at DESC,id DESC LIMIT -1 OFFSET ?)",
            repo.id,
            repo.id,
            repo.max_indexed_commits,
          );
        this.w.run(
          "DELETE FROM commit_references WHERE repository_id=? AND NOT EXISTS(SELECT 1 FROM commits c WHERE c.repository_id=commit_references.repository_id AND c.id=commit_references.hash) AND NOT EXISTS(SELECT 1 FROM relations r WHERE r.source_id=commit_references.id OR r.target_id=commit_references.id) AND NOT EXISTS(SELECT 1 FROM entities e WHERE e.id=commit_references.id)",
          repo.id,
        );
        const hashes = this.w
            .all<{ id: string }>(
              "SELECT id FROM commits WHERE repository_id=? AND verified_upstream=1 ORDER BY committed_at DESC,id DESC",
              repo.id,
            )
            .map((c) => c.id),
          snapshot = uid("scan");
        this.w.run(
          "INSERT INTO scans VALUES(?,?,'upstream',?,?,?,?,0,?,NULL)",
          snapshot,
          repo.id,
          this.w.now(),
          this.w.now(),
          JSON.stringify(result.refs),
          JSON.stringify(hashes),
          Number(result.truncated),
        );
        this.w.run(
          "INSERT INTO sources VALUES(?,'upstream',?,?) ON CONFLICT(repository_id,source_id) DO UPDATE SET latest_scan=excluded.latest_scan,success_scan=excluded.success_scan",
          repo.id,
          snapshot,
          snapshot,
        );
        this.w.run(
          "DELETE FROM scans WHERE repository_id=? AND source_id='upstream' AND id NOT IN (SELECT latest_scan FROM sources WHERE repository_id=? UNION SELECT success_scan FROM sources WHERE repository_id=?)",
          repo.id,
          repo.id,
          repo.id,
        );
        this.w.run(
          "UPDATE repositories SET sync_status=CASE WHEN sync_requested=1 THEN 'queued' ELSE 'ready' END,sync_error=NULL,next_sync_at=?,last_sync_revision=?,actual_cache_mode=?,cache_cleanup='pending',collection_checkpoint=?,backfill_count=CASE WHEN backfill_count=? THEN 0 ELSE backfill_count END WHERE id=?",
          next,
          repo.revision,
          result.cacheMode,
          JSON.stringify(result.checkpoint),
          repo.backfill_count,
          repo.id,
        );
      })
      .immediate();
    this.w.onChange();
  }
  failSync(id: string, revision: number, message: string, next: string) {
    this.w.run(
      "UPDATE repositories SET sync_status='error',sync_error=?,next_sync_at=? WHERE id=? AND revision=?",
      message,
      next,
      id,
      revision,
    );
    this.w.onChange();
  }
}
