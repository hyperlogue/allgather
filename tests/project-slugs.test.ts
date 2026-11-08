import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import type { Operation, Project, Task } from "../shared/contracts.ts";

const owner = {
  id: "owner",
  kind: "owner" as const,
  scopes: ["admin"] as const,
  inlet: "browser" as const,
};

test("project slugs are unique and immutable, task counters are independent and transactional", async () => {
  const db = openDatabase(":memory:");
  const w = new Workspace(db);
  const call = async <T>(name: Operation, input: Record<string, unknown>) =>
    (await w.dispatch(name, { operation_key: randomUUID(), ...input }, owner)) as T;
  try {
    const project = await call<Project>("projects_create", { name: "Catchlight", slug: "cl" });
    expect(project.slug).toBe("CL");
    const firstInput = { project_id: project.id, title: "First", operation_key: "first" };
    const first = await call<Task>("tasks_create", firstInput);
    expect(first.id).toBe("CL-1");
    expect((await call<Task>("tasks_create", firstInput)).id).toBe(first.id);
    const renamed = await call<Project>("projects_update", {
      project_id: project.id,
      name: "New display name",
      expected_revision: 1,
    });
    expect(renamed.slug).toBe("CL");
    await expect(
      call("projects_update", {
        project_id: project.id,
        slug: "NEW",
        expected_revision: renamed.revision,
      }),
    ).rejects.toThrow();
    await expect(call("projects_create", { name: "Duplicate", slug: "CL" })).rejects.toThrow(
      "slug",
    );
    for (const slug of ["", "1A", "BAD-SLUG", "ABCDEFGHIJKLMNOPQ"])
      await expect(call("projects_create", { name: "Invalid", slug })).rejects.toThrow();
    await expect(
      call("tasks_create", {
        project_id: project.id,
        title: "Invalid parent",
        parent_id: "missing",
      }),
    ).rejects.toThrow();
    expect((await call<Task>("tasks_create", { project_id: project.id, title: "Second" })).id).toBe(
      "CL-2",
    );
    const other = await call<Project>("projects_create", { name: "Another", slug: "AN" });
    expect(
      (await call<Task>("tasks_create", { project_id: other.id, title: "Independent" })).id,
    ).toBe("AN-1");
    const plan = await call<{ tasks: Task[] }>("tasks_plan_create", {
      project_id: project.id,
      tasks: [
        { key: "a", title: "Third" },
        { key: "b", title: "Fourth", parent_key: "a" },
      ],
    });
    expect(plan.tasks.map((task) => task.id)).toEqual(["CL-3", "CL-4"]);
  } finally {
    db.close();
  }
});

test("saved slugs and task counters survive reopen without rewriting records", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-slugs-"));
  const path = join(root, "data.sqlite");
  let db = openDatabase(path);
  try {
    let w = new Workspace(db);
    const project = w.execute(
      "projects_create",
      { name: "Catchlight", slug: "CL", operation_key: "project" },
      owner,
    ) as Project;
    const task = w.execute(
      "tasks_create",
      { project_id: project.id, title: "First", operation_key: "first" },
      owner,
    ) as Task;
    const savedProject = w.project(project.id);
    const savedTask = w.task(task.id);
    const audit = w.all("SELECT * FROM audit_changes");
    db.close();
    db = openDatabase(path);
    expect(() => db.exec("UPDATE projects SET slug='NEW'")).toThrow("immutable");
    w = new Workspace(db);
    expect(w.project(project.id)).toEqual(savedProject);
    expect(w.task(task.id)).toEqual(savedTask);
    expect(w.all("SELECT * FROM audit_changes")).toEqual(audit);
    expect(
      (
        w.execute(
          "tasks_create",
          { project_id: project.id, title: "Next", operation_key: "next" },
          owner,
        ) as Task
      ).id,
    ).toBe("CL-2");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
