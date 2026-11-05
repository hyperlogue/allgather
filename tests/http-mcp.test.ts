import { expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixtureApiToken, fixtureResources } from "../scripts/fixture-auth.ts";
import { createApp, Updates } from "../server/app.ts";
import { Auth, OWNER, secret } from "../server/auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import {
  type Machine,
  type Operation,
  operations,
  type Principal,
  type Project,
  type ProjectAttribution,
  type Repository,
  type SessionCommand,
  type SessionRuntime,
  type Task,
} from "../shared/contracts.ts";
import terminalWire from "./fixtures/tower-terminal-v1.json";

const base = "https://allgather.example";
async function setup(dataDir?: string) {
  const db = openDatabase(":memory:"),
    w = new Workspace(db, undefined, undefined, { dataDir }),
    auth = new Auth(db, base),
    app = createApp(w, auth, new Updates());
  const req = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const loginToken = auth.createLoginToken("Test browser").token;
  const cookie = auth.signIn(auth.createLoginToken("API fixture consent").token).split(";")[0];
  const key = await fixtureApiToken(base, cookie, ["admin"], (request) => app.fetch(request));
  return { db, key, loginToken, w, auth, app, req };
}
async function authorize(
  s: Awaited<ReturnType<typeof setup>>,
  scope = "tasks:read tasks:write projects:read repositories:read commits:read transcripts:read offline_access",
  operatorName = "Approved test agent",
  keepAccess = true,
) {
  const client = (await (
    await s.req("/oauth/register", {
      client_name: "Test client",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
    })
  ).json()) as { client_id: string };
  const verifier = secret(),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = {
    client_id: client.client_id,
    redirect_uri: "https://client.example/callback",
    response_type: "code",
    resource_grants: JSON.stringify(fixtureResources),
    scope,
    keep_access: String(keepAccess),
    resource: `${base}/mcp`,
    state: randomUUID(),
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  const login = await s.req(
    "/api/login",
    { key: s.auth.createLoginToken("MCP consent").token },
    { origin: base },
  );
  expect(login.status).toBe(200);
  const cookieHeader = login.headers.get("set-cookie");
  if (!cookieHeader) throw new Error("Missing login cookie");
  const cookie = cookieHeader.split(";")[0];
  const consent = await s.req(
    "/api/oauth/authorize",
    { ...params, operator_name: operatorName },
    { cookie, origin: base },
  );
  expect(consent.status).toBe(200);
  const redirect = new URL(((await consent.json()) as { redirect_uri: string }).redirect_uri);
  expect(redirect.searchParams.get("iss")).toBe(base);
  expect(redirect.searchParams.get("state")).toBe(params.state);
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("Missing authorization code");
  return { client, params, verifier, code, cookie };
}
async function exchange(s: Awaited<ReturnType<typeof setup>>, body: Record<string, string>) {
  return s.app.fetch(
    new Request(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    }),
  );
}
test("public MCP exposes work tools and rejects private operations before dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-mcp-surface-"));
  const s = await setup(root);
  let client: McpClient | undefined;
  const dispatch = spyOn(s.w, "dispatch");
  const execute = spyOn(s.w, "execute");
  const subscribe = spyOn(s.w.artifacts!.notifications, "subscribe");
  try {
    const supported = s.auth.resourceMetadata().scopes_supported;
    expect(supported).not.toContain("sessions:identity");
    expect(supported).not.toContain("admin");
    expect(supported).not.toContain("repositories:write");
    const grant = await authorize(s, [...supported, "offline_access"].join(" "));
    const response = await exchange(s, {
      grant_type: "authorization_code",
      client_id: grant.client.client_id,
      code: grant.code,
      redirect_uri: grant.params.redirect_uri,
      code_verifier: grant.verifier,
      resource: `${base}/mcp`,
    });
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as { access_token: string };
    client = new McpClient({ name: "public-surface-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
        fetch: async (input, init) => s.app.fetch(new Request(input, init)),
      }),
    );
    const inventory = await client.listTools();
    const names = inventory.tools.map((tool) => tool.name);
    expect(names).toHaveLength(61);
    for (const name of [
      "tasks_create",
      "tasks_ready",
      "roles_list",
      "session_launch",
      "session_prompt",
      "session_cancel",
      "session_resume",
      "artifacts_publish",
      "artifact_threads_add",
      "artifact_comments_add",
      "session_transcript_events",
    ])
      expect(names).toContain(name);
    expect(names).not.toContain("session_takeover");
    expect(
      inventory.tools.find((t) => t.name === "session_resume")?.inputSchema.properties,
    ).not.toHaveProperty("force");
    const removed: Operation[] = [
      "projects_update",
      "session_assets_list",
      "session_configure",
      "projects_create",
      "roles_create",
      "roles_update",
      "roles_delete",
      "sessions_list",
      "sessions_declare",
      "sessions_bind_role",
      "session_transcript_import",
      "session_assets_add",
      "session_requests",
      "session_reply",
      "session_reconcile",
      "artifacts_delete",
      "artifacts_archive",
      "artifacts_restore",
      "artifact_threads_delete",
      "artifact_comments_fetch",
      "artifact_comments_ack",
      "artifacts_listen",
      "artifacts_unlisten",
      "artifacts_submit",
      "artifacts_watchers",
      "artifacts_usage",
      "artifacts_viewed",
      "artifacts_mark_viewed",
      ...(Object.keys(operations).filter((name) =>
        ["admin", "repositories:write"].includes(operations[name as Operation].scope),
      ) as Operation[]),
    ];
    for (const name of removed) {
      expect(names).not.toContain(name);
      const rejected = await client.callTool({ name, arguments: { operation_key: randomUUID() } });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).toContain(`Tool ${name} not found`);
    }
    expect(dispatch).not.toHaveBeenCalled();
    const broadMcp: Principal = {
      id: "old-broad-grant",
      kind: "client",
      resources: fixtureResources,
      inlet: "mcp",
      scopes: ["admin"],
    };
    for (const name of removed)
      await expect(s.w.dispatch(name, {}, broadMcp)).rejects.toMatchObject({ code: "not_found" });
    expect(execute).not.toHaveBeenCalled();
    const apiAttempt = await s.req(
      "/api/operations/roles_create",
      { name: "No bypass", operation_key: randomUUID() },
      {
        authorization: `Bearer ${tokens.access_token}`,
      },
    );
    expect(apiAttempt.status).toBe(401);
    const unsupportedScope = await s.req(
      "/api/oauth/authorize",
      { ...grant.params, scope: "sessions:identity" },
      {
        cookie: grant.cookie,
        origin: base,
      },
    );
    expect(unsupportedScope.status).toBe(400);
    const created = await client.callTool({
      name: "artifacts_create",
      arguments: {
        kind: "html",
        title: "Remote contribution",
        session_id: "remote-review",
        operation_key: randomUUID(),
      },
    });
    expect(created.isError).not.toBe(true);
    const artifact = (created.structuredContent as { result: { id: string } }).result;
    const publish = {
      artifact_id: artifact.id,
      expected_seq: 0,
      session_id: "remote-review",
      operation_key: randomUUID(),
      content: {
        kind: "html",
        files: [
          {
            path: "index.html",
            mediaType: "text/html",
            base64: Buffer.from("<h1>Remote review</h1>").toString("base64"),
          },
        ],
      },
    };
    expect(
      inventory.tools.find((tool) => tool.name === "artifacts_publish")!.inputSchema.properties,
    ).not.toHaveProperty("listen");
    expect(
      (
        await client.callTool({
          name: "artifacts_publish",
          arguments: { ...publish, listen: true },
        })
      ).isError,
    ).toBe(true);
    const published = await client.callTool({ name: "artifacts_publish", arguments: publish });
    expect(published.isError).not.toBe(true);
    const opened = await client.callTool({
      name: "artifact_threads_add",
      arguments: {
        artifact_id: artifact.id,
        session_id: "remote-review",
        operation_key: randomUUID(),
        input: { body: "Remote contribution", target: { kind: "artifact" } },
      },
    });
    expect(opened.isError).not.toBe(true);
    const thread = (opened.structuredContent as { result: { id: string } }).result;
    const resolution = {
      thread_id: thread.id,
      session_id: "remote-review",
      operator_kind: "user",
      operation_key: randomUUID(),
      input: { status: "resolved" },
    };
    expect(
      (await client.callTool({ name: "artifact_threads_edit", arguments: resolution })).isError,
    ).toBe(true);
    await expect(s.w.dispatch("artifact_threads_edit", resolution, broadMcp)).rejects.toMatchObject(
      { code: "forbidden" },
    );
    expect(s.w.artifacts!.conversations.get(thread.id).status).toBe("open");
    expect(subscribe).not.toHaveBeenCalled();
    expect(s.w.all("SELECT id FROM artifact_notifications")).toEqual([]);
    expect(
      (
        await s.req(
          "/api/operations/artifacts_archive",
          { artifact_id: artifact.id, operation_key: randomUUID() },
          {
            cookie: grant.cookie,
            origin: base,
          },
        )
      ).status,
    ).toBe(200);
  } finally {
    dispatch.mockRestore();
    execute.mockRestore();
    subscribe.mockRestore();
    await client?.close();
    s.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP terminal admission uses machine consent and rejects unsupported controls before queueing", async () => {
  const s = await setup();
  let client: McpClient | undefined;
  try {
    const grant = await authorize(
      s,
      "sessions:read sessions:launch sessions:prompt sessions:stop sessions:resume transcripts:read",
    );
    const headers = { cookie: grant.cookie, origin: base };
    const created = await s.req(
      "/api/operations/machines_create",
      { name: "Synthetic terminal connection", operation_key: randomUUID() },
      headers,
    );
    expect(created.status).toBe(200);
    const machine = ((await created.json()) as { result: Machine }).result;
    const issued = await s.req(
      "/api/tower/credentials",
      { machine_id: machine.id, label: "Terminal consent", scopes: ["read", "terminal:control"] },
      headers,
    );
    expect(issued.status).toBe(200);
    const credential = (await issued.json()) as { id: string };
    s.db
      .query("UPDATE machines SET connected=1,capabilities=?,terminal_controls=? WHERE id=?")
      .run(
        JSON.stringify(terminalWire.hello.capabilities),
        JSON.stringify(terminalWire.hello.terminal_controls),
        machine.id,
      );
    const exchanged = await exchange(s, {
      grant_type: "authorization_code",
      client_id: grant.client.client_id,
      code: grant.code,
      redirect_uri: grant.params.redirect_uri,
      code_verifier: grant.verifier,
      resource: `${base}/mcp`,
    });
    expect(exchanged.status).toBe(200);
    const tokens = (await exchanged.json()) as { access_token: string };
    client = new McpClient({ name: "terminal-admission", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
        fetch: async (input, init) => s.app.fetch(new Request(input, init)),
      }),
    );
    const marker = "PRIVATE_COMMAND_INPUT_AND_NATIVE_ERROR";
    const args = {
      machine_id: machine.id,
      ...terminalWire.launch,
      cwd: `/work/${marker}`,
      operation_key: randomUUID(),
    };
    const missingConsent = await client.callTool({ name: "session_launch", arguments: args });
    expect(missingConsent.isError).toBe(true);
    expect(JSON.stringify(missingConsent)).toContain("control_scope_required");
    expect(s.w.all("SELECT id FROM session_commands")).toEqual([]);
    s.db
      .query("UPDATE machines SET active_credential_id=? WHERE id=?")
      .run(credential.id, machine.id);
    const launched = await client.callTool({ name: "session_launch", arguments: args });
    expect(launched.isError).not.toBe(true);
    const result = (
      launched.structuredContent as { result: { runtime: SessionRuntime; command: SessionCommand } }
    ).result;
    expect(result.runtime.protocol).toBe("terminal");
    expect(result.command.payload).toEqual({ ...terminalWire.payload, cwd: args.cwd });
    expect(s.w.all("SELECT id FROM session_commands")).toHaveLength(1);
    for (const [name, input] of [
      ["session_prompt", { content: [{ type: "text", text: "Never inject this" }] }],
      ["session_resume", { machine_id: machine.id, cwd: "/work/project" }],
    ] as const) {
      const denied = await client.callTool({
        name,
        arguments: {
          target_session_id: result.runtime.session_id,
          operation_key: randomUUID(),
          ...input,
        },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain("unsupported_control");
      expect(s.w.all("SELECT id FROM session_commands")).toHaveLength(1);
    }
    const retry = await client.callTool({ name: "session_launch", arguments: args });
    expect(
      (retry.structuredContent as { result: { command: SessionCommand } }).result.command.id,
    ).toBe(result.command.id);
    expect(s.w.all("SELECT id FROM session_commands")).toHaveLength(1);
    const receipt = {
      command_id: result.command.id,
      runtime_id: result.runtime.id,
      generation: result.runtime.generation,
      receipt_revision: 1,
      state: "accepted",
      acceptance: { level: "adapter", at: new Date().toISOString() },
      dispatch: { state: "unknown", transport_written: true },
      error: {
        code: "dispatch_unknown",
        message: marker,
        stage: "dispatch",
        may_have_effect: true,
      },
    };
    s.w.run(
      "UPDATE session_commands SET result=?,state='acknowledged' WHERE id=?",
      JSON.stringify(receipt),
      result.command.id,
    );
    const status = await client.callTool({
      name: "session_commands",
      arguments: { target_session_id: result.runtime.session_id },
    });
    const item = (status.structuredContent as { result: { items: Record<string, unknown>[] } })
      .result.items[0];
    expect(item).toMatchObject({
      id: result.command.id,
      kind: "launch",
      state: "acknowledged",
      acceptance: { level: "adapter" },
      dispatch: { state: "unknown" },
      error: { code: "dispatch_unknown", stage: "dispatch", may_have_effect: true },
    });
    expect(item).not.toHaveProperty("payload");
    expect(item).not.toHaveProperty("result");
    expect(item).not.toHaveProperty("request_key");
    expect(JSON.stringify(status)).not.toContain(marker);
    expect(s.w.executions.command(result.command.id).payload.cwd).toBe(args.cwd);
  } finally {
    await client?.close();
    s.db.close();
  }
});

test("public MCP discovery, OAuth PKCE and real SDK task operations share the HTTP state", async () => {
  const s = await setup();
  let client: McpClient | undefined;
  try {
    const project = s.w.execute(
      "projects_create",
      { name: "Example", operation_key: randomUUID() },
      OWNER,
    ) as Project;
    const oldUpload = await s.req(
      "/api/operations/history_import",
      { commits: [] },
      { authorization: `Bearer ${s.key}` },
    );
    expect(oldUpload.status).toBe(404);
    const denied = await s.req("/mcp", {});
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
    expect(
      (
        (await (await s.req("/.well-known/oauth-authorization-server")).json()) as {
          code_challenge_methods_supported: string[];
        }
      ).code_challenge_methods_supported,
    ).toEqual(["S256"]);
    const grant = await authorize(s);
    const body = {
      grant_type: "authorization_code",
      client_id: grant.client.client_id,
      code: grant.code,
      redirect_uri: grant.params.redirect_uri,
      code_verifier: grant.verifier,
      resource: `${base}/mcp`,
    };
    const response = await exchange(s, body);
    if (response.status !== 200) throw new Error(await response.text());
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as { access_token: string; refresh_token: string };
    expect((await exchange(s, body)).status).toBe(400);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      fetch: async (input, init) => s.app.fetch(new Request(input, init)),
    });
    client = new McpClient({ name: "allgather-test", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === "tasks_create")).toBe(true);
    for (const name of [
      "tasks_progress",
      "tasks_labels",
      "tasks_plan_create",
      "links_context",
      "links_add",
      "links_remove",
      "session_transcript_events",
      "session_transcript_sources",
    ])
      expect(tools.tools.some((t) => t.name === name)).toBe(true);
    for (const name of [
      "epics_progress",
      "labels_list",
      "plans_create",
      "entities_context",
      "relations_add",
      "relations_remove",
      "transcripts_events",
      "transcripts_sources",
      "transcripts_import",
      "tasks_next",
      "session_transcript_import",
      "sessions_declare",
    ])
      expect(tools.tools.some((t) => t.name === name)).toBe(false);
    expect(tools.tools.some((t) => t.name === "history_import")).toBe(false);
    expect(tools.tools.some((t) => t.name === "repositories_match_projects")).toBe(true);
    expect(tools.tools.some((t) => t.name === "repositories_set_paths")).toBe(false);
    const configureRepository = async (operation: string, input: Record<string, unknown>) => {
      const response = await s.req(
        `/api/operations/${operation}`,
        {
          ...input,
          operation_key: randomUUID(),
        },
        { authorization: `Bearer ${s.key}` },
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { result: Repository }).result;
    };
    const repo = await configureRepository("repositories_create", {
      project_id: project.id,
      name: "Shared code",
      upstream_url: "https://example.invalid/shared.git",
      sync_enabled: false,
    });
    const other = s.w.execute(
      "projects_create",
      { name: "Web", operation_key: randomUUID() },
      OWNER,
    ) as Project;
    await configureRepository("repositories_attach", {
      repository_id: repo.id,
      project_id: other.id,
      path_prefixes: ["apps/web"],
    });
    const configured = await configureRepository("repositories_set_paths", {
      repository_id: repo.id,
      project_id: project.id,
      path_prefixes: ["./apps/"],
      expected_revision: repo.project_links[0].revision,
    });
    expect(
      configured.project_links.find((link) => link.project_id === project.id)?.path_prefixes,
    ).toEqual(["apps"]);
    const matched = await client.callTool({
      name: "repositories_match_projects",
      arguments: {
        repository_id: repo.id,
        paths: ["apps/web/main.ts"],
      },
    });
    expect((matched.structuredContent as { result: ProjectAttribution }).result).toMatchObject({
      project_id: other.id,
      basis: "path_prefix",
    });
    const created = await client.callTool({
      name: "tasks_create",
      arguments: {
        project_id: project.id,
        title: "Created through MCP",
        body: "Can retry without repeated effects",
        labels: ["Review", "review"],
        defer_until: "2099-01-01T00:00:00Z",
        operation_key: randomUUID(),
      },
    });
    const task = (created.structuredContent as { result: Task }).result;
    expect(task.title).toBe("Created through MCP");
    expect(task.labels).toEqual(["review"]);
    expect(task.defer_until).toBe("2099-01-01T00:00:00.000Z");
    expect(task.body).toContain("retry");
    const unassigned = await client.callTool({
      name: "tasks_ready",
      arguments: { project_id: project.id, unassigned: true },
    });
    expect(
      (unassigned.structuredContent as { result: { items: Task[] } }).result.items.map((t) => t.id),
    ).toEqual([task.id]);
    const noOwnerWork = await client.callTool({
      name: "tasks_ready",
      arguments: { project_id: project.id, assignee: { kind: "owner", id: "owner" } },
    });
    expect((noOwnerWork.structuredContent as { result: { items: Task[] } }).result.items).toEqual(
      [],
    );
    const context = await client.callTool({
      name: "tasks_context",
      arguments: { task_id: task.id },
    });
    expect((context.structuredContent as { result: { task: Task } }).result.task.id).toBe(task.id);
    expect(
      s.w.one<{ operator_name: string }>(
        "SELECT operator_name FROM audit_operations WHERE operation='tasks_create'",
      )?.operator_name,
    ).toBe("Approved test agent");
    const comment = await client.callTool({
      name: "task_comments_add",
      arguments: {
        task_id: task.id,
        body: "Reviewed over MCP",
        operator_name: "Owner",
        operator_kind: "user",
        operation_key: randomUUID(),
      },
    });
    expect(
      (comment.structuredContent as { result: { operator_kind: string; operator_name: string } })
        .result,
    ).toMatchObject({ operator_kind: "agent", operator_name: "Owner" });
    const http = await s.req(
      "/api/operations/tasks_get",
      { task_id: task.id },
      { authorization: `Bearer ${s.key}` },
    );
    expect(((await http.json()) as { result: Task }).result.id).toBe(task.id);
    const update = {
      task_id: task.id,
      expected_revision: task.revision,
      body: "Bot progress",
      title: "Updated through MCP",
      operation_key: randomUUID(),
    };
    const first = await client.callTool({ name: "tasks_update", arguments: update }),
      again = await client.callTool({ name: "tasks_update", arguments: update });
    expect(again.structuredContent).toEqual(first.structuredContent);
    const stale = await client.callTool({
      name: "tasks_update",
      arguments: { ...update, operation_key: randomUUID() },
    });
    expect(stale.isError).toBe(true);
    const plan = await client.callTool({
      name: "tasks_plan_create",
      arguments: {
        project_id: project.id,
        operation_key: randomUUID(),
        tasks: [
          { key: "parent", title: "MCP plan" },
          { key: "child", title: "MCP child", parent_key: "parent" },
        ],
      },
    });
    const mapping = (plan.structuredContent as { result: { mapping: Record<string, string> } })
      .result.mapping;
    const progress = await client.callTool({
      name: "tasks_progress",
      arguments: { epic_id: mapping.parent },
    });
    expect((progress.structuredContent as { result: { total: number }[] }).result[0].total).toBe(1);
    const labels = await client.callTool({
      name: "tasks_labels",
      arguments: { project_id: project.id },
    });
    expect(
      (labels.structuredContent as { result: { name: string }[] }).result.some(
        (l) => l.name === "review",
      ),
    ).toBe(true);
    const linked = await client.callTool({
      name: "links_add",
      arguments: {
        type: "relates_to",
        source_id: task.id,
        target_id: mapping.parent,
        operation_key: randomUUID(),
      },
    });
    const link = (linked.structuredContent as { result: { id: string } }).result;
    const linkedContext = await client.callTool({
      name: "links_context",
      arguments: { entity_id: task.id },
    });
    expect(
      (
        linkedContext.structuredContent as { result: { neighbors: { id: string }[] } }
      ).result.neighbors.some((n) => n.id === mapping.parent),
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "links_remove",
          arguments: {
            relation_id: link.id,
            reason: "Verified MCP route",
            operation_key: randomUUID(),
          },
        })
      ).isError,
    ).not.toBe(true);
    for (const [operation, input] of [
      ["sessions_declare", { target_session_id: "mcp-history" }],
      [
        "session_transcript_import",
        {
          target_session_id: "mcp-history",
          source_key: "private-import",
          events: [{ key: "note", kind: "text", payload: { text: "Imported context" } }],
        },
      ],
    ] as const) {
      expect(
        (
          await s.req(
            `/api/operations/${operation}`,
            { ...input, operation_key: randomUUID() },
            {
              cookie: grant.cookie,
              origin: base,
            },
          )
        ).status,
      ).toBe(200);
    }
    const sources = await client.callTool({
      name: "session_transcript_sources",
      arguments: { target_session_id: "mcp-history" },
    });
    expect((sources.structuredContent as { result: unknown[] }).result).toHaveLength(1);
    const events = await client.callTool({
      name: "session_transcript_events",
      arguments: { target_session_id: "mcp-history" },
    });
    expect(
      (events.structuredContent as { result: { items: { payload: { text: string } }[] } }).result
        .items[0].payload.text,
    ).toBe("Imported context");
    const refreshed = await exchange(s, {
      grant_type: "refresh_token",
      client_id: grant.client.client_id,
      refresh_token: tokens.refresh_token,
      resource: `${base}/mcp`,
    });
    expect(refreshed.status).toBe(200);
    const fresh = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(
      (
        await exchange(s, {
          grant_type: "refresh_token",
          client_id: grant.client.client_id,
          refresh_token: tokens.refresh_token,
          resource: `${base}/mcp`,
        })
      ).status,
    ).toBe(400);
    expect(
      s.auth.principal(
        new Request(`${base}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
        true,
      ),
    ).toBeNull();
    expect(
      s.auth.principal(
        new Request(`${base}/mcp`, { headers: { authorization: `Bearer ${fresh.access_token}` } }),
        true,
      )?.operator_name,
    ).toBe("Approved test agent");
    s.auth.revoke(grant.client.client_id);
    expect(
      s.auth.principal(
        new Request(`${base}/mcp`, { headers: { authorization: `Bearer ${fresh.access_token}` } }),
        true,
      ),
    ).toBeNull();
    expect(
      (
        await exchange(s, {
          grant_type: "refresh_token",
          client_id: grant.client.client_id,
          refresh_token: fresh.refresh_token,
          resource: `${base}/mcp`,
        })
      ).status,
    ).toBe(401);
  } finally {
    await client?.close();
    s.db.close();
  }
});
test("PKCE failure consumes the code; redirect, resource, origin and grant checks fail closed", async () => {
  const s = await setup();
  try {
    const grant = await authorize(s, "tasks:read");
    const bad = {
      grant_type: "authorization_code",
      client_id: grant.client.client_id,
      code: grant.code,
      redirect_uri: grant.params.redirect_uri,
      code_verifier: secret(),
      resource: `${base}/mcp`,
    };
    expect((await exchange(s, bad)).status).toBe(400);
    expect((await exchange(s, { ...bad, code_verifier: grant.verifier })).status).toBe(400);
    expect(
      (
        await s.req(
          "/api/oauth/authorize",
          { ...grant.params, redirect_uri: "https://other.example/callback" },
          { cookie: grant.cookie, origin: base },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await s.req(
          "/api/oauth/authorize",
          { ...grant.params, resource: "https://other.example/mcp" },
          { cookie: grant.cookie, origin: base },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await s.req("/api/oauth/authorize", grant.params, {
          cookie: grant.cookie,
          origin: "https://other.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (await s.req("/api/oauth/authorize", grant.params, { cookie: grant.cookie })).status,
    ).toBe(403);
    expect(
      (await s.req("/oauth/register", { redirect_uris: ["javascript:alert(1)"] })).status,
    ).toBe(400);
    expect((await s.app.fetch(new Request("https://other.example/api/session"))).status).toBe(403);
  } finally {
    s.db.close();
  }
});

test("owner can opt out of persistent access and read-only consent stays resource-bound", async () => {
  const s = await setup();
  try {
    const grant = await authorize(s, "tasks:read", undefined, false);
    const result = await exchange(s, {
      grant_type: "authorization_code",
      client_id: grant.client.client_id,
      code: grant.code,
      redirect_uri: grant.params.redirect_uri,
      code_verifier: grant.verifier,
      resource: `${base}/mcp`,
    });
    expect(result.status).toBe(200);
    const token = (await result.json()) as { access_token: string; refresh_token?: string };
    expect(token.refresh_token).toBeUndefined();
    const request = new Request(`${base}/mcp`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(s.auth.principal(request, true)?.scopes).toEqual(["tasks:read"]);
    expect(s.auth.principal(request, false)).toBeNull();
    const otherResource = new Auth(s.db, "https://other.example");
    expect(otherResource.principal(request, true)).toBeNull();
    s.db.query("UPDATE oauth_tokens SET expires=?").run(new Date(0).toISOString());
    expect(s.auth.principal(request, true)).toBeNull();
  } finally {
    s.db.close();
  }
});
