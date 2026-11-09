import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureRegisterPasskey, syntheticPasskey } from "../scripts/fixture-passkey.ts";
import { createApp, Updates } from "../server/app.ts";
import { Auth, hash, isBrowserOwner, revokeCredentials, secret } from "../server/auth.ts";
import { browserIdleMs } from "../server/browser-auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import { restoreBrowserSchema34 } from "./fixtures/session-schema.ts";

function setup() {
  const db = openDatabase(":memory:"),
    auth = new Auth(db, "https://owner.example", "https://mcp.example");
  const app = createApp(new Workspace(db), auth, new Updates());
  const post = (path: string, body: unknown, cookie?: string, origin = auth.baseUrl) =>
    app.fetch(
      new Request(auth.baseUrl + path, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  const start = async (url: string) => {
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get("key");
    const response = await post("/api/passkeys/register/options", { token });
    expect(response.status).toBe(200);
    return {
      options: await response.json(),
      cookie: response.headers.get("set-cookie")!.split(";")[0],
      token,
    };
  };
  const session = (cookie: string) =>
    new Request(auth.baseUrl + "/api/session", { headers: { cookie } });
  return { db, auth, app, post, start, session };
}

test("enrollment links are fragment-only, expire in five minutes, and grant no session until verified passkey creation", async () => {
  const s = setup();
  try {
    const link = s.auth.browser.createLink("Laptop");
    expect(Date.parse(link.expires_at) - Date.now()).toBeGreaterThan(299000);
    expect(Date.parse(link.expires_at) - Date.now()).toBeLessThanOrEqual(300000);
    const url = new URL(link.url);
    expect(url.pathname).toBe("/welcome");
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#key=[A-Za-z0-9_-]{43}$/);
    await s.app.fetch(new Request(s.auth.baseUrl + "/welcome"));
    const a = await s.start(link.url),
      b = await s.start(link.url);
    expect(a.options.authenticatorSelection.userVerification).toBe("required");
    expect(a.options.authenticatorSelection.residentKey).toBe("required");
    expect(s.auth.principal(s.session(a.cookie))).toBeNull();
    expect((await s.post("/api/operations/projects_list", {}, a.cookie)).status).toBe(401);
    expect(s.db.query("SELECT consumed_at FROM login_tokens WHERE id=?").get(link.id)).toEqual({
      consumed_at: null,
    });
    const key = syntheticPasskey();
    const response = key.register(a.options, s.auth.baseUrl);
    expect((await s.post("/api/passkeys/register/verify", { response }, b.cookie)).status).toBe(
      401,
    );
    const finish = await s.post("/api/passkeys/register/verify", { response }, a.cookie);
    expect(finish.status).toBe(200);
    const header = finish.headers.get("set-cookie")!;
    expect(header).toContain("HttpOnly; SameSite=Strict");
    expect(header).toContain("Secure");
    const cookie = header.split(";")[0];
    expect(s.auth.principal(s.session(cookie))?.inlet).toBe("browser");
    expect((await s.post("/api/passkeys/register/options", { token: a.token })).status).toBe(401);
    expect((await s.post("/api/passkeys/register/verify", { response }, a.cookie)).status).toBe(
      401,
    );
    expect(JSON.stringify(s.db.query("SELECT * FROM login_tokens").all())).not.toContain(a.token);
    expect(JSON.stringify(s.db.query("SELECT * FROM sessions").all())).not.toContain(
      cookie.split("=")[1],
    );
  } finally {
    s.db.close();
  }
});

test("registration rejects wrong origin, RP, challenge, missing user verification and expired links", async () => {
  const s = setup();
  try {
    for (const failure of ["origin", "rp", "challenge", "verification", "expired", "reset"]) {
      const link = s.auth.browser.createLink();
      const pending = await s.start(link.url);
      const key = syntheticPasskey();
      const options = structuredClone(pending.options);
      if (failure === "rp") options.rp.id = "other.example";
      if (failure === "challenge") options.challenge = secret();
      const response = key.register(
        options,
        failure === "origin" ? "https://other.example" : s.auth.baseUrl,
        failure !== "verification",
      );
      if (failure === "expired")
        s.db.query("UPDATE login_tokens SET expires_at='2000-01-01' WHERE id=?").run(link.id);
      if (failure === "reset") revokeCredentials(s.db);
      expect(
        (await s.post("/api/passkeys/register/verify", { response }, pending.cookie)).status,
      ).toBe(401);
      expect(s.db.query("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 0 });
    }
    const link = s.auth.browser.createLink();
    const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get("key");
    expect(
      (
        await s.post(
          "/api/passkeys/register/options",
          { token },
          undefined,
          "https://other.example",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await s.app.fetch(
          new Request(s.auth.baseUrl + "/api/passkeys/authenticate/options", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
  } finally {
    s.db.close();
  }
});

test("returning users must prove possession and user verification with a fresh browser-bound challenge", async () => {
  const s = setup();
  try {
    const pending = await s.start(s.auth.browser.createLink().url),
      key = syntheticPasskey();
    expect(
      (
        await s.post(
          "/api/passkeys/register/verify",
          { response: key.register(pending.options, s.auth.baseUrl) },
          pending.cookie,
        )
      ).status,
    ).toBe(200);
    for (const failure of ["signature", "handle", "verification", "success"]) {
      const start = await s.post("/api/passkeys/authenticate/options", {});
      const options = await start.json();
      expect(options.allowCredentials ?? []).toEqual([]);
      const cookie = start.headers.get("set-cookie")!.split(";")[0];
      const response = key.authenticate(options, s.auth.baseUrl, failure !== "verification");
      if (failure === "signature")
        response.response.signature = Buffer.alloc(64).toString("base64url");
      if (failure === "handle") response.response.userHandle = secret();
      const finish = await s.post("/api/passkeys/authenticate/verify", { response }, cookie);
      expect(finish.status).toBe(failure === "success" ? 200 : 401);
      if (failure === "success") {
        expect(
          s.auth.principal(s.session(finish.headers.get("set-cookie")!.split(";")[0])),
        ).not.toBeNull();
        expect(
          (await s.post("/api/passkeys/authenticate/verify", { response }, cookie)).status,
        ).toBe(401);
      }
    }
    s.auth.browser.revoke(key.id);
    const start = await s.post("/api/passkeys/authenticate/options", {});
    expect(
      (
        await s.post(
          "/api/passkeys/authenticate/verify",
          { response: key.authenticate(await start.json(), s.auth.baseUrl) },
          start.headers.get("set-cookie")!.split(";")[0],
        )
      ).status,
    ).toBe(401);
    expect(s.db.query("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 0 });
  } finally {
    s.db.close();
  }
});

test("sessions roll forward with activity without an absolute lifetime and cannot revive after inactivity or revocation", async () => {
  const s = setup();
  try {
    const cookie = await fixtureRegisterPasskey(s.auth.browser.createLink().url, (r) =>
      s.app.fetch(r),
    );
    const sessionHash = hash(cookie.split("=")[1]);
    s.db.exec("UPDATE passkeys SET created_at='2000-01-01'");
    s.db
      .query("UPDATE sessions SET last_used_at=?,expires=?")
      .run(
        new Date(Date.now() - 29 * 86400000).toISOString(),
        new Date(Date.now() + 86400000).toISOString(),
      );
    const principal = s.auth.principal(s.session(cookie))!;
    expect(isBrowserOwner(s.db, principal)).toBe(true);
    const response = await s.app.fetch(s.session(cookie));
    expect((await response.json()).authenticated).toBe(true);
    expect(response.headers.get("set-cookie")).toContain(`Max-Age=${browserIdleMs / 1000}`);
    const row = s.db.query("SELECT expires FROM sessions WHERE hash=?").get(sessionHash) as {
      expires: string;
    };
    expect(Date.parse(row.expires) - Date.now()).toBeGreaterThan(browserIdleMs - 1000);
    s.db.exec("UPDATE sessions SET expires='2000-01-01'");
    expect(s.auth.principal(s.session(cookie))).toBeNull();
    expect(isBrowserOwner(s.db, principal)).toBe(false);
    expect((await s.app.fetch(s.session(cookie))).headers.get("set-cookie")).toBeNull();
  } finally {
    s.db.close();
  }
});

test("old passwordless code endpoints are removed and the public MCP listener cannot enroll or authenticate browsers", async () => {
  const s = setup();
  try {
    for (const path of ["/api/login", "/api/login-tokens"])
      expect((await s.post(path, { key: secret() })).status).toBe(404);
    const app = createApp(new Workspace(s.db), s.auth, new Updates(), { surface: "public" });
    for (const path of [
      "/welcome",
      "/api/passkeys",
      "/api/passkeys/register/options",
      "/api/passkeys/authenticate/options",
    ])
      expect((await app.fetch(new Request(s.auth.mcpBaseUrl + path))).status).toBe(404);
  } finally {
    s.db.close();
  }
});

test("upgrading retires code-based browser sessions and links without deleting application data", () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-passkey-upgrade-"));
  const path = join(root, "data.sqlite");
  let db = openDatabase(path);
  try {
    const auth = new Auth(db, "https://owner.example");
    const link = auth.browser.createLink();
    restoreBrowserSchema34(db);
    db.query("INSERT INTO sessions(hash,expires,token_id) VALUES('old','2099-01-01',?)").run(
      link.id,
    );
    db.query("INSERT INTO settings(key,value) VALUES('retained','work')").run();
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT * FROM sessions").all()).toEqual([]);
    expect(
      (
        db.query("SELECT revoked_at FROM login_tokens WHERE id=?").get(link.id) as {
          revoked_at: string;
        }
      ).revoked_at,
    ).toBeTruthy();
    expect(db.query("SELECT value FROM settings WHERE key='retained'").get()).toEqual({
      value: "work",
    });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
