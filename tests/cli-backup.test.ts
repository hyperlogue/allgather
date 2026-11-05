import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureApiToken, fixtureLogin } from "../scripts/fixture-auth.ts";
import { startServer } from "../server/index.ts";
import type {
  EpicProgress,
  Page,
  Project,
  ProjectAttribution,
  Repository,
  Task,
  TaskComment,
} from "../shared/contracts.ts";

test("CLI mutations, upstream configuration, and backup restore preserve work", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-cli-"));
  const running = await startServer({
    dataDir: join(root, "state"),
    port: 0,
    publicUrl: "http://127.0.0.1:0",
  });
  const env = {
    ...process.env,
    ALLGATHER_URL: running.settings.publicUrl,
    ALLGATHER_TOKEN: await fixtureApiToken(
      running.settings.publicUrl,
      await fixtureLogin(join(root, "state"), running.settings.publicUrl),
    ),
    ALLGATHER_CONFIG_DIR: join(root, "config"),
  };
  const invoke = async <T>(...args: string[]): Promise<T> => {
    const administration = ["backup", "restore"].includes(args[0]);
    if (args[0] === "backup") args.push("--data-dir", join(root, "state"));
    const entry = administration ? "server/cli.ts" : "cli/index.ts";
    const p = Bun.spawn([process.execPath, "--no-env-file", entry, ...args, "--json"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(err);
    return JSON.parse(out) as T;
  };
  try {
    const project = await invoke<Project>("project", "create", "--name", "CLI example");
    const task = await invoke<Task>(
      "task",
      "create",
      "--project",
      project.id,
      "--title",
      "CLI work",
      "--body",
      "Working change",
    );
    const claimed = await invoke<Task>("task", "start", task.id, "--session", "agent-example");
    expect(claimed.status).toBe("open");
    const finished = await invoke<Task>("task", "finish", task.id, "--session", "agent-example");
    expect(finished.status).toBe("done");
    const input = join(root, "repo-input.json");
    writeFileSync(
      input,
      JSON.stringify({
        project_id: project.id,
        name: "Upstream repository",
        upstream_url: "https://github.com/example/project",
        sync_enabled: false,
      }),
    );
    const repo = await invoke<Repository>("api", "repositories_create", "--input", input);
    const repositories = await invoke<Repository[]>("repo", "list");
    expect(repositories[0].upstream_url).toBe("https://github.com/example/project");
    expect(repositories[0].sync_enabled).toBe(0);
    expect(repo.upstream_url).toBe("https://github.com/example/project");
    const aliased = await invoke<Repository>(
      "repo",
      "update",
      repo.id,
      "--alias",
      "ssh://git@example.invalid/example/project.git",
      "--alias",
      "https://mirror.example.invalid/project",
    );
    expect(aliased.url_aliases).toHaveLength(2);
    expect(aliased.sync_enabled).toBe(0);
    expect(
      (await invoke<Repository>("repo", "update", repo.id, "--clear-aliases")).url_aliases,
    ).toEqual([]);
    const web = await invoke<Project>("project", "create", "--name", "Web");
    await invoke("repo", "attach", repo.id, "--project", web.id, "--path-prefix", "apps/web/");
    const withPaths = await invoke<Repository>(
      "repo",
      "paths",
      repo.id,
      "--project",
      project.name,
      "--path-prefix",
      "apps",
      "--path-prefix",
      "packages",
    );
    expect(
      withPaths.project_links.find((link) => link.project_id === project.id)?.path_prefixes,
    ).toEqual(["apps", "packages"]);
    const matched = await invoke<ProjectAttribution>(
      "repo",
      "match",
      repo.id,
      "--path",
      "apps/web/main.ts",
      "--path",
      "packages/ui.ts",
    );
    expect(matched.project_ids).toEqual([project.id, web.id].sort());
    expect(matched.project_id).toBeNull();
    const cleared = await invoke<Repository>(
      "repo",
      "paths",
      repo.id,
      "--project",
      web.id,
      "--clear-path-prefixes",
    );
    expect(cleared.project_links.find((link) => link.project_id === web.id)?.path_prefixes).toEqual(
      [],
    );
    expect(
      (await invoke<ProjectAttribution>("repo", "match", repo.id, "--path", "apps/web/main.ts"))
        .project_id,
    ).toBe(project.id);

    const deferred = await invoke<Task>(
      "task",
      "update",
      task.id,
      "--label",
      "Backend",
      "--label",
      "Review",
      "--body",
      "Retry keeps the same result",
      "--defer",
      "2099-01-01T00:00:00Z",
    );
    expect(deferred.labels).toEqual(["backend", "review"]);
    expect(deferred.body).toBe("Retry keeps the same result");
    const comment = await invoke<TaskComment>(
      "task",
      "comment",
      task.id,
      "--body",
      "Closed task note",
      "--operator-name",
      "Reviewer",
    );
    expect(comment.operator_name).toBe("Reviewer");
    const found = await invoke<Page<Task>>(
      "task",
      "search",
      "--labels-all",
      "backend",
      "--labels-all",
      "review",
      "--status",
      "done",
    );
    expect(found.items.map((t) => t.id)).toEqual([task.id]);
    await invoke(
      "task",
      "update",
      task.id,
      "--remove-label",
      "review",
      "--add-label",
      "Tested",
      "--undefer",
    );
    const planFile = join(root, "plan.json");
    writeFileSync(
      planFile,
      JSON.stringify({
        tasks: [
          { key: "release", title: "Release" },
          {
            key: "work",
            title: "Work",
            parent_key: "release",
            body: "Work complete",
            labels: ["backend"],
          },
        ],
      }),
    );
    const plan = await invoke<{ mapping: Record<string, string> }>(
      "task",
      "plan",
      "create",
      "--project",
      project.id,
      "--file",
      planFile,
    );
    const scheduled = await invoke<Task>(
      "task",
      "update",
      plan.mapping.work,
      "--defer",
      "2099-01-01T00:00:00Z",
    );
    expect(scheduled.defer_until).toBe("2099-01-01T00:00:00.000Z");
    expect(
      (await invoke<Page<Task>>("task", "ready", "--project", project.id, "--unassigned")).total,
    ).toBe(2);
    await invoke("task", "update", plan.mapping.work, "--assignee", "owner");
    expect(
      (await invoke<Page<Task>>("task", "ready", "--project", project.id, "--unassigned")).total,
    ).toBe(1);
    expect(
      (await invoke<Page<Task>>("task", "ready", "--project", project.id, "--assignee=owner"))
        .items[0]?.id,
    ).toBe(plan.mapping.work);
    await expect(invoke("task", "next")).rejects.toThrow("Unknown operation");
    expect((await invoke<unknown[]>("task", "labels")).length).toBeGreaterThan(0);
    expect((await invoke<Page<unknown>>("session", "list")).total).toBeGreaterThan(0);
    const declared = await invoke<{ id: string; label: string; agent_type: string }>(
      "session",
      "declare",
      "cli-history",
      "--harness",
      "fixture",
      "--label",
      "Imported session",
    );
    expect(declared).toMatchObject({
      id: "cli-history",
      label: "Imported session",
      agent_type: "fixture",
    });
    const transcript = join(root, "transcript.json");
    writeFileSync(
      transcript,
      JSON.stringify({
        source_key: "cli-import",
        events: [{ key: "note", kind: "text", payload: { text: "Retained session context" } }],
      }),
    );
    await invoke("session", "transcript", "import", declared.id, "--input", transcript);
    expect((await invoke<unknown[]>("session", "transcript", "sources", declared.id)).length).toBe(
      1,
    );
    const events = await invoke<{ items: { payload: { text: string } }[] }>(
      "session",
      "transcript",
      "events",
      declared.id,
    );
    expect(events.items[0].payload.text).toBe("Retained session context");
    const link = await invoke<{ id: string }>(
      "link",
      "add",
      "--type",
      "relates_to",
      "--source-id",
      task.id,
      "--target-id",
      declared.id,
    );
    expect(
      (await invoke<{ neighbors: { id: string }[] }>("link", "context", task.id)).neighbors.some(
        (n) => n.id === declared.id,
      ),
    ).toBe(true);
    await invoke("link", "remove", link.id, "--reason", "CLI route checked");
    expect(
      (await invoke<Page<unknown>>("audit", "list", "--task-id", task.id)).total,
    ).toBeGreaterThan(0);
    const progress = await invoke<EpicProgress[]>("task", "progress", plan.mapping.release);
    expect(progress[0]).toMatchObject({ total: 1, done: 0, open: 1 });
    await invoke("task", "update", plan.mapping.work, "--undefer");
    expect(
      (
        await invoke<Page<Task>>("task", "ready", "--project", project.id, "--assignee", "owner")
      ).items.map((t) => t.id),
    ).toContain(plan.mapping.work);
    const artifact = await invoke<{ id: string }>(
      "artifact",
      "create",
      "--kind",
      "html",
      "--title",
      "Saved plan",
      "--project",
      project.id,
    );
    const capture = join(root, "capture");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(capture);
    writeFileSync(join(capture, "index.html"), "<h1>Retained plan</h1>");
    await invoke("artifact", "publish", artifact.id, "--root", capture, "--no-listen");
    await invoke(
      "artifact",
      "thread-add",
      artifact.id,
      "--body",
      "Make the title clear",
      "--operator-kind",
      "user",
    );
    const comments = await invoke<{ text: string; itemCount: number }>(
      "artifact",
      "comments",
      artifact.id,
    );
    expect(comments.itemCount).toBe(1);
    expect(comments.text).toContain("Make the title clear");
    expect(
      (await invoke<{ itemCount: number }>("artifact", "comments", artifact.id)).itemCount,
    ).toBe(0);
    const sessionsByProject = await invoke<Page<unknown>>(
      "session",
      "search",
      "--project",
      project.id,
      "--since",
      "2000-01-01T00:00:00Z",
    );
    expect(sessionsByProject.total).toBeGreaterThan(0);
    const backup = join(root, "backup.zip");
    await invoke("backup", backup);
    const savedBackup = readFileSync(backup);
    await expect(invoke("backup", backup)).rejects.toThrow();
    expect(readFileSync(backup)).toEqual(savedBackup);
    const downloaded = await fetch(`${running.settings.publicUrl}/api/backup`, {
      headers: { authorization: `Bearer ${env.ALLGATHER_TOKEN}` },
    });
    expect(downloaded.headers.get("content-type")).toBe("application/zip");
    expect(downloaded.headers.get("content-disposition")).toContain("allgather-backup.zip");
    expect(new Uint8Array(await downloaded.arrayBuffer()).subarray(0, 4)).toEqual(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    );
    const restored = join(root, "restored");
    await invoke("restore", backup, "--data-dir", restored);
    const recovered = await startServer({
      dataDir: restored,
      port: 0,
      publicUrl: "http://127.0.0.1:0",
    });
    try {
      expect(
        (
          await recovered.workspace.artifacts!.store.readFile(artifact.id, 1, "index.html")
        ).toString(),
      ).toBe("<h1>Retained plan</h1>");
      expect(recovered.workspace.task(task.id).status).toBe("done");
      expect(recovered.workspace.project(project.id).name).toBe("CLI example");
      expect(recovered.workspace.history.repository(repo.id).project_links).toEqual(
        cleared.project_links,
      );
      expect(existsSync(join(restored, "owner-key"))).toBe(false);
      expect(
        (
          await fetch(recovered.settings.publicUrl + "/api/operations/projects_list", {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.ALLGATHER_TOKEN}`,
              "content-type": "application/json",
            },
            body: "{}",
          })
        ).status,
      ).toBe(401);
    } finally {
      await recovered.stop();
    }
    const hash = running.workspace.one<{ hash: string }>("SELECT hash FROM blobs LIMIT 1")!.hash;
    writeFileSync(join(root, "state", "blobs", hash.slice(0, 2), hash.slice(2)), "corrupted");
    const failedBackup = join(root, "failed.zip");
    await expect(invoke("backup", failedBackup)).rejects.toThrow();
    expect(existsSync(failedBackup)).toBe(false);
  } finally {
    await running.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
