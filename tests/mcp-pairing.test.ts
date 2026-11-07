import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  fixtureApiToken,
  fixtureMcpAuthorization,
  fixtureResources,
} from "../scripts/fixture-auth.ts";
import { createApp, Updates } from "../server/app.ts";
import { Auth } from "../server/auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";

const owner = "https://owner.example",
  mcp = "https://mcp.example",
  callback = "https://chatgpt.example/callback";

function setup() {
  const db = openDatabase(":memory:"),
    workspace = new Workspace(db),
    auth = new Auth(db, owner, mcp),
    privateApp = createApp(workspace, auth, new Updates()),
    publicApp = createApp(workspace, auth, new Updates(), {
      surface: "public",
      peer: (request) => request.headers.get("x-fixture") ?? "fixture",
    });
  const cookie = auth.signIn(auth.createLoginToken("Pairing test").token).split(";")[0];
  const sendOwner = (request: Request) => privateApp.fetch(request),
    sendMcp = (request: Request) => publicApp.fetch(request);
  const open = (body: Record<string, unknown> = {}) =>
    sendOwner(
      new Request(`${owner}/api/mcp/pairings`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: owner },
        body: JSON.stringify({
          name: "ChatGPT",
          scopes: ["tasks:read"],
          resource_grants: fixtureResources,
          permission_modes: {},
          ...body,
        }),
      }),
    );
  const register = () =>
    sendMcp(
      new Request(`${mcp}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Self-described name", redirect_uris: [callback] }),
      }),
    );
  const authorizeParams = (clientId: string) => {
    const verifier = randomBytes(32).toString("base64url");
    return {
      verifier,
      params: {
        client_id: clientId,
        redirect_uri: callback,
        response_type: "code",
        resource: `${mcp}/mcp`,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        state: "s",
      },
    };
  };
  const page = (params: Record<string, string>) =>
    sendMcp(new Request(`${mcp}/oauth/authorize?${new URLSearchParams(params)}`));
  const submit = (body: Record<string, string>, origin: string | null = mcp) =>
    sendMcp(
      new Request(`${mcp}/oauth/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(origin ? { origin } : {}),
        },
        body: new URLSearchParams(body),
      }),
    );
  const requestId = async (response: Response) =>
    /name="request_id" value="([^"]+)"/.exec(await response.text())?.[1] ?? "";
  return {
    db,
    auth,
    cookie,
    sendOwner,
    sendMcp,
    open,
    register,
    authorizeParams,
    page,
    submit,
    requestId,
  };
}

test("MCP registration and authorization require an owner-opened pairing", async () => {
  const s = setup();
  try {
    expect((await s.register()).status).toBe(403);
    const opened = await s.open({ name: "My ChatGPT", keep_access: false });
    expect(opened.status).toBe(201);
    const pairing = (await opened.json()) as { pairing_code: string; mcp_url: string };
    expect(pairing.pairing_code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect(pairing.mcp_url).toBe(`${mcp}/mcp`);
    const registered = await s.register();
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string; client_name: string };
    expect(client.client_name).toBe("My ChatGPT");
    const { params, verifier } = s.authorizeParams(client.client_id);
    const form = await s.page(params);
    expect(form.status).toBe(200);
    expect(form.headers.get("referrer-policy")).toBe("same-origin");
    expect(form.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await form.clone().text();
    expect(html).toContain("chatgpt.example");
    expect(html).toContain("My ChatGPT");
    expect(html).not.toContain(owner);
    const id = await s.requestId(form);
    expect(
      (await s.submit({ request_id: id, pairing_code: pairing.pairing_code }, null)).status,
    ).toBe(403);
    expect(
      (
        await s.submit(
          { request_id: id, pairing_code: pairing.pairing_code },
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    const done = await s.submit({
      request_id: id,
      pairing_code: pairing.pairing_code.toLowerCase().replace("-", " "),
    });
    expect(done.status).toBe(303);
    const location = new URL(done.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(callback);
    expect(location.searchParams.get("iss")).toBe(mcp);
    expect(location.searchParams.get("state")).toBe("s");
    expect((await s.submit({ request_id: id, pairing_code: pairing.pairing_code })).status).toBe(
      400,
    );
    expect((await s.page(params)).status).toBe(403);
    expect((await s.register()).status).toBe(403);
    const token = await s.sendMcp(
      new Request(`${mcp}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          code: location.searchParams.get("code")!,
          redirect_uri: callback,
          code_verifier: verifier,
          resource: `${mcp}/mcp`,
        }),
      }),
    );
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    const principal = s.auth.principal(
      new Request(`${mcp}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
      true,
    );
    expect(principal?.scopes).toEqual(["tasks:read"]);
    expect(principal?.operator_name).toBe("My ChatGPT");
    s.db.query("UPDATE mcp_pairings SET register_until='2000-01-01',expires_at='2000-01-01'").run();
    const refreshed = await s.sendMcp(
      new Request(`${mcp}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
          resource: `${mcp}/mcp`,
        }),
      }),
    );
    expect(refreshed.status).toBe(200);
  } finally {
    s.db.close();
  }
});

test("pairing windows close on time, on replacement, on revocation and after failed codes", async () => {
  const s = setup();
  try {
    const first = (await (await s.open()).json()) as { pairing_id: string; pairing_code: string };
    const early = (await (await s.register()).json()) as { client_id: string };
    s.db
      .query("UPDATE mcp_pairings SET register_until='2000-01-01' WHERE id=?")
      .run(first.pairing_id);
    expect((await s.register()).status).toBe(403);
    const earlyForm = await s.page(s.authorizeParams(early.client_id).params);
    expect(earlyForm.status).toBe(200);
    const earlyId = await s.requestId(earlyForm);

    const second = (await (await s.open()).json()) as { pairing_id: string; pairing_code: string };
    expect((await s.submit({ request_id: earlyId, pairing_code: first.pairing_code })).status).toBe(
      400,
    );
    expect((await s.page(s.authorizeParams(early.client_id).params)).status).toBe(403);

    const client = (await (await s.register()).json()) as { client_id: string };
    const id = await s.requestId(await s.page(s.authorizeParams(client.client_id).params));
    for (let attempt = 1; attempt < 5; attempt++) {
      const wrong = await s.submit({ request_id: id, pairing_code: first.pairing_code });
      expect(wrong.status).toBe(400);
      expect(await wrong.text()).toContain(`${5 - attempt} attempts remain`);
    }
    expect((await s.submit({ request_id: id, pairing_code: first.pairing_code })).status).toBe(403);
    expect((await s.submit({ request_id: id, pairing_code: second.pairing_code })).status).toBe(
      400,
    );
    expect((await s.register()).status).toBe(403);

    const third = (await (await s.open()).json()) as { pairing_id: string };
    const revoked = await s.sendOwner(
      new Request(`${owner}/api/mcp/pairings/${third.pairing_id}/revoke`, {
        method: "POST",
        headers: { cookie: s.cookie, origin: owner },
      }),
    );
    expect(revoked.status).toBe(200);
    expect((await s.register()).status).toBe(403);
    const listed = (await (
      await s.sendOwner(new Request(`${owner}/api/mcp/pairings`, { headers: { cookie: s.cookie } }))
    ).json()) as { pairings: { state: string }[]; scopes: string[] };
    expect(listed.pairings.map((row) => row.state)).toEqual(["closed", "closed", "closed"]);
    expect(listed.scopes).not.toContain("admin");
  } finally {
    s.db.close();
  }
});

test("only the browser owner opens pairings with MCP scopes and visible names", async () => {
  const s = setup();
  try {
    const api = await fixtureApiToken(owner, s.cookie, ["admin"], s.sendOwner);
    const viaApi = await s.sendOwner(
      new Request(`${owner}/api/mcp/pairings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${api}` },
        body: JSON.stringify({
          name: "API",
          scopes: ["tasks:read"],
          resource_grants: fixtureResources,
          permission_modes: {},
        }),
      }),
    );
    expect(viaApi.status).toBe(403);
    expect((await s.open({ scopes: ["admin"] })).status).toBe(400);
    expect((await s.open({ scopes: ["sessions:identity"] })).status).toBe(400);
    expect((await s.open({ scopes: [] })).status).toBe(400);
    expect((await s.open({ name: "Chat‮GPT" })).status).toBe(400);
    expect((await s.open({ permission_modes: { "tasks:read": "approval" } })).status).toBe(400);
    expect(
      (
        await s.open({
          scopes: ["sessions:read", "sessions:launch"],
          permission_modes: { "sessions:launch": "approval" },
        })
      ).status,
    ).toBe(201);
    const client = (await (await s.register()).json()) as { client_id: string };
    expect(
      (
        await s.sendOwner(
          new Request(
            `${owner}/api/oauth/request?${new URLSearchParams(s.authorizeParams(client.client_id).params)}`,
            { headers: { cookie: s.cookie } },
          ),
        )
      ).status,
    ).toBe(400);
    const grant = await fixtureMcpAuthorization(owner, s.cookie, {
      scopes: ["sessions:read", "sessions:launch"],
      modes: { "sessions:launch": "approval" },
      mcpOrigin: mcp,
      sendOwner: s.sendOwner,
      sendMcp: s.sendMcp,
    });
    const grantRow = s.db
      .query(
        "SELECT scopes,permissions FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE c.id=?",
      )
      .get(grant.client.client_id) as { scopes: string; permissions: string };
    expect(JSON.parse(grantRow.scopes)).toEqual([
      "sessions:read",
      "sessions:launch",
      "offline_access",
    ]);
    expect(JSON.parse(grantRow.permissions)).toEqual({ "sessions:launch": "approval" });
  } finally {
    s.db.close();
  }
});

test("the public authorization page has a global rate limit", async () => {
  const s = setup();
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++)
      statuses.push(
        (
          await s.sendMcp(
            new Request(`${mcp}/oauth/authorize?client_id=none`, {
              headers: { "x-fixture": String(i) },
            }),
          )
        ).status,
      );
    expect(statuses.slice(0, 30).every((status) => status === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await s.submit({ request_id: "x", pairing_code: "x" })).status).toBe(429);
  } finally {
    s.db.close();
  }
});
