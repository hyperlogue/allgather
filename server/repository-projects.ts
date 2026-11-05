import type { Database } from "bun:sqlite";
import { AppError, type ProjectAttribution, type RepositoryProject } from "../shared/contracts.ts";

const pathMatch = (path: string, prefix: string) =>
  `(${prefix}='.' OR ${path}=${prefix} OR instr(${path},${prefix}||'/')=1)`;
const specificity = (prefix: string) => `CASE ${prefix} WHEN '.' THEN 0 ELSE length(${prefix}) END`;
// SQL filtering mirrors resolver() so counts and pagination stay inside SQLite.
// Behavior checks exercise both paths against the same attribution cases.
const winningPath = (path: string) => `EXISTS (
  SELECT 1 FROM json_each(p.path_prefixes) prefix
  WHERE ${pathMatch(path, "prefix.value")} AND NOT EXISTS (
    SELECT 1 FROM project_repositories other, json_each(other.path_prefixes) longer
    WHERE other.repository_id=p.repository_id
      AND ${specificity("longer.value")}>${specificity("prefix.value")}
      AND ${pathMatch(path, "longer.value")}
  )
)`;

export class RepositoryProjects {
  constructor(private db: Database) {}

  list(repository: string): RepositoryProject[] {
    return this.db
      .query<{ project_id: string; path_prefixes: string; revision: number }, [string]>(
        "SELECT project_id,path_prefixes,revision FROM project_repositories WHERE repository_id=? ORDER BY project_id",
      )
      .all(repository)
      .map((row) => ({ ...row, path_prefixes: JSON.parse(row.path_prefixes) }));
  }

  attach(repository: string, project: string, prefixes?: string[]) {
    const current = this.list(repository).find((link) => link.project_id === project);
    if (current) {
      if (
        prefixes !== undefined &&
        JSON.stringify(prefixes) !== JSON.stringify(current.path_prefixes)
      )
        throw new AppError(
          "revision_required",
          "Use repository project-path settings to change an existing link",
          409,
        );
      return;
    }
    this.db
      .query(
        "INSERT INTO project_repositories(project_id,repository_id,path_prefixes) VALUES(?,?,?)",
      )
      .run(project, repository, JSON.stringify(prefixes ?? []));
  }

  setPaths(repository: string, project: string, prefixes: string[], revision: number) {
    const current = this.list(repository).find((link) => link.project_id === project);
    if (!current) throw new AppError("not_found", "Project is not linked to this repository", 404);
    if (current.revision !== revision)
      throw new AppError(
        "revision_conflict",
        "Read the current project–repository link revision",
        409,
      );
    this.db
      .query(
        "UPDATE project_repositories SET path_prefixes=?,revision=revision+1 WHERE repository_id=? AND project_id=?",
      )
      .run(JSON.stringify(prefixes), repository, project);
  }

  // Embed in a commit query with alias c and bind the requested project once.
  static commitFilter = `EXISTS (
    SELECT 1 FROM project_repositories p WHERE p.repository_id=c.repository_id AND p.project_id=?
    AND ((SELECT count(*) FROM project_repositories all_links WHERE all_links.repository_id=p.repository_id)=1
      OR EXISTS (SELECT 1 FROM json_each(c.files) file WHERE ${winningPath("json_extract(file.value,'$.path')")}))
  )`;

  // One membership snapshot per read: summary queries must not fetch links per commit.
  resolver() {
    const repositories = new Map<string, RepositoryProject[]>();
    for (const row of this.db
      .query<
        { repository_id: string; project_id: string; path_prefixes: string; revision: number },
        []
      >(
        "SELECT repository_id,project_id,path_prefixes,revision FROM project_repositories ORDER BY repository_id,project_id",
      )
      .all()) {
      const links = repositories.get(row.repository_id) ?? [];
      links.push({
        project_id: row.project_id,
        path_prefixes: JSON.parse(row.path_prefixes),
        revision: row.revision,
      });
      repositories.set(row.repository_id, links);
    }
    return (repository: string, paths: string[], pathsComplete = true): ProjectAttribution => {
      const links = repositories.get(repository) ?? [];
      if (links.length === 1)
        return {
          project_ids: [links[0].project_id],
          project_id: links[0].project_id,
          basis: "single_project",
          unmatched_paths: [],
          ambiguous_paths: [],
          paths_complete: pathsComplete,
        };
      const projects = new Set<string>(),
        unmatched: string[] = [],
        ambiguous: string[] = [];
      for (const path of new Set(paths)) {
        let best = -1;
        const winners = new Set<string>();
        for (const link of links)
          for (const prefix of link.path_prefixes) {
            if (prefix !== "." && path !== prefix && !path.startsWith(`${prefix}/`)) continue;
            const length = prefix === "." ? 0 : prefix.length;
            if (length > best) {
              winners.clear();
              best = length;
            }
            if (length === best) winners.add(link.project_id);
          }
        if (!winners.size) unmatched.push(path);
        if (winners.size > 1) ambiguous.push(path);
        for (const project of winners) projects.add(project);
      }
      const projectIds = [...projects].sort();
      return {
        project_ids: projectIds,
        project_id:
          pathsComplete && projectIds.length === 1 && !unmatched.length && !ambiguous.length
            ? projectIds[0]
            : null,
        basis: projectIds.length ? "path_prefix" : "unassigned",
        unmatched_paths: unmatched,
        ambiguous_paths: ambiguous,
        paths_complete: pathsComplete,
      };
    };
  }

  resolve(repository: string, paths: string[], pathsComplete = true): ProjectAttribution {
    return this.resolver()(repository, paths, pathsComplete);
  }
}
