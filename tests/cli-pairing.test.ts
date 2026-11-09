import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../cli/client.ts";
import { fixtureBrowserCookie } from "../scripts/fixture-passkey.ts";
import { createApp, Updates } from "../server/app.ts";
import { Auth, hash, revokeCredentials, secret } from "../server/auth.ts";
import { openDatabase, SCHEMA_VERSION } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import { restoreSessionSchema31 } from "./fixtures/session-schema.ts";

function setup() {
  const db = openDatabase(":memory:");
  const auth = new Auth(db, "https://owner.example", "https://mcp.example");
  const app = createApp(new Workspace(db), auth, new Updates());
  const cookie = fixtureBrowserCookie(db);
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(auth.baseUrl + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const owner = { cookie, origin: auth.baseUrl };
  const input = {
    name: "Remote CLI",
    scopes: ["tasks:read"],
    resource_grants: { project_ids: [], machine_ids: [], unassigned: true },
    permission_modes: {},
  };
  const open = async () => {
    const response = await request("/api/cli/pairings", input, owner);
    expect(response.status).toBe(201);
    return response.json();
  };
  const principal = (token: string) =>
    auth.principal(new Request(auth.baseUrl, { headers: { authorization: `Bearer ${token}` } }));
  return { db, auth, request, owner, input, open, principal };
}

test("CLI pairing issues only browser-selected grants, retries privately, and confirms durable storage", async () => {
  const s = setup();
  try {
    const opened = await s.open();
    const body = { pairing_code: opened.pairing_code, request_id: secret() };
    const response = await s.request("/api/cli/pairings/claim", body);
    expect(response.status).toBe(200);
    const tokens = await response.json();
    expect(s.principal(tokens.access_token)?.scopes).toEqual(["tasks:read"]);
    expect(s.principal(tokens.access_token)?.resources).toEqual(s.input.resource_grants);
    expect(
      s.auth.principal(
        new Request(s.auth.resource, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
        true,
      ),
    ).toBeNull();
    expect(
      (await s.request("/api/cli/pairings/claim", { ...body, request_id: secret() })).status,
    ).toBe(409);
    expect(await (await s.request("/api/cli/pairings/claim", body)).json()).toEqual(tokens);
    expect(
      (await s.request("/api/cli/pairings/claim", { ...body, scopes: ["admin"] })).status,
    ).toBe(400);
    const listing = await (await s.request("/api/cli/pairings", undefined, s.owner)).json();
    expect(listing.pairings[0].state).toBe("claimed");
    expect(JSON.stringify(listing)).not.toContain(opened.pairing_code);
    expect(JSON.stringify(s.db.query("SELECT * FROM cli_pairings").all())).not.toContain(
      opened.pairing_code,
    );
    expect(JSON.stringify(s.db.query("SELECT * FROM oauth_tokens").all())).not.toContain(
      tokens.access_token,
    );
    expect(
      (
        await s.request(
          `/api/cli/pairings/${opened.pairing_id}/confirm`,
          {},
          { authorization: "Bearer wrong" },
        )
      ).status,
    ).toBe(401);
    const headers = { authorization: `Bearer ${tokens.access_token}` };
    expect(
      (await s.request(`/api/cli/pairings/${opened.pairing_id}/confirm`, {}, headers)).status,
    ).toBe(200);
    expect(
      (await s.request(`/api/cli/pairings/${opened.pairing_id}/confirm`, {}, headers)).status,
    ).toBe(200);
    expect((await s.request("/api/cli/pairings/claim", body)).status).toBe(409);
    expect(
      (await (await s.request("/api/cli/pairings", undefined, s.owner)).json()).pairings[0].state,
    ).toBe("connected");
    s.db.exec("UPDATE cli_pairings SET expires_at='2000-01-01'");
    expect(s.principal(tokens.access_token)).not.toBeNull();
    s.auth.revoke(tokens.client_id);
    expect(s.principal(tokens.access_token)).toBeNull();
    expect(
      (await (await s.request("/api/cli/pairings", undefined, s.owner)).json()).pairings[0].state,
    ).toBe("closed");
  } finally {
    s.db.close();
  }
});

test("CLI pairing requires a live owner browser, and expiry, cancellation, and recovery close claims", async () => {
  const s = setup();
  try {
    expect((await s.request("/api/cli/pairings", s.input)).status).toBe(403);
    expect((await s.request("/api/cli/pairings", s.input, { cookie: s.owner.cookie })).status).toBe(
      403,
    );
    expect(
      (await s.request("/api/cli/pairings/claim", { pairing_code: secret(), request_id: secret() }))
        .status,
    ).toBe(401);
    for (const action of ["expire", "cancel", "reset"]) {
      const opened = await s.open();
      const body = { pairing_code: opened.pairing_code, request_id: secret() };
      const tokens = await (await s.request("/api/cli/pairings/claim", body)).json();
      if (action === "expire")
        s.db
          .query("UPDATE cli_pairings SET expires_at='2000-01-01' WHERE id=?")
          .run(opened.pairing_id);
      if (action === "cancel")
        expect(
          (await s.request(`/api/cli/pairings/${opened.pairing_id}/revoke`, {}, s.owner)).status,
        ).toBe(200);
      if (action === "reset") revokeCredentials(s.db);
      expect(s.principal(tokens.access_token)).toBeNull();
      expect((await s.request("/api/cli/pairings/claim", body)).status).toBe(401);
      expect(
        (
          await s.request(
            `/api/cli/pairings/${opened.pairing_id}/confirm`,
            {},
            { authorization: `Bearer ${tokens.access_token}` },
          )
        ).status,
      ).toBe(401);
    }
  } finally {
    s.db.close();
  }
});

test("CLI pairing replaces callback routes and is excluded from the public listener", async () => {
  const s = setup();
  try {
    for (const [path, body] of [
      ["/oauth/register-cli", {}],
      ["/api/oauth/request", undefined],
      ["/api/oauth/authorize", {}],
    ] as const)
      expect((await s.request(path, body, s.owner)).status).toBe(404);
    const app = createApp(new Workspace(s.db), s.auth, new Updates(), { surface: "public" });
    for (const path of [
      "/api/cli/pairings",
      "/api/cli/pairings/claim",
      "/api/cli/pairings/test/confirm",
    ])
      expect(
        (await app.fetch(new Request(s.auth.mcpBaseUrl + path, { method: "POST", body: "{}" })))
          .status,
      ).toBe(404);
  } finally {
    s.db.close();
  }
});

test("v30 upgrade preserves existing CLI tokens and retires pending callback grants", () => {
  const dir = mkdtempSync(join(tmpdir(), "allgather-cli-upgrade-"));
  const path = join(dir, "data.sqlite");
  let db = openDatabase(path);
  try {
    db.query(
      "INSERT INTO oauth_clients(id,name,redirects,method,created_at,audience) VALUES('legacy','Legacy','[]','none',?,'api')",
    ).run(new Date().toISOString());
    db.query(
      "INSERT INTO oauth_grants(id,client_id,resource,scopes,resources,created_at) VALUES('legacy-grant','legacy','https://owner.example/api','[\"tasks:read\"]','{\"project_ids\":[],\"machine_ids\":[],\"unassigned\":true}',?)",
    ).run(new Date().toISOString());
    db.query(
      "INSERT INTO oauth_tokens(hash,client_id,scopes,expires,refresh_expires,resource,grant_id) VALUES(?,'legacy','[\"tasks:read\"]','2099-01-01','2099-01-01','https://owner.example/api','legacy-grant')",
    ).run(hash("legacy-token"));
    restoreSessionSchema31(db);
    db.exec(
      `INSERT INTO oauth_codes VALUES('old','{"client":{"id":"legacy"}}','2099-01-01'); DROP TABLE cli_pairings; PRAGMA user_version=30;`,
    );
    db.close();
    db = openDatabase(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.query("SELECT * FROM oauth_codes").all()).toEqual([]);
    const auth = new Auth(db, "https://owner.example");
    expect(
      auth.principal(
        new Request(auth.baseUrl, { headers: { authorization: "Bearer legacy-token" } }),
      )?.scopes,
    ).toEqual(["tasks:read"]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI retries lost claim and confirmation responses without duplicating grants or confirming before save", async () => {
  const s = setup();
  const directory = mkdtempSync(join(tmpdir(), "allgather-cli-retry-"));
  const previous = process.env.ALLGATHER_CONFIG_DIR;
  process.env.ALLGATHER_CONFIG_DIR = directory;
  const attempts = new Map<string, number>();
  const bodies: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(String(input), init);
        const path = new URL(request.url).pathname;
        const count = (attempts.get(path) ?? 0) + 1;
        attempts.set(path, count);
        if (path.endsWith("/claim")) bodies.push(String(init?.body));
        if (path.endsWith("/confirm")) {
          const saved = JSON.parse(readFileSync(join(directory, "credentials.json"), "utf8"))[
            s.auth.baseUrl
          ];
          expect(request.headers.get("authorization")).toBe(`Bearer ${saved.access_token}`);
        }
        const response = await s.request(
          path,
          JSON.parse(String(init?.body)),
          Object.fromEntries(request.headers),
        );
        if (count === 1) {
          if (path.endsWith("/claim")) throw new TypeError("Synthetic lost response");
          return new Response("Temporary gateway failure", { status: 503 });
        }
        return response;
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    const opened = await s.open();
    await new Client(s.auth.baseUrl).loginPairing(opened.pairing_code);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(s.db.query("SELECT COUNT(*) n FROM oauth_grants").get()).toEqual({ n: 1 });
    expect(
      (await (await s.request("/api/cli/pairings", undefined, s.owner)).json()).pairings[0].state,
    ).toBe("connected");
  } finally {
    fetcher.mockRestore();
    if (previous === undefined) delete process.env.ALLGATHER_CONFIG_DIR;
    else process.env.ALLGATHER_CONFIG_DIR = previous;
    s.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
