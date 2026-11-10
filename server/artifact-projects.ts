import type { Database } from "bun:sqlite";
import { ArtifactError, optionalText } from "../shared/artifact-validation.ts";
import type { ArtifactProject } from "../shared/artifacts.ts";
import { normalizeGitRemote } from "../shared/git-remote.ts";

// Allgather owns projects and repository membership. Artifacts only select an
// existing project, explicitly or from an unambiguous upstream URL.
export class ArtifactProjects {
  constructor(private db: Database) {}

  list(): ArtifactProject[] {
    return this.db
      .query<ArtifactProject, []>(
        "SELECT id,name,NULL AS remoteUrl,created_at AS createdAt FROM projects ORDER BY name,id",
      )
      .all();
  }

  resolve(body: Record<string, unknown>): string | null {
    if ("projectId" in body) {
      const id = optionalText(body.projectId, "projectId", 160);
      if (id !== null && !this.db.query("SELECT 1 FROM projects WHERE id=?").get(id))
        throw new ArtifactError("Project not found", 404);
      return id;
    }
    const remote = normalizeGitRemote(body.remoteUrl);
    if (!remote) return null;
    const rows = this.db
      .query<{ project_id: string; upstream_url: string; url_aliases: string }, []>(
        "SELECT p.project_id,r.upstream_url,r.url_aliases FROM project_repositories p JOIN repositories r ON r.id=p.repository_id WHERE r.upstream_url IS NOT NULL",
      )
      .all();
    const projects = [
      ...new Set(
        rows
          .filter((row) =>
            [row.upstream_url, ...JSON.parse(row.url_aliases)].some(
              (url) => normalizeGitRemote(url)?.key === remote.key,
            ),
          )
          .map((row) => row.project_id),
      ),
    ];
    return projects.length === 1 ? projects[0] : null;
  }
}
