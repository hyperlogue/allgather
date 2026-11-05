import { expect, test } from "bun:test";
import { createApp, Updates } from "../server/app.ts";
import { Auth, hash, secret } from "../server/auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";

function fixture() {
  const db = openDatabase(":memory:"),
    origin = "http://127.0.0.1:4390";
  let now = Date.now();
  const w = new Workspace(db, () => new Date(now)),
    auth = new Auth(db, origin);
  const app = createApp(w, auth, new Updates());
  const cookie = auth.signIn(auth.createLoginToken("Test").token).split(";")[0]!;
  const owner = { cookie, origin };
  const req = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const invite = async (body: object = {}) => {
    const r = await req("/api/tower/invitations", body, owner);
    expect(r.status).toBe(201);
    return r.json();
  };
  const body = (code: string, host = "host-fixture") => ({
    pairing_code: code,
    request_id: secret(),
    host_id: host,
    tower_version: "test",
    requested_scopes: ["read", "send", "acp:control", "terminal:control"],
  });
  const start = async (input: object) => {
    const r = await req("/api/tower/enrollments", input);
    expect(r.status).toBe(201);
    return r.json();
  };
  const poll = (e: { enrollment_id: string; polling_token: string }) =>
    req(
      `/api/tower/enrollments/${e.enrollment_id}/poll`,
      {},
      { authorization: `Bearer ${e.polling_token}` },
    );
  const confirm = (
    e: { enrollment_id: string; polling_token: string },
    key: { credential_id: string; access_key: string },
  ) =>
    req(
      `/api/tower/enrollments/${e.enrollment_id}/confirm`,
      { credential_id: key.credential_id, access_key_hash: hash(key.access_key) },
      { authorization: `Bearer ${e.polling_token}` },
    );
  return {
    app,
    db,
    w,
    auth,
    owner,
    req,
    invite,
    body,
    start,
    poll,
    confirm,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("only a live owner browser creates bounded pairing codes; anonymous attempts allocate nothing", async () => {
  const f = fixture();
  try {
    expect((await f.req("/api/tower/invitations", {})).status).toBe(403);
    expect((await f.req("/api/tower/invitations", {}, { cookie: f.owner.cookie })).status).toBe(
      403,
    );
    expect(
      (await f.req("/api/tower/invitations", {}, { ...f.owner, origin: "https://wrong.invalid" }))
        .status,
    ).toBe(403);
    expect(
      (
        await f.req("/api/tower/enrollments", {
          host_id: "host",
          tower_version: "test",
          requested_scopes: ["read"],
        })
      ).status,
    ).toBe(400);
    expect((await f.req("/api/tower/enrollments", f.body(secret()))).status).toBe(401);
    expect(f.w.all("SELECT * FROM tower_enrollments")).toHaveLength(0);
    expect(f.w.all("SELECT * FROM machines")).toHaveLength(0);
    const i = await f.invite({ scopes: ["read"] });
    expect(i.pairing_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      JSON.stringify(await (await f.req("/api/tower/invitations", undefined, f.owner)).json()),
    ).not.toContain(i.pairing_code);
  } finally {
    f.db.close();
  }
});

test("pairing binds exact request, intersects consent, retries one key and confirms durable installation", async () => {
  const f = fixture();
  try {
    const i = await f.invite({ node_label: "Owner node", scopes: ["read", "acp:control"] });
    const input = { ...f.body(i.pairing_code), node_label: "Untrusted name" },
      e = await f.start(input);
    expect(await f.start(input)).toEqual(e);
    for (const patch of [
      { request_id: secret() },
      { host_id: "other" },
      { node_label: "other" },
      { node_label: " Untrusted name " },
      { tower_version: "next" },
      { requested_scopes: ["read"] },
    ])
      expect((await f.req("/api/tower/enrollments", { ...input, ...patch })).status).toBe(409);
    const path = `/api/tower/enrollments/${e.enrollment_id}`;
    expect(e.authorization_url).not.toContain(e.polling_token);
    expect(e.authorization_url).not.toContain(i.pairing_code);
    expect((await f.req(path)).status).toBe(403);
    expect((await f.req(`${path}/poll`, {}, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await f.req(`${path}/decision`, { decision: "authorize" }, f.owner)).status).toBe(404);
    const key = await (await f.poll(e)).json();
    expect(key).toMatchObject({
      state: "approved",
      node_label: "Owner node",
      scopes: ["read", "acp:control"],
    });
    expect((await f.poll(e)).status).toBe(429);
    f.advance(5000);
    expect(await (await f.poll(e)).json()).toEqual(key);
    expect(f.w.executions.authenticate(key.access_key)?.machine_id).toBe(key.machine_id);
    expect(
      (
        await f.req(
          "/api/operations/machines_list",
          {},
          { authorization: `Bearer ${key.access_key}` },
        )
      ).status,
    ).toBe(401);
    expect((await f.confirm(e, key)).status).toBe(200);
    expect((await f.confirm(e, key)).status).toBe(200);
    expect((await f.req("/api/tower/enrollments", input)).status).toBe(409);
    expect(
      (await f.req(`/api/tower/invitations/${i.invitation_id}/revoke`, {}, f.owner)).status,
    ).toBe(409);
    f.advance(700000);
    expect(await (await f.poll(e)).json()).toMatchObject({ state: "confirmed" });
    expect(f.w.executions.authenticate(key.access_key)).not.toBeNull();
    const stored =
      JSON.stringify(f.w.all("SELECT * FROM tower_invitations")) +
      JSON.stringify(f.w.all("SELECT * FROM tower_enrollments")) +
      JSON.stringify(f.w.all("SELECT * FROM tower_credentials"));
    for (const value of [i.pairing_code, e.polling_token, key.access_key])
      expect(stored).not.toContain(value);
  } finally {
    f.db.close();
  }
});

test("re-pairing requires explicit same-host selection and replaces earlier keys only on confirmation", async () => {
  const f = fixture();
  try {
    const first = await f.start(f.body((await f.invite()).pairing_code));
    const old = await (await f.poll(first)).json();
    await f.confirm(first, old);
    const newNode = await f.invite();
    expect((await f.req("/api/tower/enrollments", f.body(newNode.pairing_code))).status).toBe(409);
    const i = await f.invite({ machine_id: old.machine_id, scopes: ["read"] });
    expect(
      (await f.req("/api/tower/enrollments", f.body(i.pairing_code, "wrong-host"))).status,
    ).toBe(409);
    const e = await f.start(f.body(i.pairing_code)),
      key = await (await f.poll(e)).json();
    expect(key.machine_id).toBe(old.machine_id);
    expect(key.scopes).toEqual(["read"]);
    expect(f.w.executions.authenticate(old.access_key)).not.toBeNull();
    await f.confirm(e, key);
    expect(f.w.executions.authenticate(old.access_key)).toBeNull();
    expect(f.w.executions.authenticate(key.access_key)).not.toBeNull();
    const later = f.w.executions.issueCredential(old.machine_id, "later", ["read"]);
    await f.confirm(e, key);
    expect(f.w.executions.authenticate(later.access_key)).not.toBeNull();
    const expired = await f.start(
      f.body((await f.invite({ machine_id: old.machine_id })).pairing_code),
    );
    const unconfirmed = await (await f.poll(expired)).json();
    f.advance(600001);
    expect(f.w.executions.authenticate(unconfirmed.access_key)).toBeNull();
    expect((await f.confirm(expired, unconfirmed)).status).toBe(409);
    expect(f.w.executions.authenticate(key.access_key)).not.toBeNull();
  } finally {
    f.db.close();
  }
});

test("revoked and expired invitations cannot enroll or complete an unconfirmed credential", async () => {
  const f = fixture();
  try {
    const i = await f.invite({ scopes: ["acp:control"] });
    const input = { ...f.body(i.pairing_code), requested_scopes: ["read"] };
    expect((await f.req("/api/tower/enrollments", input)).status).toBe(403);
    expect(f.w.all("SELECT * FROM machines")).toHaveLength(0);
    const e = await f.start(f.body(i.pairing_code)),
      key = await (await f.poll(e)).json();
    expect(
      (await f.req(`/api/tower/invitations/${i.invitation_id}/revoke`, {}, f.owner)).status,
    ).toBe(200);
    expect(f.w.executions.authenticate(key.access_key)).toBeNull();
    expect((await f.confirm(e, key)).status).toBe(409);
    expect((await f.req("/api/tower/enrollments", f.body(i.pairing_code))).status).toBe(401);
    const expired = await f.invite();
    f.advance(600001);
    expect((await f.req("/api/tower/enrollments", f.body(expired.pairing_code))).status).toBe(401);
  } finally {
    f.db.close();
  }
});

test("credential reset retires unused pairing codes", async () => {
  const f = fixture();
  try {
    const i = await f.invite();
    const { revokeCredentials } = await import("../server/auth.ts");
    revokeCredentials(f.db);
    expect((await f.req("/api/tower/enrollments", f.body(i.pairing_code))).status).toBe(401);
    expect((await f.req("/api/tower/invitations", {}, f.owner)).status).toBe(403);
  } finally {
    f.db.close();
  }
});

test("HTTP machine keys can only be issued through pairing; listing and revocation require owner browser", async () => {
  const f = fixture();
  try {
    const { fixtureApiToken } = await import("../scripts/fixture-auth.ts");
    const token = await fixtureApiToken(f.owner.origin, f.owner.cookie, ["admin"], (request) =>
      f.app.fetch(request),
    );
    const api = { authorization: `Bearer ${token}` };
    const enrollment = await f.start(f.body((await f.invite()).pairing_code));
    const key = await (await f.poll(enrollment)).json();
    await f.confirm(enrollment, key);
    for (const headers of [f.owner, api, {}])
      expect(
        (
          await f.req(
            "/api/tower/credentials",
            { machine_id: key.machine_id, label: "forged", scopes: ["acp:control"] },
            headers,
          )
        ).status,
      ).toBe(404);
    expect(f.w.all("SELECT * FROM tower_credentials")).toHaveLength(1);
    expect((await f.req("/api/tower/credentials", undefined, api)).status).toBe(403);
    expect((await f.req("/api/tower/credentials", undefined, f.owner)).status).toBe(200);
    expect(
      (await f.req(`/api/tower/credentials/${key.credential_id}/revoke`, {}, api)).status,
    ).toBe(403);
    expect(f.w.executions.authenticate(key.access_key)).not.toBeNull();
    expect(
      (await f.req(`/api/tower/credentials/${key.credential_id}/revoke`, {}, f.owner)).status,
    ).toBe(200);
    expect(f.w.executions.authenticate(key.access_key)).toBeNull();
  } finally {
    f.db.close();
  }
});
