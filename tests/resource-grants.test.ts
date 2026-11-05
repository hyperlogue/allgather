import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureApiToken } from "../scripts/fixture-auth.ts";
import { createApp, Updates } from "../server/app.ts";
import { Auth } from "../server/auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import type { Operation, Principal } from "../shared/contracts.ts";
import type { ResourceGrants } from "../shared/resource-grants.ts";
import { fullControls } from "./fixtures/tower-controls.ts";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "allgather-grants-")),
    db = openDatabase(":memory:");
  const w = new Workspace(db, undefined, undefined, { dataDir: root }),
    auth = new Auth(db, "https://owner.example");
  const app = createApp(w, auth, new Updates(), {
    backup: () =>
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
  });
  const cookie = auth.signIn(auth.createLoginToken("Grants fixture").token).split(";")[0];
  const owner = auth.principal(new Request(auth.baseUrl, { headers: { cookie } }))!;
  let n = 0;
  const call = (name: Operation, input: Record<string, unknown> = {}, p = owner) =>
    w.dispatch(name, input, p) as Promise<any>;
  const write = (name: Operation, input: Record<string, unknown> = {}, p = owner) =>
    call(name, { operation_key: `op-${++n}`, ...input }, p);
  const a = await write("projects_create", { name: "A" }),
    b = await write("projects_create", { name: "B" });
  const ta = await write("tasks_create", {
    project_id: a.id,
    title: "Visible work",
    labels: ["visible"],
  });
  const tb = await write("tasks_create", {
    project_id: b.id,
    title: "Private work",
    labels: ["private"],
  });
  const machines = await Promise.all([
    write("machines_create", { name: "First" }),
    write("machines_create", { name: "Second" }),
  ]);
  for (const m of machines)
    w.run(
      "UPDATE machines SET connected=1,capabilities=?,harnesses=?,harness_controls=? WHERE id=?",
      JSON.stringify(["managed-acp.v1", "command-receipts.v1", "session-stream.v1"]),
      '["fixture"]',
      JSON.stringify({ fixture: fullControls() }),
      m.id,
    );
  const agent = async (resources: ResourceGrants, scopes = ["admin"]) => {
    const token = await fixtureApiToken(
      auth.baseUrl,
      cookie,
      scopes,
      (r) => app.fetch(r),
      resources,
    );
    const p = auth.principal(
      new Request(auth.baseUrl, { headers: { authorization: `Bearer ${token}` } }),
    )!;
    const request = (path: string, body?: unknown) =>
      app.fetch(
        new Request(auth.baseUrl + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    return { p, request, token };
  };
  return {
    w,
    auth,
    app,
    owner,
    cookie,
    call,
    write,
    a,
    b,
    ta,
    tb,
    machines,
    agent,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("project restrictions apply before pagination, labels, graph context and writes even with admin scope", async () => {
  const f = await setup();
  try {
    const { p } = await f.agent({ project_ids: [f.a.id], machine_ids: [], unassigned: false });
    const list = await f.call("tasks_search", { limit: 1 }, p);
    expect(list.total).toBe(1);
    expect(list.items[0].id).toBe(f.ta.id);
    expect(list.next_cursor).toBeNull();
    expect(await f.call("tasks_labels", {}, p)).toEqual([{ name: "visible", count: 1 }]);
    expect((await f.call("projects_list", {}, p)).map((p: any) => p.id)).toEqual([f.a.id]);
    await expect(f.call("tasks_get", { task_id: f.tb.id }, p)).rejects.toMatchObject({
      code: "resource_not_granted",
    });
    await expect(
      f.write(
        "tasks_update",
        { task_id: f.tb.id, expected_revision: f.tb.revision, title: "Changed" },
        p,
      ),
    ).rejects.toMatchObject({ code: "resource_not_granted" });
    expect(f.w.task(f.tb.id).title).toBe("Private work");
    await f.write("tasks_set_dependency", {
      task_id: f.ta.id,
      depends_on: f.tb.id,
      expected_revision: f.ta.revision,
    });
    const context = await f.call("tasks_context", { task_id: f.ta.id }, p);
    expect(context.task.blocked).toBe(true);
    expect(context.dependencies).toEqual([]);
    expect(JSON.stringify(context)).not.toContain(f.tb.id);
    expect(JSON.stringify(context)).not.toContain("Private work");
    await f.write("links_add", { source_id: f.ta.id, target_id: f.tb.id, type: "relates_to" });
    expect((await f.call("links_context", { entity_id: f.ta.id }, p)).relations.total).toBe(0);
    await expect(
      f.write("links_add", { source_id: f.ta.id, target_id: f.tb.id, type: "relates_to" }, p),
    ).rejects.toMatchObject({ code: "resource_not_granted" });
    await expect(
      f.call(
        "tasks_get",
        { task_id: f.ta.id },
        { id: "missing-grant", kind: "client", scopes: ["tasks:read"] },
      ),
    ).rejects.toMatchObject({ code: "resource_not_granted" });
  } finally {
    f.close();
  }
});

test("project and machine grants intersect for sessions and are rechecked before command dispatch", async () => {
  const f = await setup();
  try {
    const permitted = await f.write("session_launch", {
      project_id: f.a.id,
      machine_id: f.machines[0].id,
      harness: "fixture",
      cwd: "/work/a",
    });
    const otherMachine = await f.write("session_launch", {
      project_id: f.a.id,
      machine_id: f.machines[1].id,
      harness: "fixture",
      cwd: "/work/a",
    });
    const otherProject = await f.write("session_launch", {
      project_id: f.b.id,
      machine_id: f.machines[0].id,
      harness: "fixture",
      cwd: "/work/b",
    });
    const unassigned = await f.write("sessions_declare", { target_session_id: "external" });
    const grant = { project_ids: [f.a.id], machine_ids: [f.machines[0].id], unassigned: false };
    const { p } = await f.agent(grant);
    const list = await f.call("sessions_search", {}, p);
    expect(list.total).toBe(1);
    expect(list.items[0].id).toBe(permitted.session.id);
    for (const session of [otherMachine.session.id, otherProject.session.id, unassigned.id])
      await expect(f.call("sessions_get", { target_session_id: session }, p)).rejects.toMatchObject(
        { code: "resource_not_granted" },
      );
    expect((await f.call("machines_list", {}, p)).map((m: any) => m.id)).toEqual([
      f.machines[0].id,
    ]);
    await expect(
      f.write(
        "session_launch",
        { project_id: f.a.id, machine_id: f.machines[1].id, harness: "fixture", cwd: "/work/a" },
        p,
      ),
    ).rejects.toMatchObject({ code: "resource_not_granted" });
    await f.write("links_add", { source_id: unassigned.id, target_id: f.ta.id, type: "works_on" });
    await expect(
      f.call("sessions_get", { target_session_id: unassigned.id }, p),
    ).rejects.toMatchObject({ code: "resource_not_granted" });
    const launched = await f.write(
      "session_launch",
      { task_id: f.ta.id, machine_id: f.machines[0].id, harness: "fixture", cwd: "/work/a" },
      p,
    );
    expect(launched.session.project_id).toBe(f.a.id);
    expect(f.w.executions.managed.authority(launched.command.id)).not.toBeNull();
    f.w.run("UPDATE oauth_grants SET revoked=1 WHERE id=?", p.grant_id!);
    expect(f.w.executions.managed.authority(launched.command.id)).toBeNull();
    const { p: withUnassigned } = await f.agent({ ...grant, unassigned: true });
    expect(
      (await f.call("sessions_get", { target_session_id: unassigned.id }, withUnassigned)).id,
    ).toBe(unassigned.id);
  } finally {
    f.close();
  }
});

test("artifact search and raw HTTP reads cannot escape resource grants or concurrent request contexts", async () => {
  const f = await setup();
  try {
    const artifacts = [];
    for (const project of [f.a.id, f.b.id, null]) {
      const artifact = await f.write("artifacts_create", {
        kind: "html",
        title: project === f.a.id ? "Shared visible" : "Shared private",
        project_id: project,
      });
      await f.write("artifacts_publish", {
        artifact_id: artifact.id,
        expected_seq: 0,
        content: {
          kind: "html",
          files: [
            {
              path: "index.html",
              mediaType: "text/html",
              base64: Buffer.from("<p>Shared content</p>").toString("base64"),
            },
          ],
        },
      });
      artifacts.push(artifact);
    }
    const first = await f.agent({ project_ids: [f.a.id], machine_ids: [], unassigned: false });
    const second = await f.agent({ project_ids: [f.b.id], machine_ids: [], unassigned: false });
    const [left, right] = await Promise.all([
      f.call("artifacts_search", { query: "Shared", limit: 1 }, first.p),
      f.call("artifacts_search", { query: "Shared", limit: 1 }, second.p),
    ]);
    expect(JSON.stringify(left)).not.toContain(artifacts[1].id);
    expect(JSON.stringify(right)).not.toContain(artifacts[0].id);
    const list = await f.call("artifacts_list", { limit: 1 }, first.p);
    expect(list.total).toBe(1);
    expect(list.items[0].id).toBe(artifacts[0].id);
    expect((await first.request(`/api/artifacts/${artifacts[1].id}`)).status).toBe(403);
    expect(
      (await first.request(`/api/artifacts/${artifacts[1].id}/versions/1/source?path=index.html`))
        .status,
    ).toBe(403);
    expect((await first.request(`/api/artifacts/${artifacts[0].id}`)).status).toBe(200);
    expect((await first.request("/api/backup")).status).toBe(403);
    expect((await first.request("/api/clients")).status).toBe(403);
    expect((await first.request("/api/tower/credentials")).status).toBe(403);
    expect((await first.request("/api/oauth/request")).status).toBe(403);
    expect((await first.request("/api/library-summary")).status).toBe(403);
    const reader = { ...first.p, scopes: ["artifacts:read"] } as Principal;
    await expect(
      f.write("artifacts_edit", { artifact_id: artifacts[0].id, input: { title: "No" } }, reader),
    ).rejects.toMatchObject({ code: "forbidden" });
  } finally {
    f.close();
  }
});

test("a shared repository requires every project grant even when path attribution selects just one", async () => {
  const f = await setup();
  try {
    const repo = await f.write("repositories_create", {
      name: "Shared",
      project_id: f.a.id,
      upstream_url: "https://git.example/shared.git",
      sync_enabled: false,
      path_prefixes: ["a"],
    });
    await f.write("repositories_attach", {
      repository_id: repo.id,
      project_id: f.b.id,
      path_prefixes: ["b"],
    });
    const at = new Date().toISOString(),
      hash = "1".repeat(40);
    f.w.run(
      "INSERT INTO commits(repository_id,id,parents,message,authored_at,committed_at,files,verified_upstream,files_complete) VALUES(?,?,'[]','Private shared message',?,?,?,1,1)",
      repo.id,
      hash,
      at,
      at,
      JSON.stringify([{ path: "a/main.ts", status: "M" }]),
    );
    const { p } = await f.agent({ project_ids: [f.a.id], machine_ids: [], unassigned: false });
    expect(await f.call("repositories_list", {}, p)).toEqual([]);
    expect((await f.call("history_search", {}, p)).total).toBe(0);
    await expect(
      f.call("history_get_commit", { repository_id: repo.id, commit_id: hash }, p),
    ).rejects.toMatchObject({ code: "resource_not_granted" });
    await expect(
      f.call("repositories_match_projects", { repository_id: repo.id, paths: ["a/main.ts"] }, p),
    ).rejects.toMatchObject({ code: "resource_not_granted" });
    const { p: both } = await f.agent({
      project_ids: [f.a.id, f.b.id],
      machine_ids: [],
      unassigned: false,
    });
    expect((await f.call("repositories_list", {}, both)).map((r: any) => r.id)).toEqual([repo.id]);
    expect((await f.call("history_search", {}, both)).total).toBe(1);
  } finally {
    f.close();
  }
});

test("refresh retains the exact grant and explicit token revocation retires pending command authority", async () => {
  const f = await setup();
  try {
    const client = f.auth.register(
      { redirect_uris: ["https://connector.example/callback"] },
      "api",
    );
    const verifier = "a".repeat(43),
      resources = { project_ids: [f.a.id], machine_ids: [f.machines[0].id], unassigned: false };
    const approved = await f.auth.authorize(
      new Request(f.auth.baseUrl + "/api/oauth/authorize", {
        headers: { cookie: f.cookie, origin: f.auth.baseUrl },
      }),
      {
        client_id: client.client_id,
        redirect_uri: "https://connector.example/callback",
        response_type: "code",
        scope: "sessions:launch",
        resource: f.auth.apiResource,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        resource_grants: JSON.stringify(resources),
      },
    );
    const tokenRequest = new Request(f.auth.baseUrl + "/oauth/token", { method: "POST" });
    const tokens = await f.auth.exchange(tokenRequest, {
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: "https://connector.example/callback",
      code: new URL(approved.redirect_uri).searchParams.get("code")!,
      code_verifier: verifier,
      resource: f.auth.apiResource,
    });
    const principal = (token: unknown) =>
      f.auth.principal(
        new Request(f.auth.baseUrl, { headers: { authorization: `Bearer ${token}` } }),
      );
    const original = principal(tokens.access_token)!;
    const launched = await f.write(
      "session_launch",
      { project_id: f.a.id, machine_id: f.machines[0].id, harness: "fixture", cwd: "/work/a" },
      original,
    );
    const rotated = await f.auth.exchange(tokenRequest, {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: String(tokens.refresh_token),
      resource: f.auth.apiResource,
      resource_grants: JSON.stringify({ project_ids: "*", machine_ids: "*", unassigned: true }),
    });
    expect(principal(tokens.access_token)).toBeNull();
    expect(principal(rotated.access_token)?.resources).toEqual(resources);
    expect(principal(rotated.access_token)?.grant_id).toBe(original.grant_id);
    expect(f.w.executions.managed.authority(launched.command.id)).not.toBeNull();
    f.auth.revokeToken(String(rotated.access_token));
    expect(principal(rotated.access_token)).toBeNull();
    expect(f.w.executions.managed.authority(launched.command.id)).toBeNull();
  } finally {
    f.close();
  }
});

test("agent artifact contributions inherit their task project without an Unassigned grant or a hidden-session identity", async () => {
  const f = await setup();
  try {
    const { p } = await f.agent({ project_ids: [f.a.id], machine_ids: [], unassigned: false }, [
      "tasks:read",
      "tasks:write",
      "artifacts:read",
      "artifacts:contribute",
      "sessions:read",
    ]);
    const artifact = await f.write(
      "artifacts_create",
      {
        kind: "html",
        title: "Task evidence",
        task_id: f.ta.id,
        session_id: "project-agent",
        operator_kind: "agent",
      },
      p,
    );
    expect(artifact.projectId).toBe(f.a.id);
    expect(f.w.sessions.get("project-agent").project_id).toBe(f.a.id);
    await f.write("sessions_declare", {
      target_session_id: "hidden-agent",
      project_id: f.b.id,
      label: "Hidden label",
    });
    await expect(
      f.write(
        "task_comments_add",
        {
          task_id: f.ta.id,
          body: "Impersonated",
          session_id: "hidden-agent",
          operator_kind: "agent",
        },
        p,
      ),
    ).rejects.toMatchObject({ code: "resource_not_granted" });
    expect(f.w.all("SELECT id FROM task_comments WHERE body='Impersonated'")).toHaveLength(0);
  } finally {
    f.close();
  }
});
