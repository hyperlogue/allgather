import { expect, test } from "bun:test";
import { createApp, Updates } from "../server/app.ts";
import { Auth, hash } from "../server/auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";

test("browser enrollment separates consent and polling, retries one key, and confirms durable installation", async () => {
  const db = openDatabase(":memory:"),
    origin = "http://127.0.0.1:4390";
  let now = Date.now();
  const w = new Workspace(db, () => new Date(now));
  const auth = new Auth(db, origin),
    app = createApp(w, auth, new Updates());
  const cookie = auth.signIn(auth.createLoginToken("Test").token).split(";")[0]!;
  const req = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const owner = { cookie, origin };
  try {
    const started = await req("/api/tower/enrollments", {
      host_id: "host-synthetic",
      tower_version: "test",
      requested_scopes: ["read", "send", "acp:control"],
    });
    expect(started.status).toBe(201);
    const e = await started.json(),
      path = `/api/tower/enrollments/${e.enrollment_id}`;
    const polling = { authorization: `Bearer ${e.polling_token}` };
    expect(e.authorization_url).not.toContain(e.polling_token);
    expect((await req(path)).status).toBe(403);
    expect((await req(`${path}/poll`, {}, { authorization: "Bearer wrong" })).status).toBe(401);
    expect(await (await req(`${path}/poll`, {}, polling)).json()).toMatchObject({
      state: "pending",
    });
    expect((await req(`${path}/poll`, {}, polling)).status).toBe(429);
    expect((await req(`${path}/decision`, { decision: "authorize" }, { cookie })).status).toBe(403);
    expect(
      (
        await req(
          `${path}/decision`,
          { decision: "authorize" },
          { ...owner, origin: "https://wrong.invalid" },
        )
      ).status,
    ).toBe(403);
    const decision = await req(
      `${path}/decision`,
      { decision: "authorize", node_label: "Synthetic node", scopes: ["read", "acp:control"] },
      owner,
    );
    expect(decision.status).toBe(200);
    now += 5000;
    const first = await (await req(`${path}/poll`, {}, polling)).json();
    expect(first).toMatchObject({
      state: "approved",
      node_label: "Synthetic node",
      scopes: ["read", "acp:control"],
    });
    now += 5000;
    expect(await (await req(`${path}/poll`, {}, polling)).json()).toEqual(first);
    expect(w.executions.authenticate(first.access_key)?.machine_id).toBe(first.machine_id);
    expect(
      (
        await req(
          "/api/operations/machines_list",
          {},
          { authorization: `Bearer ${first.access_key}` },
        )
      ).status,
    ).toBe(401);
    const body = { credential_id: first.credential_id, access_key_hash: hash(first.access_key) };
    expect(await (await req(`${path}/confirm`, body, polling)).json()).toMatchObject({
      state: "confirmed",
    });
    expect(await (await req(`${path}/confirm`, body, polling)).json()).toMatchObject({
      state: "confirmed",
    });
    now += 700000;
    expect(await (await req(`${path}/poll`, {}, polling)).json()).toMatchObject({
      state: "confirmed",
    });
    expect(w.executions.authenticate(first.access_key)).not.toBeNull();
    const again = await (
      await req("/api/tower/enrollments", {
        host_id: "host-synthetic",
        tower_version: "test",
        requested_scopes: ["read"],
      })
    ).json();
    await req(
      `/api/tower/enrollments/${again.enrollment_id}/decision`,
      { decision: "authorize" },
      owner,
    );
    const second = await (
      await req(
        `/api/tower/enrollments/${again.enrollment_id}/poll`,
        {},
        { authorization: `Bearer ${again.polling_token}` },
      )
    ).json();
    expect(second.machine_id).toBe(first.machine_id);
    expect(second.access_key).not.toBe(first.access_key);
    now += 600001;
    expect(w.executions.authenticate(second.access_key)).toBeNull();
    expect(w.executions.authenticate(first.access_key)).not.toBeNull();
    const stored =
      JSON.stringify(w.all("SELECT * FROM tower_enrollments")) +
      JSON.stringify(w.all("SELECT * FROM tower_credentials"));
    expect(stored).not.toContain(first.access_key);
    expect(stored).not.toContain(e.polling_token);
  } finally {
    db.close();
  }
});

test("denied and expired enrollment cannot issue keys or escalate consent", async () => {
  const db = openDatabase(":memory:");
  let now = Date.now();
  const w = new Workspace(db, () => new Date(now));
  const { TowerEnrollment } = await import("../server/tower-enrollment.ts");
  const enroll = new TowerEnrollment(w, "http://127.0.0.1:4390");
  const principal = { id: "owner", kind: "owner", inlet: "browser", scopes: ["admin"] } as const;
  try {
    const e = enroll.create({
      host_id: "host-test",
      tower_version: "test",
      requested_scopes: ["read"],
    });
    expect(() =>
      enroll.decide(
        e.enrollment_id,
        { decision: "authorize", scopes: ["read", "acp:control"] },
        principal,
      ),
    ).toThrow("did not request");
    enroll.decide(e.enrollment_id, { decision: "deny" }, principal);
    expect(enroll.poll(e.enrollment_id, e.polling_token).state).toBe("denied");
    const expired = enroll.create({
      host_id: "host-test",
      tower_version: "test",
      requested_scopes: ["read"],
    });
    now += 600001;
    expect(enroll.poll(expired.enrollment_id, expired.polling_token).state).toBe("expired");
    expect(() =>
      enroll.decide(expired.enrollment_id, { decision: "authorize" }, principal),
    ).toThrow("expired");
    expect(w.all("SELECT * FROM tower_credentials")).toHaveLength(0);
  } finally {
    db.close();
  }
});
