import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureMcpAuthorization } from "../scripts/fixture-auth.ts";
import { fixtureRegisterPasskey } from "../scripts/fixture-passkey.ts";
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
  expect(() => config({ ownerTrustedProxies: ["hostname.example"] })).toThrow("Invalid network");
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
    ownerTrustedProxies: ["127.0.0.1/32"],
    mcpTrustedProxies: ["127.0.0.1/32"],
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
    for (const path of ["/api/session", "/tower", "/__r3_preview/item", "/"]) {
      for (const name of ["Tailscale-Funnel-Request", "Cf-Connecting-Ip", "Cf-Ray"])
        expect((await request("private", path, { headers: { [name]: "" } })).status).toBe(403);
      for (const host of [
        "mcp.example",
        `127.0.0.1:${running.settings.port}`,
        "owner.example.evil.invalid",
      ])
        expect((await request("private", path, { headers: { host } })).status).toBe(403);
    }
    expect(
      (
        await request("public", "/.well-known/oauth-authorization-server", {
          headers: { host: `127.0.0.1:${running.settings.mcpPort}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("public", "/.well-known/oauth-authorization-server", {
          headers: { "cf-ray": "fixture" },
        })
      ).status,
    ).toBe(200);

    for (const path of [
      "/",
      "/api/session",
      "/api/login",
      "/api/backup",
      "/api/operations/projects_list",
      "/api/tower/enrollments",
      "/api/tower/invitations",
      "/tower",
      "/oauth/register-cli",
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
    expect(metadata.authorization_endpoint).toBe("https://mcp.example/oauth/authorize");
    expect(JSON.stringify(metadata)).not.toContain("owner.example");
    expect(
      JSON.stringify(
        await (await request("public", "/.well-known/oauth-protected-resource")).json(),
      ),
    ).not.toContain("owner.example");
    expect(metadata.token_endpoint).toBe("https://mcp.example/oauth/token");
    expect(metadata.scopes_supported).not.toContain("admin");
    const denied = await request("public", "/mcp");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("https://mcp.example/.well-known/");
    expect(
      (
        await request(
          "public",
          "/oauth/register",
          post({ redirect_uris: ["https://connector.example/callback"] }),
        )
      ).status,
    ).toBe(403);
    const loginLink = (await (await controlRequest(root, "auth/login", {})).json()) as {
      url: string;
    };
    const via = (surface: "private" | "public") => async (r: Request) => {
      const url = new URL(r.url);
      return request(surface, url.pathname + url.search, {
        method: r.method,
        headers: Object.fromEntries(r.headers),
        body: r.method === "GET" ? undefined : await r.text(),
      });
    };
    const cookie = await fixtureRegisterPasskey(loginLink.url, via("private"));
    const grant = await fixtureMcpAuthorization("https://owner.example", cookie, {
      scopes: ["tasks:read"],
      mcpOrigin: "https://mcp.example",
      redirectUri: "https://connector.example/callback",
      state: "fixture-state",
      sendOwner: via("private"),
      sendMcp: via("public"),
    });
    const callback = grant.redirect;
    expect(callback.searchParams.get("iss")).toBe("https://mcp.example");
    expect(callback.searchParams.get("state")).toBe("fixture-state");
    const client = grant.client;
    const params = grant.params;
    const exchange = {
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: params.redirect_uri,
      code: grant.code,
      code_verifier: grant.verifier,
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

test("public proxy trust is required independently and cannot lock out an unproxied owner listener", async () => {
  expect(() => config({ mcpUrl: "https://mcp.example", mcpTrustedProxies: [] })).toThrow(
    "MCP_TRUSTED_PROXIES",
  );
  expect(() =>
    config({
      mcpUrl: "https://mcp.example",
      ownerTrustedProxies: ["127.0.0.1"],
      mcpTrustedProxies: [],
    }),
  ).toThrow("MCP_TRUSTED_PROXIES");
  expect(() => config({ mcpUrl: "http://127.0.0.1:0", mcpTrustedProxies: [] })).not.toThrow();
  expect(() =>
    config({ mcpUrl: "https://127.0.0.1", mcpHostname: "0.0.0.0", mcpTrustedProxies: [] }),
  ).toThrow("MCP_TRUSTED_PROXIES");
  expect(() => config({ mcpTrustedProxies: ["invalid"] })).toThrow("Invalid network");
  const root = mkdtempSync(join(tmpdir(), "allgather-separate-proxies-"));
  const running = await startServer({
    dataDir: root,
    port: 0,
    ownerUrl: "http://localhost:0",
    mcpPort: 0,
    mcpUrl: "https://mcp.example",
    ownerTrustedProxies: [],
    mcpTrustedProxies: ["127.0.0.1/32"],
    gitSyncSeconds: 0,
  });
  try {
    expect((await fetch(running.settings.ownerUrl + "/api/session")).status).toBe(200);
    expect(
      (
        await fetch(running.settings.ownerUrl + "/api/session", {
          headers: { "x-forwarded-for": "198.51.100.5" },
        })
      ).status,
    ).toBe(200);
    const url = `http://127.0.0.1:${running.settings.mcpPort}/.well-known/oauth-authorization-server`;
    expect((await fetch(url, { headers: { host: "mcp.example" } })).status).toBe(403);
    expect(
      (await fetch(url, { headers: { host: "mcp.example", "x-forwarded-for": "198.51.100.5" } }))
        .status,
    ).toBe(200);
  } finally {
    await running.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
