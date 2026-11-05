import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { renderMessageHtml } from "../server/r3/web/src/markdown.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import {
  type Operation,
  operations,
  type Principal,
  type Project,
  type Task,
  type TaskComment,
  type TaskContext,
} from "../shared/contracts.ts";
import { taskAnswer, taskQuestions } from "../web/task-questions.ts";

const owner: Principal = { id: "owner", kind: "owner", scopes: ["admin"], inlet: "browser" };
const body =
  'Choose a direction.\n\n```questions\n[{"question":"Ship?","options":["Yes","Request changes","Decline"]}]\n```';
test("task question answers are append-only comments and one durable resolution, regardless of answer", () => {
  const db = openDatabase(":memory:"),
    w = new Workspace(db);
  const call = <T>(op: Operation, input: Record<string, unknown>, p = owner) =>
    w.execute(
      op,
      { ...(operations[op].write ? { operation_key: randomUUID() } : {}), ...input },
      p,
    ) as T;
  try {
    const project = call<Project>("projects_create", { name: "Project" });
    let task = call<Task>("tasks_create", { project_id: project.id, title: "Question" });
    for (const answer of ["Yes", "Request changes", "Decline", "An alternative"]) {
      task = call<Task>("tasks_block", {
        task_id: task.id,
        expected_revision: task.revision,
        waiting_on: "owner",
        body,
      });
      const context = call<TaskContext>("tasks_context", { task_id: task.id }),
        blocker = context.blockers[0];
      const input = {
        task_id: task.id,
        body: taskAnswer(taskQuestions(body)!.questions, [answer]),
        resolve_blocker_id: blocker.id,
        operation_key: randomUUID(),
      };
      const comment = call<TaskComment>("task_comments_add", input);
      expect(call<TaskComment>("task_comments_add", input)).toEqual(comment);
      expect(() => call("task_comments_add", { ...input, operation_key: randomUUID() })).toThrow(
        "already has an answer",
      );
      const resolved = call<TaskContext>("tasks_context", { task_id: task.id });
      task = resolved.task;
      expect(task.blocked).toBe(false);
      expect(resolved.blockers).toHaveLength(0);
      expect(resolved.resolved_blockers.find((b) => b.id === blocker.id)?.resolved_comment_id).toBe(
        comment.id,
      );
      expect(resolved.comments.items.filter((c) => c.id === comment.id)).toHaveLength(1);
      expect(() =>
        db.query("UPDATE task_comments SET body='new' WHERE id=?").run(comment.id),
      ).toThrow();
    }
    task = call<Task>("tasks_block", {
      task_id: task.id,
      expected_revision: task.revision,
      waiting_on: "owner",
      body: "Agent can resolve too",
    });
    const blocker = call<TaskContext>("tasks_context", { task_id: task.id }).blockers[0];
    const agent: Principal = {
      id: "connector",
      kind: "client",
      inlet: "mcp",
      scopes: ["tasks:read", "tasks:write"],
      resources: { project_ids: [project.id], machine_ids: [], unassigned: false },
    };
    call(
      "task_comments_add",
      {
        task_id: task.id,
        body: "Alternative works",
        resolve_blocker_id: blocker.id,
        session_id: "fixture-agent",
      },
      agent,
    );
    expect(w.task(task.id).blocked).toBe(false);
    expect(w.all("SELECT * FROM approval_requests")).toHaveLength(0);
    expect(w.all("SELECT * FROM session_commands")).toHaveLength(0);
  } finally {
    db.close();
  }
});
test("question syntax is presentation only and invalid data stays plain Markdown", () => {
  expect(taskQuestions(body)?.questions).toHaveLength(1);
  for (const text of [
    "```questions\n{}\n```",
    body + "\n" + body,
    '```questions\n[{"question":"Q","options":["same","same"]}]\n```',
    '```questions\n[{"question":"Q","options":["A"],"execute":"evil"}]\n```',
  ])
    expect(taskQuestions(text)).toBeNull();
  const html = renderMessageHtml(
    "<script>alert(1)</script>\n![leak](https://example.invalid/secret)\n[bad](javascript:alert(1))",
  );
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
});
