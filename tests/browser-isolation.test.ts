import { expect, test } from "bun:test";
import { fixtureBrowserCookie, fixtureRegisterPasskey } from "../scripts/fixture-passkey.ts";
import { createApp, Updates } from "../server/app.ts";
import { Auth } from "../server/auth.ts";
import { browserIdleMs } from "../server/browser-auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";

test("HTTPS browser cookies use the __Host- prefix and ignore unprefixed copies", async () => {
  for (const [origin, session, ceremony] of [
    ["https://owner.example", "__Host-allgather_session", "__Host-allgather_ceremony"],
    ["http://localhost:4390", "allgather_session", "allgather_ceremony"],
  ]) {
    const db = openDatabase(":memory:"),
      auth = new Auth(db, origin);
    const app = createApp(new Workspace(db), auth, new Updates());
    try {
      const headers: string[] = [];
      const cookie = await fixtureRegisterPasskey(
        auth.browser.createLink().url,
        async (request) => {
          const response = await app.fetch(request);
          const header = response.headers.get("set-cookie");
          if (header) headers.push(header);
          return response;
        },
      );
      expect(headers[0]).toStartWith(`${ceremony}=`);
      expect(headers.at(-1)).toStartWith(`${session}=`);
      for (const header of headers)
        expect(header).toContain(origin.startsWith("https:") ? "; Path=/;" : "; Path=/");
      if (origin.startsWith("https:"))
        for (const header of headers) expect(header).toContain("; Secure");
      const status = async (cookie: string) => {
        const response = await app.fetch(
          new Request(`${origin}/api/session`, { headers: { cookie } }),
        );
        return (await response.json()).authenticated;
      };
      expect(await status(cookie)).toBe(true);
      if (origin.startsWith("https:"))
        expect(await status(cookie.replace("__Host-", ""))).toBe(false);
    } finally {
      db.close();
    }
  }
});

test("cookie-bearing requests from other sites are rejected except top-level navigations", async () => {
  const db = openDatabase(":memory:"),
    auth = new Auth(db, "https://owner.example");
  const app = createApp(new Workspace(db), auth, new Updates());
  const cookie = fixtureBrowserCookie(db);
  const send = (headers: Record<string, string>, method = "GET", withCookie = true) =>
    app.fetch(
      new Request(`${auth.baseUrl}/api/session`, {
        method,
        headers: { ...(withCookie ? { cookie } : {}), ...headers },
      }),
    );
  try {
    for (const site of ["cross-site", "same-site"]) {
      for (const [mode, dest, method] of [
        ["cors", "empty", "GET"],
        ["no-cors", "image", "GET"],
        ["navigate", "iframe", "GET"],
        ["navigate", "document", "POST"],
      ]) {
        const response = await send(
          { "sec-fetch-site": site, "sec-fetch-mode": mode!, "sec-fetch-dest": dest! },
          method,
        );
        expect([site, mode, dest, method, response.status]).toEqual([
          site,
          mode,
          dest,
          method,
          403,
        ]);
        if (method === "GET") expect((await response.json()).error.code).toBe("forbidden_site");
      }
      expect(
        (
          await send({
            "sec-fetch-site": site,
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          })
        ).status,
      ).toBe(200);
      expect((await send({ "sec-fetch-site": site }, "GET", false)).status).toBe(200);
    }
    for (const site of ["same-origin", "none"])
      expect((await (await send({ "sec-fetch-site": site })).json()).authenticated).toBe(true);
    expect((await (await send({})).json()).authenticated).toBe(true);
  } finally {
    db.close();
  }
});

test("every application response carries the security headers, including pages and errors", async () => {
  const db = openDatabase(":memory:"),
    auth = new Auth(db, "https://owner.example");
  const app = createApp(new Workspace(db), auth, new Updates(), {
    assets: () =>
      new Response("<!doctype html>", {
        headers: { "content-type": "text/html", "cache-control": "no-cache" },
      }),
  });
  const cookie = fixtureBrowserCookie(db);
  const get = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(auth.baseUrl + path, init));
  try {
    for (const [path, init, frame, ancestors] of [
      ["/", {}, "DENY", "'none'"],
      ["/api/session", {}, "DENY", "'none'"],
      ["/health", {}, "DENY", "'none'"],
      ["/api/session", { headers: { origin: "https://elsewhere.example" } }, "DENY", "'none'"],
      ["/missing-route", { method: "POST" }, "DENY", "'none'"],
      ["/artifact-workspace/artifact_x", { headers: { cookie } }, "SAMEORIGIN", "'self'"],
      ["/oauth/authorize", {}, "DENY", "'none'"],
    ] as [string, RequestInit, string, string][]) {
      const response = await get(path, init),
        header = (name: string) => [path, name, response.headers.get(name)];
      expect(header("x-frame-options")).toEqual([path, "x-frame-options", frame]);
      expect(header("content-security-policy")).toEqual([
        path,
        "content-security-policy",
        expect.stringContaining(`frame-ancestors ${ancestors};`),
      ]);
      expect(header("x-content-type-options")).toEqual([path, "x-content-type-options", "nosniff"]);
      expect(header("cross-origin-resource-policy")).toEqual([
        path,
        "cross-origin-resource-policy",
        "same-origin",
      ]);
      expect(header("cross-origin-opener-policy")).toEqual([
        path,
        "cross-origin-opener-policy",
        path.startsWith("/oauth/") ? null : "same-origin",
      ]);
    }
    expect((await get("/")).headers.get("cache-control")).toBe("no-cache");
    expect((await get("/api/session")).headers.get("cache-control")).toBe("no-store");
  } finally {
    db.close();
  }
});

test("session renewal reaches the browser on pages and API responses alike", async () => {
  const db = openDatabase(":memory:"),
    auth = new Auth(db, "https://owner.example");
  const app = createApp(new Workspace(db), auth, new Updates(), {
    assets: () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
  });
  const cookie = fixtureBrowserCookie(db);
  const age = () =>
    db.query("UPDATE sessions SET last_used_at=?").run(new Date(Date.now() - 120000).toISOString());
  const renewal = async (path: string) =>
    (
      await app.fetch(new Request(auth.baseUrl + path, { headers: { cookie } }))
    ).headers.getSetCookie();
  try {
    for (const path of ["/", "/artifact-workspace/artifact_x", "/api/session"]) {
      age();
      expect([path, await renewal(path)]).toEqual([
        path,
        [`${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${browserIdleMs / 1000}; Secure`],
      ]);
      expect([path, await renewal(path)]).toEqual([path, []]);
    }
    age();
    const signOut = await app.fetch(
      new Request(`${auth.baseUrl}/api/logout`, {
        method: "POST",
        headers: { cookie, origin: auth.baseUrl },
      }),
    );
    expect(signOut.headers.getSetCookie()).toEqual([expect.stringContaining("Max-Age=0")]);
  } finally {
    db.close();
  }
});
