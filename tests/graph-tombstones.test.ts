import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import {
  type Operation,
  operations,
  type Principal,
  type Project,
  type Task,
} from "../shared/contracts.ts";

const owner: Principal = { id: "owner", kind: "owner", inlet: "browser", scopes: ["admin"] };
test("deleted threads and artifacts retain both link directions and project access without retaining comment contents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "allgather-tombstones-")),
    path = join(dir, "db.sqlite");
  let db = openDatabase(path),
    w = new Workspace(db, undefined, undefined, { dataDir: dir });
  const call = <T>(name: Operation, input: Record<string, unknown>, p = owner) =>
    w.dispatch(
      name,
      { ...(operations[name].write ? { operation_key: randomUUID() } : {}), ...input },
      p,
    ) as Promise<T>;
  try {
    const p = await call<Project>("projects_create", { name: "Allowed" }),
      other = await call<Project>("projects_create", { name: "Other" });
    const t = await call<Task>("tasks_create", { project_id: p.id, title: "Context" });
    const a = await call<{ id: string }>("artifacts_create", {
      kind: "html",
      title: "Review title",
      project_id: p.id,
    });
    const thread = await call<{ id: string }>("artifact_threads_add", {
      artifact_id: a.id,
      input: { body: "private thread body", target: { kind: "artifact" } },
    });
    const comment = await call<{ id: string }>("artifact_comments_add", {
      thread_id: thread.id,
      input: { body: "private answer" },
    });
    await call("links_add", { source_id: t.id, target_id: thread.id, type: "asks" });
    await call("links_add", { source_id: comment.id, target_id: t.id, type: "answers" });
    await call("links_add", { source_id: t.id, target_id: a.id, type: "produces" });
    await call("artifact_threads_delete", { thread_id: thread.id });
    expect(w.graph.entity(thread.id).deleted_at).toBeTruthy();
    expect(w.graph.entity(comment.id).deleted_at).toBeTruthy();
    expect(w.graph.relations(t.id)).toHaveLength(3);
    const reader: Principal = {
      id: "read",
      kind: "client",
      inlet: "mcp",
      scopes: ["tasks:read", "artifacts:read"],
      resources: { project_ids: [p.id], machine_ids: [], unassigned: false },
    };
    const context = await call<{
      neighbors: { id: string; value: unknown; deleted_at: string | null }[];
    }>("links_context", { entity_id: t.id }, reader);
    expect(context.neighbors.find((e) => e.id === thread.id)?.value).toBeNull();
    expect(JSON.stringify(context)).not.toContain("private thread body");
    expect(JSON.stringify(context)).not.toContain("private answer");
    await expect(
      call(
        "links_context",
        { entity_id: thread.id },
        { ...reader, resources: { project_ids: [other.id], machine_ids: [], unassigned: false } },
      ),
    ).rejects.toThrow("not granted");
    await call("artifacts_delete", { artifact_id: a.id });
    expect(w.graph.describe(w.graph.entity(a.id))).toMatchObject({
      label: "Review title",
      value: null,
    });
    await expect(call("artifacts_get", { artifact_id: a.id })).rejects.toThrow();
    db.close();
    db = openDatabase(path);
    w = new Workspace(db, undefined, undefined, { dataDir: dir });
    const reloaded = await call<{
      relations: { total: number };
      entity: { deleted_at: string | null; value: unknown };
    }>("links_context", { entity_id: thread.id }, reader);
    expect(reloaded.relations.total).toBe(1);
    expect(reloaded.entity.deleted_at).toBeTruthy();
    expect(reloaded.entity.value).toBeNull();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
