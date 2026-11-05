import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeGit } from "../server/native-git.ts";
import { openDatabase } from "../server/storage.ts";
import { UpstreamSync } from "../server/upstream-sync.ts";
import { Workspace } from "../server/workspace.ts";
import type { Principal, Project, Repository, Task } from "../shared/contracts.ts";

const owner: Principal = { id: "test-owner", kind: "owner", scopes: ["admin"], inlet: "browser" };
test("native upstream collection retains a bounded index and preserves linked commit identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "allgather-git-")),
    repo = join(root, "upstream");
  await mkdir(repo);
  const db = openDatabase(":memory:"),
    w = new Workspace(db, undefined, undefined, { dataDir: root, allowLocalGit: true });
  let serial = 0;
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["git", "-C", repo, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
        GIT_AUTHOR_DATE: `2026-01-01T00:00:${String(serial).padStart(2, "0")}Z`,
        GIT_COMMITTER_DATE: `2026-01-01T00:00:${String(serial).padStart(2, "0")}Z`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code) throw new Error(err);
    return out.trim();
  };
  const commit = async () => {
    serial++;
    await writeFile(join(repo, "work.txt"), String(serial));
    await run("add", ".");
    await run("commit", "-m", `Delivery ${serial}`);
    return run("rev-parse", "HEAD");
  };
  const git = new NativeGit(join(root, "cache"), true),
    sync = new UpstreamSync(w, git, 0);
  try {
    await run("init", "-b", "main");
    await run("config", "uploadpack.allowFilter", "true");
    await commit();
    await commit();
    const linked = await commit();
    await commit();
    const project = w.execute(
      "projects_create",
      { name: "Example", operation_key: "project" },
      owner,
    ) as Project;
    const upstream = w.execute(
      "repositories_create",
      {
        project_id: project.id,
        name: "Example",
        upstream_url: repo,
        url_aliases: ["ssh://git@example.invalid/team/project.git"],
        initial_fetch_limit: 2,
        max_indexed_commits: 3,
        operation_key: "repo",
      },
      owner,
    ) as Repository;
    await sync.runOnce();
    expect(w.history.repository(upstream.id).sync_error).toBeNull();
    expect(w.history.repositories()[0].indexed_count).toBe(2);
    expect(w.history.repository(upstream.id).actual_cache_mode).toBe("filtered");
    const task = w.execute(
      "tasks_create",
      { project_id: project.id, title: "Evidence", operation_key: "task" },
      owner,
    ) as Task;
    w.execute(
      "tasks_link_commit",
      {
        task_id: task.id,
        repository_id: upstream.id,
        commit_id: linked,
        expected_revision: 1,
        operation_key: "link",
      },
      owner,
    );
    for (let n = 0; n < 2; n++) {
      await commit();
      w.execute(
        "repositories_sync",
        { repository_id: upstream.id, operation_key: `sync-${n}` },
        owner,
      );
      await sync.runOnce();
      expect(w.history.repository(upstream.id).sync_error).toBeNull();
    }
    expect(w.history.repositories()[0].indexed_count).toBe(3);
    const evicted = w.execute(
      "history_get_commit",
      { repository_id: upstream.id, commit_id: linked },
      owner,
    ) as { metadata_available: boolean };
    expect(evicted.metadata_available).toBe(false);
    expect(w.task(task.id).status).toBe("open");
    const results = w.execute("history_search", { query: "Delivery 6" }, owner) as {
      total: number;
    };
    expect(results.total).toBe(1);
    expect(() =>
      w.execute(
        "repositories_backfill",
        { repository_id: upstream.id, count: 3, operation_key: "backfill" },
        owner,
      ),
    ).toThrow("Raise the retention cap");
    const project2 = w.execute(
      "projects_create",
      { name: "Second", operation_key: "project2" },
      owner,
    ) as Project;
    const shared = w.execute(
      "repositories_create",
      {
        project_id: project2.id,
        name: "Shared",
        upstream_url: "ssh://git@example.invalid/team/project.git",
        operation_key: "shared",
      },
      owner,
    ) as Repository;
    expect(shared.id).toBe(upstream.id);
    expect(shared.project_ids).toHaveLength(2);
    expect(w.history.repositories()).toHaveLength(1);
    const paused = w.execute(
      "repositories_update",
      {
        repository_id: upstream.id,
        expected_revision: shared.revision,
        sync_enabled: false,
        operation_key: "pause-without-reset",
      },
      owner,
    ) as Repository;
    expect(paused).toMatchObject({
      initial_fetch_limit: 2,
      max_indexed_commits: 3,
      branches: ["main"],
      url_aliases: ["ssh://git@example.invalid/team/project.git"],
    });
    expect(() =>
      w.execute(
        "repositories_create",
        {
          project_id: project.id,
          name: "Conflicting alias",
          upstream_url: "https://example.invalid/another.git",
          url_aliases: ["ssh://git@example.invalid/team/project.git"],
          operation_key: "alias-conflict",
        },
        owner,
      ),
    ).toThrow("another repository");

    expect(w.execute("storage_get", {}, owner)).toHaveProperty("cache_bytes_by_repo");
  } finally {
    await sync.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
