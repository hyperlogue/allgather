import { expect, test } from "bun:test";
import { fixtureBrowserCookie, fixtureRegisterPasskey } from "../scripts/fixture-passkey.ts";
import { createApp, Updates } from "../server/app.ts";
import { Auth } from "../server/auth.ts";
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
