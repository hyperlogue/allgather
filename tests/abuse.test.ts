import { expect, test } from "bun:test";
import { createApp, Updates } from "../server/app.ts";
import { Auth } from "../server/auth.ts";
import { RateLimits } from "../server/rate-limits.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";

test("bounded rate entries never impose a global lockout on new callers", () => {
  let time = 0;
  const rates = new RateLimits(20, () => time);
  rates.take("attacker", 1);
  expect(() => rates.take("attacker", 1)).toThrow("Too many requests");
  for (let i = 0; i < 1000; i++) rates.take(`ip-${i}`, 1);
  expect(() => rates.take("owner", 2)).not.toThrow();
  rates.take("owner", 2);
  expect(() => rates.take("owner", 2)).toThrow("Too many requests");
  rates.take("other", 1);
  time = 60000;
  expect(() => rates.take("owner", 2)).not.toThrow();
});

test("registration floods recycle only ungranted clients and expired registrations cannot gain consent", () => {
  const db = openDatabase(":memory:"),
    auth = new Auth(db, "https://owner.example");
  db.query(
    "INSERT INTO mcp_pairings(id,code_hash,name,scopes,resources,permissions,owner,created_at,register_until,expires_at) VALUES('pairing-test','hash','Flood fixture','[]','{}','{}','owner','2000-01-01','2099-01-01','2099-01-01')",
  ).run();
  const pairing = { id: "pairing-test", name: "Flood fixture" };
  const input = { redirect_uris: ["https://connector.example/callback"] };
  try {
    const granted = auth.register(input, pairing);
    db.query(
      "INSERT INTO oauth_tokens(hash,client_id,scopes,expires,refresh_expires,resource) VALUES('granted',?,'[\"tasks:read\"]','2099-01-01','2099-01-01',?)",
    ).run(granted.client_id, auth.apiResource);
    const expired = auth.register(input, pairing);
    db.query("UPDATE oauth_clients SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(
      expired.client_id,
    );
    expect(auth.client(expired.client_id)).toBeNull();
    for (let i = 0; i < 300; i++) auth.register(input, pairing);
    expect(db.query("SELECT COUNT(*) n FROM oauth_clients").get()).toEqual({ n: 257 });
    expect(auth.client(granted.client_id)).not.toBeNull();
    expect(db.query("SELECT 1 FROM oauth_clients WHERE id=?").get(expired.client_id)).toBeNull();
    expect(auth.client(auth.register(input, pairing).client_id)).not.toBeNull();
  } finally {
    db.close();
  }
});

test("anonymous auth and MCP bodies have a small streaming limit and rate responses advertise retry", async () => {
  const db = openDatabase(":memory:"),
    auth = new Auth(db, "https://owner.example");
  const app = createApp(new Workspace(db), auth, new Updates(), {
    peer: (r) => r.headers.get("fixture-peer") ?? "fixture",
  });
  try {
    for (const path of [
      "/api/passkeys/register/options",
      "/oauth/register",
      "/api/cli/pairings/claim",
      "/oauth/token",
      "/oauth/revoke",
      "/api/tower/enrollments",
      "/mcp",
    ]) {
      for (const streaming of [false, true]) {
        const bytes = new TextEncoder().encode(JSON.stringify({ data: "x".repeat(20 * 1024) }));
        const body = streaming
          ? new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            })
          : bytes;
        const response = await app.fetch(
          new Request(auth.baseUrl + path, {
            method: "POST",
            body,
            headers: {
              "content-type": "application/json",
              ...(streaming ? {} : { "content-length": String(bytes.length) }),
            },
          }),
        );
        expect(response.status).toBe(413);
      }
    }
    const login = (peer: string) =>
      app.fetch(
        new Request(auth.baseUrl + "/api/passkeys/register/options", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "fixture-peer": peer,
            origin: auth.baseUrl,
          },
          body: '{"token":"invalid"}',
        }),
      );
    for (let i = 0; i < 20; i++) expect((await login("abusive")).status).toBe(401);
    const limited = await login("abusive");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await login("owner")).status).toBe(401);
  } finally {
    db.close();
  }
});
