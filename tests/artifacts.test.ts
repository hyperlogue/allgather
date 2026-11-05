import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Artifact,
  ArtifactComment,
  ArtifactThread,
  ArtifactVersion,
} from "../server/r3/shared/artifacts.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import type { Operation, Principal, Project, Task } from "../shared/contracts.ts";

const owner: Principal = { id: "owner", kind: "owner", inlet: "browser", scopes: ["admin"] },
  agent: Principal = {
    id: "agent-connection",
    kind: "client",
    inlet: "mcp",
    scopes: ["artifacts:read", "artifacts:write"],
  };
test("multiple agents publish shared artifacts and reply across human and agent threads", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-artifact-agents-")),
    db = openDatabase(":memory:");
  const w = new Workspace(db, undefined, undefined, { dataDir: root });
  const first: Principal = { ...agent, id: "first-agent" },
    second: Principal = { ...agent, id: "second-agent" };
  const call = <T>(name: Operation, input: Record<string, unknown>, principal = owner) =>
    w.dispatch(name, { operation_key: randomUUID(), ...input }, principal) as Promise<T>;
  const content = (body: string) => ({
    kind: "html",
    files: [
      { path: "index.html", mediaType: "text/html", base64: Buffer.from(body).toString("base64") },
    ],
  });
  try {
    const artifact = await call<Artifact>(
      "artifacts_create",
      { kind: "html", title: "Shared review", session_id: "first-run" },
      first,
    );
    const version = await call<ArtifactVersion>(
      "artifacts_publish",
      {
        artifact_id: artifact.id,
        expected_seq: 0,
        content: content("<h1>First draft</h1>"),
        session_id: "first-run",
        listen: false,
      },
      first,
    );
    expect(version.publishedBy).toMatchObject({ role: "agent", sessionId: "first-run" });
    await expect(
      call(
        "artifacts_publish",
        {
          artifact_id: artifact.id,
          expected_seq: 0,
          content: content("<h1>Stale draft</h1>"),
          session_id: "second-run",
          listen: false,
        },
        second,
      ),
    ).rejects.toThrow("Publication conflict");
    const updated = await call<ArtifactVersion>(
      "artifacts_publish",
      {
        artifact_id: artifact.id,
        expected_seq: 1,
        content: content("<h1>Shared draft</h1>"),
        session_id: "second-run",
        listen: false,
      },
      second,
    );
    expect(updated).toMatchObject({
      seq: 2,
      publishedBy: { role: "agent", sessionId: "second-run" },
    });
    const humanThread = await call<ArtifactThread>("artifact_threads_add", {
      artifact_id: artifact.id,
      input: { body: "Please review", target: { kind: "artifact" } },
    });
    await call(
      "artifact_threads_claim",
      { thread_ids: [humanThread.id], session_id: "first-run" },
      first,
    );
    const secondReply = await call<ArtifactComment>(
      "artifact_comments_add",
      {
        thread_id: humanThread.id,
        session_id: "second-run",
        input: { body: "Second agent can join this discussion" },
      },
      second,
    );
    expect(w.artifacts!.conversations.get(humanThread.id).claim?.sessionId).toBe("first-run");
    const firstReply = await call<ArtifactComment>(
      "artifact_comments_add",
      {
        thread_id: humanThread.id,
        session_id: "first-run",
        input: { body: "Reply to the other agent" },
      },
      first,
    );
    expect(firstReply.author).toMatchObject({ role: "agent", sessionId: "first-run" });
    expect(secondReply.author).toMatchObject({ role: "agent", sessionId: "second-run" });
    for (const [principal, session] of [
      [first, "first-run"],
      [second, "second-run"],
    ] as const) {
      const thread = await call<ArtifactThread>(
        "artifact_threads_add",
        {
          artifact_id: artifact.id,
          session_id: session,
          input: { body: `${session} starts a thread`, target: { kind: "artifact" } },
        },
        principal,
      );
      const other = session === "first-run" ? second : first;
      const reply = await call<ArtifactComment>(
        "artifact_comments_add",
        {
          thread_id: thread.id,
          session_id: session === "first-run" ? "second-run" : "first-run",
          input: { body: "Reply to an agent thread" },
        },
        other,
      );
      expect(reply.author).not.toEqual(thread.comments[0].author);
    }
    await expect(
      call(
        "artifact_comments_edit",
        {
          comment_id: firstReply.id,
          session_id: "second-run",
          input: { body: "Overwrite another agent" },
        },
        second,
      ),
    ).rejects.toThrow("only their own");
    const ownEdit = await call<ArtifactComment>(
      "artifact_comments_edit",
      { comment_id: firstReply.id, session_id: "first-run", input: { body: "Clarified my reply" } },
      first,
    );
    expect(ownEdit.body).toBe("Clarified my reply");
    expect(w.artifacts!.conversations.get(humanThread.id).comments).toHaveLength(3);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("r3 publication, native review targets, claims, guarded fixes, archive history, and shared blob GC", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-artifact-")),
    db = openDatabase(":memory:");
  let now = new Date("2026-01-01T00:00:00Z");
  const w = new Workspace(db, () => now, undefined, { dataDir: root });
  const call = async <T>(name: Operation, input: Record<string, unknown> = {}, principal = owner) =>
    (await w.dispatch(name, { operation_key: randomUUID(), ...input }, principal)) as T;
  try {
    const project = await call<Project>("projects_create", { name: "Example" }),
      task = await call<Task>("tasks_create", { project_id: project.id, title: "Design" }),
      artifact = await call<Artifact>("artifacts_create", {
        kind: "html",
        title: "Plan",
        project_id: project.id,
        task_id: task.id,
      });
    const html = '<h1 id="title">First draft</h1>',
      file = (data: string) => ({
        path: "index.html",
        mediaType: "text/html",
        base64: Buffer.from(data).toString("base64"),
      }),
      input = {
        artifact_id: artifact.id,
        expected_seq: 0,
        content: { kind: "html", files: [file(html)] },
        task_id: task.id,
        operation_key: "publication-1",
      };
    const version = await call<ArtifactVersion>("artifacts_publish", input);
    expect(version.seq).toBe(1);
    expect(await call<ArtifactVersion>("artifacts_publish", input)).toEqual(version);
    expect(w.task(task.id).status).toBe("open");
    expect(w.graph.relations(task.id).some((r) => r.target_id === `${artifact.id}@1`)).toBe(true);
    const thread = await call<ArtifactThread>("artifact_threads_add", {
      artifact_id: artifact.id,
      input: {
        body: "Make the heading clear",
        target: {
          kind: "rendered",
          versionSeq: 1,
          path: "index.html",
          locator: { selector: "#title", quote: "First draft" },
        },
      },
    });
    await call(
      "artifact_threads_claim",
      { thread_ids: [thread.id], session_id: "review-run" },
      agent,
    );
    expect(w.artifacts!.store.get(artifact.id).working).toBe(true);
    await expect(
      call("artifact_threads_claim", { thread_ids: [thread.id], session_id: "other-run" }, agent),
    ).rejects.toThrow("another agent");
    const second = await call<ArtifactVersion>("artifacts_publish", {
      artifact_id: artifact.id,
      expected_seq: 1,
      content: { kind: "html", files: [file('<h1 id="title">Clear plan</h1>')] },
    });
    expect(second.seq).toBe(2);
    await call(
      "artifact_comments_add",
      {
        thread_id: thread.id,
        session_id: "review-run",
        input: {
          body: "Updated",
          target: {
            kind: "rendered",
            versionSeq: 2,
            path: "index.html",
            locator: { selector: "#title", label: "Heading" },
          },
          reanchor: { expectedSeq: 2, expectedAnchorRevision: 0 },
        },
      },
      agent,
    );
    const updated = w.artifacts!.conversations.get(thread.id);
    expect(updated.anchor?.target).toMatchObject({ versionSeq: 2 });
    expect(updated.target).toMatchObject({ versionSeq: 1 });
    expect(updated.claim).toBeNull();
    await expect(
      call(
        "artifact_threads_edit",
        {
          thread_id: thread.id,
          session_id: "review-run",
          operator_kind: "user",
          input: { status: "resolved" },
        },
        agent,
      ),
    ).rejects.toThrow("owner");
    const snapshot = w.artifacts!.conversations.snapshot(artifact.id);
    await call("artifact_threads_edit", {
      thread_id: thread.id,
      input: { body: "One more detail" },
    });
    await expect(
      call("artifact_comments_ack", { artifact_id: artifact.id, receipt: snapshot.acknowledgment }),
    ).rejects.toThrow("changed");
    await call("artifact_threads_edit", { thread_id: thread.id, input: { status: "resolved" } });
    const archived = await call<{ event: { comment: { id: string } } }>("artifacts_archive", {
      artifact_id: artifact.id,
      comment: "Approved design",
    });
    expect(w.artifacts!.store.get(artifact.id).state).toBe("archived");
    await expect(
      call(
        "artifact_comments_add",
        { thread_id: thread.id, session_id: "review-run", input: { body: "Too late" } },
        agent,
      ),
    ).rejects.toThrow("archived");
    await call("artifacts_restore", { artifact_id: artifact.id });
    await call("artifact_comments_edit", {
      comment_id: archived.event.comment.id,
      input: { body: "Approved with the recorded correction" },
    });
    expect(w.artifacts!.lifecycle.events(artifact.id)).toHaveLength(2);
    await call("sessions_declare", { target_session_id: "archive-session" });
    const asset = await call<{ blob_hash: string }>("session_assets_add", {
      target_session_id: "archive-session",
      media_type: "text/html",
      data: Buffer.from(html).toString("base64"),
      name: "snapshot.html",
    });
    await call("artifacts_archive", { artifact_id: artifact.id });
    now = new Date("2026-03-01T00:00:00Z");
    const gc = await call<{ deletedIds: string[] }>("artifacts_gc", { input: { ttlDays: 30 } });
    expect(gc.deletedIds).toEqual([artifact.id]);
    expect((await w.blobs!.read(asset.blob_hash)).toString()).toBe(html);
    expect(w.graph.relations(task.id)).toHaveLength(0);
    const usage = w.artifacts!.usage.stat();
    expect(usage.artifacts.total).toBe(0);
    expect(w.all("SELECT * FROM artifact_activity").length).toBeGreaterThan(0);
    expect(
      w.one<{ n: number }>(
        "SELECT COUNT(*) n FROM audit_operations WHERE operation='artifacts_publish'",
      )!.n,
    ).toBe(2);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("parallel artifact preparation keeps each audit/receipt atomic and rolls back failed evidence links", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-artifact-commit-")),
    db = openDatabase(":memory:"),
    w = new Workspace(db, undefined, undefined, { dataDir: root });
  const call = <T>(name: Operation, input: Record<string, unknown>, principal = owner) =>
    w.dispatch(name, { operation_key: randomUUID(), ...input }, principal) as Promise<T>;
  const content = (text: string) => ({
    kind: "html",
    files: [
      { path: "index.html", mediaType: "text/html", base64: Buffer.from(text).toString("base64") },
    ],
  });
  try {
    const a = await call<Artifact>("artifacts_create", { kind: "html", title: "A" }),
      b = await call<Artifact>("artifacts_create", { kind: "html", title: "B" });
    const inputs = [a, b].map((artifact, i) => ({
      artifact_id: artifact.id,
      expected_seq: 0,
      content: content(`<h1>${i}</h1>`),
      session_id: `publisher-${i}`,
      operation_key: `parallel-${i}`,
    }));
    const results = await Promise.all(
      inputs.map((input) => call<ArtifactVersion>("artifacts_publish", input, agent)),
    );
    expect(results.map((r) => r.seq)).toEqual([1, 1]);
    for (let i = 0; i < inputs.length; i++) {
      expect(await call<ArtifactVersion>("artifacts_publish", inputs[i], agent)).toEqual(
        results[i],
      );
      const audit = w.one<{ id: string; session_id: string }>(
        "SELECT id,session_id FROM audit_operations WHERE operation_key=?",
        `parallel-${i}`,
      )!;
      expect(audit.session_id).toBe(`publisher-${i}`);
      const changes = w.all<{ entity_id: string }>(
        "SELECT entity_id FROM audit_changes WHERE operation_id=? AND entity_type='artifact_versions'",
        audit.id,
      );
      expect([...new Set(changes.map((c) => c.entity_id))]).toEqual([`${inputs[i].artifact_id}@1`]);
    }
    const failed = {
      artifact_id: a.id,
      expected_seq: 1,
      content: content("<h1>Uncommitted</h1>"),
      task_id: "missing-task",
      operation_key: "failed-evidence",
    };
    await expect(call("artifacts_publish", failed)).rejects.toThrow("Task not found");
    expect(w.artifacts!.store.versions(a.id)).toHaveLength(1);
    expect(w.artifacts!.store.get(a.id).nextSeq).toBe(2);
    expect(w.one("SELECT id FROM entities WHERE id=?", `${a.id}@2`)).toBeNull();
    expect(
      w.one("SELECT id FROM audit_operations WHERE operation_key='failed-evidence'"),
    ).toBeNull();
    expect(w.one("SELECT key FROM operations WHERE key='failed-evidence'")).toBeNull();
    const published = await call<ArtifactVersion>("artifacts_publish", {
      ...failed,
      task_id: undefined,
    });
    expect(published.seq).toBe(2);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
