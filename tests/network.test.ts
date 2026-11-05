import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../server/config.ts";
import { controlRequest } from "../server/control.ts";
import { startServer } from "../server/index.ts";
import { defaultPrivateNetworks, NetworkBoundary } from "../server/network.ts";

test("network identity follows only configured proxy hops and private ranges", () => {
  const direct = new NetworkBoundary([], defaultPrivateNetworks);
  const proxy = new NetworkBoundary(["127.0.0.1/32", "10.0.0.0/24"], defaultPrivateNetworks);
  const h = (value?: string) => new Headers(value ? { "x-forwarded-for": value } : {});
  expect(direct.client("198.51.100.2", h("100.64.0.3"))).toBe("198.51.100.2");
  expect(proxy.client("127.0.0.1", h("100.64.0.3, 198.51.100.2"))).toBe("198.51.100.2");
  expect(proxy.client("127.0.0.1", h("100.64.0.3, 10.0.0.2"))).toBe("100.64.0.3");
  expect(proxy.client("::ffff:127.0.0.1", h("100.64.0.3"))).toBe("100.64.0.3");
  for (const value of [undefined, "unknown", "100.64.0.3,", "for=100.64.0.3", "127.0.0.1:80"])
    expect(proxy.client("127.0.0.1", h(value))).toBeNull();
  for (const ip of ["127.0.0.1", "::1", "100.64.0.3", "fd7a:115c:a1e0::1"])
    expect(direct.allowsPrivate(ip)).toBe(true);
  for (const ip of [null, "198.51.100.2", "10.1.0.1", "100.128.0.1", "fd00::1"])
    expect(direct.allowsPrivate(ip)).toBe(false);
  expect(() => config({ trustedProxies: ["hostname.example"] })).toThrow("Invalid network");
  expect(() => config({ privateNetworks: ["127.0.0.1/33"] })).toThrow("Invalid network");
  expect(() =>
    config({ mcpUrl: "https://owner.example", ownerUrl: "https://owner.example" }),
  ).toThrow("must differ");
});

test("public listener only serves MCP/OAuth and completes consent through the private owner app", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-network-"));
  const running = await startServer({
    dataDir: root,
    hostname: "127.0.0.1",
    port: 0,
    ownerUrl: "https://owner.example",
    mcpHostname: "127.0.0.1",
    mcpPort: 0,
    mcpUrl: "https://mcp.example",
    trustedProxies: ["127.0.0.1/32"],
    gitSyncSeconds: 0,
  });
  const request = (
    surface: "private" | "public",
    path: string,
    init: RequestInit = {},
    client = surface === "private" ? "100.64.0.2" : "198.51.100.2",
  ) =>
    fetch(
      `http://127.0.0.1:${surface === "private" ? running.settings.port : running.settings.mcpPort}${path}`,
      {
        ...init,
        headers: {
          host: surface === "private" ? "owner.example" : "mcp.example",
          "x-forwarded-for": client,
          ...init.headers,
        },
        redirect: "manual",
      },
    );
  const post = (body: unknown, headers = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  try {
    expect((await request("private", "/api/session", {}, "198.51.100.2")).status).toBe(403);
    expect((await request("private", "/api/session", {}, "100.64.0.2, 198.51.100.2")).status).toBe(
      403,
    );
    expect((await request("private", "/api/session")).status).toBe(200);
    for (const path of [
      "/",
      "/api/session",
      "/api/login",
      "/api/backup",
      "/api/operations/projects_list",
      "/api/tower/enrollments",
      "/tower",
      "/oauth/authorize",
      "/artifact-workspace/item",
      "/__r3_preview/item",
      "/health",
    ]) {
      for (const method of ["GET", "POST"])
        expect((await request("public", path, { method })).status).toBe(404);
    }
    const metadata = (await (
      await request("public", "/.well-known/oauth-authorization-server")
    ).json()) as any;
    expect(metadata.issuer).toBe("https://mcp.example");
    expect(metadata.authorization_endpoint).toBe("https://owner.example/oauth/authorize");
    expect(metadata.token_endpoint).toBe("https://mcp.example/oauth/token");
    expect(metadata.scopes_supported).not.toContain("admin");
    const denied = await request("public", "/mcp");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("https://mcp.example/.well-known/");
    const loginCode = (await (await controlRequest(root, "auth/create-token", {})).json()) as any;
    const login = await request("private", "/api/login", post({ key: loginCode.token }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const client = (await (
      await request(
        "public",
        "/oauth/register",
        post({
          client_name: "Remote fixture",
          redirect_uris: ["https://connector.example/callback"],
        }),
      )
    ).json()) as any;
    const verifier = "a".repeat(43);
    const params = {
      client_id: client.client_id,
      redirect_uri: "https://connector.example/callback",
      response_type: "code",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: "https://mcp.example/mcp",
      scope: "tasks:read offline_access",
      state: "fixture-state",
    };
    const grantResponse = await request(
      "private",
      "/api/oauth/authorize",
      post(params, { cookie, origin: "https://owner.example" }),
    );
    expect(grantResponse.status).toBe(200);
    const grant = (await grantResponse.json()) as any;
    const callback = new URL(grant.redirect_uri);
    expect(callback.searchParams.get("iss")).toBe("https://mcp.example");
    const exchange = {
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: params.redirect_uri,
      code: callback.searchParams.get("code")!,
      code_verifier: verifier,
      resource: params.resource,
    };
    const tokenResponse = await request("public", "/oauth/token", {
      method: "POST",
      body: new URLSearchParams(exchange),
    });
    expect(tokenResponse.status).toBe(200);
    const token = (await tokenResponse.json()) as any;
    const headers = {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const initialized = await request(
      "public",
      "/mcp",
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "fixture", version: "1" },
          },
        },
        headers,
      ),
    );
    expect(initialized.status).toBe(200);
    expect(
      (await request("private", "/api/operations/projects_list", post({}, headers))).status,
    ).toBe(401);
    expect(
      (
        await request("public", "/oauth/token", {
          method: "POST",
          body: new URLSearchParams({ ...exchange, resource: "https://owner.example/api" }),
        })
      ).status,
    ).toBe(400);
    expect((await request("public", "/api/session", { headers: { cookie } })).status).toBe(404);
    expect(
      (
        await request("public", "/.well-known/oauth-authorization-server", {
          headers: { host: "owner.example" },
        })
      ).status,
    ).toBe(403);
  } finally {
    await running.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
