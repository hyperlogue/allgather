import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureBrowserCookie } from "../scripts/fixture-passkey.ts";
import { createApp, Updates } from "../server/app.ts";
import { Auth, hash, secret } from "../server/auth.ts";
import { ClientAccess } from "../server/client-access.ts";
import { openDatabase, SCHEMA_VERSION, writeDatabaseSnapshot } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import type { RegisteredClient } from "../shared/client-access.ts";
import { restoreClientSchema33 } from "./fixtures/session-schema.ts";
import { fullControls } from "./fixtures/tower-controls.ts";

function setup(dataDir?: string) {
  const db = openDatabase(":memory:"),
    w = new Workspace(db, undefined, undefined, { dataDir }),
    auth = new Auth(db, "https://owner.example", "https://mcp.example"),
    app = createApp(w, auth, new Updates());
  const cookie = fixtureBrowserCookie(db);
  const owner = { cookie, origin: auth.baseUrl };
  const send = (path: string, body?: unknown, headers: Record<string, string> = owner) =>
    app.fetch(
      new Request(auth.baseUrl + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const pair = async (scopes: string[], confirm = true) => {
    const opened = await (
      await send("/api/cli/pairings", {
        name: "Fixture client",
        scopes,
        resource_grants: { project_ids: "*", machine_ids: "*", unassigned: true },
        permission_modes: {},
      })
    ).json();
    const token = await (
      await send(
        "/api/cli/pairings/claim",
        { pairing_code: opened.pairing_code, request_id: secret() },
        {},
      )
    ).json();
    if (confirm)
      expect(
        (
          await send(
            `/api/cli/pairings/${opened.pairing_id}/confirm`,
            {},
            { authorization: `Bearer ${token.access_token}` },
          )
        ).status,
      ).toBe(200);
    return token;
  };
  const list = async () => (await (await send("/api/clients")).json()) as RegisteredClient[];
  const edit = (
    client: RegisteredClient,
    changes: Record<string, unknown>,
    headers: Record<string, string> = owner,
  ) => {
    const grant = (client.grants.find((g) => !g.revoked) ?? client.grants[0])!;
    return send(
      `/api/clients/${client.id}/grants/${grant.id}`,
      {
        expected_revision: grant.revision,
        scopes: grant.scopes,
        permission_modes: grant.permission_modes,
        resource_grants: grant.resource_grants,
        ...changes,
      },
      headers,
    );
  };
  return { db, w, auth, app, owner, send, pair, list, edit };
}

test("client usage records authenticated API, MCP and refresh use without inventing historical use", async () => {
  const s = setup();
  try {
    const token = await s.pair(["projects:read"], false);
    expect((await s.list())[0].last_used_at).toBeNull();
    const req = (value: string, mcp = false) =>
      new Request(mcp ? s.auth.resource : s.auth.apiResource, {
        headers: { authorization: `Bearer ${value}` },
      });
    expect(s.auth.principal(req("invalid"))).toBeNull();
    expect(s.auth.principal(req(token.access_token), true)).toBeNull();
    expect((await s.list())[0].last_used_at).toBeNull();
    expect(
      (
        await s.send(
          "/api/operations/projects_list",
          {},
          { authorization: `Bearer ${token.access_token}` },
        )
      ).status,
    ).toBe(200);
    const used = (await s.list())[0].last_used_at!;
    expect(Number.isFinite(Date.parse(used))).toBe(true);
    s.db
      .query("UPDATE oauth_tokens SET expires='2000-01-01' WHERE hash=?")
      .run(hash(token.access_token));
    expect(s.auth.principal(req(token.access_token))).toBeNull();
    expect((await s.list())[0].last_used_at).toBe(used);
    await new Promise((r) => setTimeout(r, 5));
    const refreshed = await s.auth.exchange(new Request(s.auth.baseUrl + "/oauth/token"), {
      grant_type: "refresh_token",
      client_id: token.client_id,
      refresh_token: token.refresh_token,
      resource: s.auth.apiResource,
    });
    expect((await s.list())[0].last_used_at! > used).toBe(true);
    s.db.query("UPDATE oauth_clients SET audience='mcp' WHERE id=?").run(token.client_id);
    s.db
      .query("UPDATE oauth_tokens SET resource=? WHERE client_id=?")
      .run(s.auth.resource, token.client_id);
    s.db
      .query("UPDATE oauth_grants SET resource=? WHERE client_id=?")
      .run(s.auth.resource, token.client_id);
    expect(s.auth.principal(req(String(refreshed.access_token), true), true)?.id).toBe(
      token.client_id,
    );
    const listed = JSON.stringify(await s.list());
    expect(listed).not.toContain(String(refreshed.access_token));
    expect(listed).not.toContain(token.refresh_token);
  } finally {
    s.db.close();
  }
});

test("owner edits are revision checked, resource scoped, audience bounded and cannot be self-authorized", async () => {
  const s = setup();
  try {
    const token = await s.pair(["tasks:read", "tasks:write", "projects:read", "sessions:launch"]);
    const client = (await s.list())[0];
    const bearer = { authorization: `Bearer ${token.access_token}` };
    expect((await s.edit(client, {}, bearer)).status).toBe(403);
    expect((await s.edit(client, {}, { cookie: s.owner.cookie })).status).toBe(403);
    expect((await s.edit(client, { scopes: ["admin"] })).status).toBe(409);
    expect(
      (
        await s.edit(client, {
          resource_grants: { project_ids: ["missing"], machine_ids: [], unassigned: false },
        })
      ).status,
    ).toBe(400);
    const changed = await s.edit(client, {
      scopes: ["tasks:read", "sessions:launch"],
      permission_modes: { "sessions:launch": "approval" },
      resource_grants: { project_ids: [], machine_ids: [], unassigned: false },
    });
    expect(changed.status).toBe(200);
    const principal = s.auth.principal(new Request(s.auth.apiResource, { headers: bearer }))!;
    expect(principal.scopes).toEqual(["tasks:read", "sessions:launch"]);
    expect(principal.permission_modes).toEqual({ "sessions:launch": "approval" });
    expect(principal.resources).toEqual({ project_ids: [], machine_ids: [], unassigned: false });
    const renewed = await s.auth.exchange(new Request(s.auth.baseUrl + "/oauth/token"), {
      grant_type: "refresh_token",
      client_id: token.client_id,
      refresh_token: token.refresh_token,
      resource: s.auth.apiResource,
    });
    bearer.authorization = `Bearer ${renewed.access_token}`;
    expect(s.auth.principal(new Request(s.auth.apiResource, { headers: bearer }))?.scopes).toEqual([
      "tasks:read",
      "sessions:launch",
    ]);
    expect((await s.edit(client, {})).status).toBe(409);
    const updated = (await s.list())[0];
    expect(
      (await s.edit(updated, { scopes: ["tasks:read", "tasks:write"], permission_modes: {} }))
        .status,
    ).toBe(200);
    expect(s.auth.principal(new Request(s.auth.apiResource, { headers: bearer }))?.scopes).toEqual([
      "tasks:read",
      "tasks:write",
    ]);
    const publicApp = createApp(s.w, s.auth, new Updates(), { surface: "public" });
    expect(
      (
        await publicApp.fetch(
          new Request(
            s.auth.mcpBaseUrl + `/api/clients/${client.id}/grants/${client.grants[0].id}`,
          ),
        )
      ).status,
    ).toBe(404);
    s.db.query("UPDATE oauth_clients SET audience='mcp' WHERE id=?").run(client.id);
    expect((await s.edit((await s.list())[0], { scopes: ["sessions:reply"] })).status).toBe(409);
    await s.send(`/api/clients/${client.id}/revoke`, {});
    expect((await s.edit((await s.list())[0], {})).status).toBe(409);
  } finally {
    s.db.close();
  }
});

test("narrowing an administrative grant removes admin immediately and approval changes stop queued dispatch", async () => {
  const s = setup();
  try {
    const token = await s.pair(["admin"]),
      bearer = { authorization: `Bearer ${token.access_token}` };
    const client = (await s.list())[0];
    expect(
      (await s.edit(client, { scopes: ["projects:read", "sessions:launch"], permission_modes: {} }))
        .status,
    ).toBe(200);
    const principal = s.auth.principal(new Request(s.auth.apiResource, { headers: bearer }))!;
    expect(principal.scopes).toEqual(["projects:read", "sessions:launch"]);
    expect((await s.send("/api/clients", undefined, bearer)).status).toBe(403);
    const owner = s.auth.principal(
      new Request(s.auth.baseUrl, { headers: { cookie: s.owner.cookie } }),
    )!;
    const m = s.w.execute(
      "machines_create",
      { name: "Fixture", operation_key: "machine" },
      owner,
    ) as { id: string };
    const credential = s.w.executions.issueCredential(m.id, "Fixture", [
      "read",
      "send",
      "acp:control",
    ]);
    s.w.run(
      "UPDATE machines SET connected=1,active_credential_id=?,capabilities=?,harnesses=?,harness_controls=? WHERE id=?",
      credential.id,
      JSON.stringify(["managed-acp.v1", "command-receipts.v1", "session-stream.v1"]),
      JSON.stringify(["codex"]),
      JSON.stringify({ codex: fullControls("codex-app-server") }),
      m.id,
    );
    const launch = await s.send(
      "/api/operations/session_launch",
      { machine_id: m.id, harness: "codex", cwd: "/work/fixture", operation_key: "launch" },
      bearer,
    );
    expect(launch.status).toBe(200);
    const { result } = await launch.json();
    expect(s.w.executions.managed.authority(result.command.id)).toBeTruthy();
    expect(
      (await s.edit((await s.list())[0], { permission_modes: { "sessions:launch": "approval" } }))
        .status,
    ).toBe(200);
    expect(s.w.executions.managed.authority(result.command.id)).toBeNull();
    expect(
      s.w.approvals.requires(
        "session_launch",
        s.auth.principal(new Request(s.auth.apiResource, { headers: bearer }))!,
      ),
    ).toBe(true);
    const own = s.auth.principal(
      new Request(s.auth.baseUrl, { headers: { cookie: s.owner.cookie } }),
    )!;
    const access = new ClientAccess(s.db, s.auth);
    expect(access.options(client.id, client.grants[0].id, own).scopes).toContain("tasks:read");
  } finally {
    s.db.close();
  }
});

test("grant reductions also retire artifact notification authority from existing credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-client-notifications-")),
    s = setup(root);
  try {
    const artifact = await (
      await s.send("/api/operations/artifacts_create", {
        title: "Fixture",
        kind: "html",
        operation_key: "artifact",
      })
    ).json();
    expect(artifact.result.id).toBeTruthy();
    expect(
      (
        await s.send("/api/operations/sessions_declare", {
          target_session_id: "fixture-session",
          harness: "codex",
          operation_key: "session",
        })
      ).status,
    ).toBe(200);
    for (const scopes of [["admin"], ["artifacts:read", "artifacts:notify"]]) {
      const token = await s.pair(scopes);
      expect(
        s.w.artifacts!.notifications.authorized(
          token.client_id,
          artifact.result.id,
          "fixture-session",
        ),
      ).toBe(true);
      const c = (await s.list()).find((c) => c.id === token.client_id)!;
      expect((await s.edit(c, { scopes: ["artifacts:read"], permission_modes: {} })).status).toBe(
        200,
      );
      expect(
        s.w.artifacts!.notifications.authorized(
          token.client_id,
          artifact.result.id,
          "fixture-session",
        ),
      ).toBe(false);
    }
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("version 32 upgrade preserves client grants and starts with unknown prior activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-client-upgrade-")),
    s = setup();
  try {
    const token = await s.pair(["tasks:read"]);
    const before = s.db.query("SELECT * FROM oauth_grants").all();
    restoreClientSchema33(s.db);
    s.db.exec("DROP TABLE client_activity; PRAGMA user_version=32");
    const path = join(root, "upgrade.sqlite");
    writeDatabaseSnapshot(s.db, path);
    const upgraded = openDatabase(path);
    try {
      expect(upgraded.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
      expect(upgraded.query("SELECT * FROM oauth_grants").all()).toEqual(before);
      const auth = new Auth(upgraded, s.auth.baseUrl, s.auth.mcpBaseUrl),
        access = new ClientAccess(upgraded, auth);
      expect(access.list()[0].last_used_at).toBeNull();
      expect(
        auth.principal(
          new Request(auth.apiResource, {
            headers: { authorization: `Bearer ${token.access_token}` },
          }),
        )?.scopes,
      ).toEqual(["tasks:read"]);
      expect(access.list()[0].last_used_at).not.toBeNull();
      expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      upgraded.close();
    }
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("deletion tombstones revoked clients without erasing identities, credentials, approvals or work", async () => {
  const s = setup();
  try {
    const token = await s.pair(["admin"]),
      other = await s.pair(["admin"]);
    const path = `/api/clients/${token.client_id}/delete`;
    expect((await s.send(path, {})).status).toBe(409);
    expect((await s.send(path, {}, { authorization: `Bearer ${token.access_token}` })).status).toBe(
      403,
    );
    expect((await s.send(path, {}, { cookie: s.owner.cookie })).status).toBe(403);
    const project = await (
      await s.send("/api/operations/projects_create", {
        name: "Retained work",
        operation_key: "project",
      })
    ).json();
    const task = await (
      await s.send("/api/operations/tasks_create", {
        project_id: project.result.id,
        title: "Keep task",
        operation_key: "task",
      })
    ).json();
    for (const [i, t] of [token, other].entries()) {
      const comment = await s.send(
        "/api/operations/task_comments_add",
        {
          task_id: task.result.id,
          body: `Comment ${i}`,
          operator_kind: "agent",
          agent_type: "codex",
          session_id: "codex:shared",
          operator_name: "Same session author",
          operation_key: `comment-${i}`,
        },
        { authorization: `Bearer ${t.access_token}` },
      );
      expect(comment.status).toBe(200);
    }
    const originalComments = s.db.query("SELECT * FROM task_comments ORDER BY sequence").all();
    const audits = s.db.query("SELECT * FROM audit_operations ORDER BY rowid").all();
    const grant = (await s.list()).find((c) => c.id === token.client_id)!.grants[0];
    s.db
      .query(
        "INSERT INTO approval_requests(id,client_id,grant_id,operation,operation_key,fingerprint,input,principal,target,state,created_at,expires_at) VALUES('past',?,?,'session_launch','past','fixture','{}','{}','{}','denied',?,?)",
      )
      .run(token.client_id, grant.id, new Date().toISOString(), "2099-01-01");
    await s.send(`/api/clients/${token.client_id}/revoke`, {});
    s.db.exec(
      "CREATE TEMP TRIGGER tombstone_failure BEFORE UPDATE OF deleted_at ON oauth_clients BEGIN SELECT RAISE(ABORT,'injected tombstone failure'); END",
    );
    expect((await s.send(path, {})).status).toBe(500);
    expect(
      s.db.query("SELECT deleted_at FROM oauth_clients WHERE id=?").get(token.client_id),
    ).toEqual({ deleted_at: null });
    s.db.exec("DROP TRIGGER tombstone_failure");
    expect((await s.send(path, {})).status).toBe(200);
    const identity = s.db
      .query("SELECT id,name,revoked,deleted_at FROM oauth_clients WHERE id=?")
      .get(token.client_id) as { deleted_at: string };
    expect(identity).toMatchObject({ id: token.client_id, name: "Fixture client", revoked: 1 });
    expect(identity.deleted_at).toBeTruthy();
    expect((await s.send(path, {})).status).toBe(200);
    expect(
      s.db
        .query("SELECT id,name,revoked,deleted_at FROM oauth_clients WHERE id=?")
        .get(token.client_id),
    ).toEqual(identity);
    for (const table of [
      "oauth_tokens",
      "oauth_grants",
      "cli_pairings",
      "approval_requests",
      "client_activity",
    ])
      expect(
        s.db.query(`SELECT 1 FROM ${table} WHERE client_id=?`).get(token.client_id),
      ).toBeTruthy();
    expect((await s.list()).map((c) => c.id)).toEqual([other.client_id]);
    const pairings = await (await s.send("/api/cli/pairings")).json();
    expect(pairings.pairings.some((p: any) => p.client_id === token.client_id)).toBe(false);
    const comments = await (
      await s.send("/api/operations/task_comments_list", { task_id: task.result.id })
    ).json();
    const first = comments.result.items.find((c: any) => c.body === "Comment 0"),
      second = comments.result.items.find((c: any) => c.body === "Comment 1");
    expect(first.connection).toEqual({
      id: token.client_id,
      name: "Fixture client",
      deleted_at: identity.deleted_at,
    });
    expect(second.connection.deleted_at).toBeNull();
    expect(first.operator_name).toBe("Same session author");
    const activity = await (
      await s.send("/api/operations/audit_list", { connection_id: token.client_id })
    ).json();
    expect(activity.result.items.length).toBeGreaterThan(0);
    expect(
      activity.result.items.every((a: any) => a.connection.deleted_at === identity.deleted_at),
    ).toBe(true);
    expect(s.db.query("SELECT * FROM task_comments ORDER BY sequence").all()).toEqual(
      originalComments,
    );
    expect(s.db.query("SELECT * FROM audit_operations ORDER BY rowid").all()).toEqual(audits);
    expect(() => s.db.query("DELETE FROM oauth_clients WHERE id=?").run(token.client_id)).toThrow(
      "retained",
    );
    expect(() =>
      s.db.query("UPDATE oauth_clients SET revoked=0 WHERE id=?").run(token.client_id),
    ).toThrow("immutable");
    expect(
      s.auth.principal(
        new Request(s.auth.apiResource, {
          headers: { authorization: `Bearer ${token.access_token}` },
        }),
      ),
    ).toBeNull();
    await expect(
      s.auth.exchange(new Request(s.auth.baseUrl + "/oauth/token"), {
        client_id: token.client_id,
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        resource: s.auth.apiResource,
      }),
    ).rejects.toBeTruthy();
    expect(s.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const publicApp = createApp(s.w, s.auth, new Updates(), { surface: "public" });
    expect(
      (await publicApp.fetch(new Request(s.auth.mcpBaseUrl + path, { method: "POST", body: "{}" })))
        .status,
    ).toBe(404);
  } finally {
    s.db.close();
  }
});

test("MCP tombstones survive registration pruning and hide bound pairing history without erasing references", async () => {
  const s = setup();
  try {
    const pairing = await (
      await s.send("/api/mcp/pairings", {
        name: "Shared fixture",
        scopes: ["tasks:read"],
        permission_modes: {},
        resource_grants: { project_ids: [], machine_ids: [], unassigned: true },
      })
    ).json();
    const register = async () =>
      await (
        await s.send(
          "/oauth/register",
          { client_name: "Fixture", redirect_uris: ["https://client.example/callback"] },
          {},
        )
      ).json();
    const a = await register(),
      b = await register();
    s.db
      .query("UPDATE mcp_pairings SET client_id=?,consumed_at=? WHERE id=?")
      .run(a.client_id, new Date().toISOString(), pairing.pairing_id);
    s.db
      .query(
        "INSERT INTO oauth_requests VALUES('a',?,?, '{}','2099-01-01'),('b',?,?, '{}','2099-01-01')",
      )
      .run(a.client_id, pairing.pairing_id, b.client_id, pairing.pairing_id);
    await s.send(`/api/clients/${a.client_id}/revoke`, {});
    expect((await s.send(`/api/clients/${a.client_id}/delete`, {})).status).toBe(200);
    expect(
      s.db.query("SELECT 1 FROM oauth_requests WHERE client_id=?").get(a.client_id),
    ).toBeTruthy();
    expect(
      s.db.query("SELECT 1 FROM oauth_requests WHERE client_id=?").get(b.client_id),
    ).toBeTruthy();
    const listing = await (await s.send("/api/mcp/pairings")).json();
    expect(listing.pairings.some((p: any) => p.pairing_id === pairing.pairing_id)).toBe(false);
    await s.send("/api/mcp/pairings", {
      name: "New connection",
      scopes: ["tasks:read"],
      permission_modes: {},
      resource_grants: { project_ids: [], machine_ids: [], unassigned: true },
    });
    expect((await register()).client_id).toBeTruthy();
    expect(
      s.db.query("SELECT deleted_at FROM oauth_clients WHERE id=?").get(a.client_id),
    ).toBeTruthy();
    expect(s.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    s.db.close();
  }
});

test("version 33 upgrade retains client activity and tombstones persist across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-tombstone-upgrade-")),
    s = setup();
  const path = join(root, "upgrade.sqlite");
  try {
    const token = await s.pair(["tasks:read"]),
      before = (await s.list())[0];
    restoreClientSchema33(s.db);
    writeDatabaseSnapshot(s.db, path);
    let db = openDatabase(path);
    let tombstone: unknown;
    try {
      const auth = new Auth(db, s.auth.baseUrl, s.auth.mcpBaseUrl),
        access = new ClientAccess(db, auth);
      expect(access.list()[0]).toEqual(before);
      auth.revoke(token.client_id);
      const owner = auth.principal(
        new Request(auth.baseUrl, { headers: { cookie: fixtureBrowserCookie(db) } }),
      );
      expect(access.remove(token.client_id, owner)).toEqual({ deleted: true });
      tombstone = db
        .query("SELECT id,name,revoked,deleted_at FROM oauth_clients WHERE id=?")
        .get(token.client_id);
    } finally {
      db.close();
    }
    db = openDatabase(path);
    try {
      const auth = new Auth(db, s.auth.baseUrl, s.auth.mcpBaseUrl),
        access = new ClientAccess(db, auth);
      expect(access.list()).toEqual([]);
      expect(
        db
          .query("SELECT id,name,revoked,deleted_at FROM oauth_clients WHERE id=?")
          .get(token.client_id),
      ).toEqual(tombstone);
      expect(
        db.query("SELECT 1 FROM oauth_grants WHERE client_id=?").get(token.client_id),
      ).toBeTruthy();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
