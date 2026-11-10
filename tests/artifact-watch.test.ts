import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureApiToken } from "../scripts/fixture-auth.ts";
import { fixtureBrowserCookie } from "../scripts/fixture-passkey.ts";
import { createApp, Updates } from "../server/app.ts";
import { Auth } from "../server/auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import type { Operation, Principal } from "../shared/contracts.ts";

const base = "https://allgather.example";
const owner: Principal = { id: "owner", kind: "owner", inlet: "api", scopes: ["admin"] };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "allgather-watch-")),
    db = openDatabase(":memory:"),
    updates = new Updates();
  const w = new Workspace(db, undefined, () => updates.emit(), { dataDir: root });
  const auth = new Auth(db, base),
    app = createApp(w, auth, updates);
  const token = await fixtureApiToken(base, fixtureBrowserCookie(db), ["admin"], (r) =>
    app.fetch(r),
  );
  const call = (name: Operation, input: Record<string, unknown> = {}) =>
    w.dispatch(name, { operation_key: randomUUID(), ...input }, owner) as Promise<any>;
  const artifact = await call("artifacts_create", { kind: "files" });
  const watch = async (timeout_ms = 1000, key = token) => {
    const response = await app.fetch(
      new Request(`${base}/api/artifacts/${artifact.id}/watch`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ timeout_ms, operator_kind: "user" }),
      }),
    );
    return response;
  };
  const pending = () =>
    call("artifact_threads_add", {
      artifact_id: artifact.id,
      input: { body: "Review", target: { kind: "artifact" } },
    });
  const acknowledge = () =>
    call("artifact_comments_ack", {
      artifact_id: artifact.id,
      receipt: w.artifacts!.conversations.snapshot(artifact.id).acknowledgment,
    });
  return {
    w,
    db,
    app,
    updates,
    token,
    call,
    artifact,
    watch,
    pending,
    acknowledge,
    close() {
      w.artifacts!.watches.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("SSE watch supersedes explicit recipients, holds fallback, and waits for Submit without acknowledging", async () => {
  const f = await fixture();
  try {
    const id = f.artifact.id;
    const fallback = await f.call("artifacts_listen", {
      artifact_id: id,
      mode: "fallback",
      operator_kind: "agent",
      session_id: "fallback",
    });
    const explicit = await f.call("artifacts_listen", {
      artifact_id: id,
      mode: "explicit",
      operation_key: "explicit-replay",
      operator_kind: "agent",
      session_id: "explicit",
    });
    const first = await f.watch();
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    expect(f.w.artifacts!.notifications.watchers(id)[0].kind).toBe("watch");
    expect(f.w.artifacts!.workers.get(explicit.id)?.state).toBe("retired");
    expect(f.w.artifacts!.workers.get(fallback.id)?.state).toBe("active");
    await f.call("artifacts_listen", {
      artifact_id: id,
      mode: "explicit",
      operation_key: "explicit-replay",
      operator_kind: "agent",
      session_id: "explicit",
    });
    expect(f.w.artifacts!.notifications.watchers(id)[0].kind).toBe("watch");
    const firstResult = first.text();
    const second = await f.watch();
    expect(await firstResult).toContain('"result":"superseded"');
    const secondResult = second.text();
    await f.pending();
    expect(f.w.artifacts!.watches.current(id)).toBeDefined();
    expect((await f.call("artifacts_submit", { artifact_id: id })).notification.state).toBe("sent");
    expect(await secondResult).toContain('"result":"comments"');
    expect(f.w.artifacts!.conversations.hasPending(id)).toBe(true);
    expect(f.w.all("SELECT * FROM artifact_notifications")).toEqual([]);
    expect(f.w.artifacts!.notifications.selected(id)?.subscription.id).toBe(fallback.id);
    expect(f.w.all("SELECT * FROM audit_operations WHERE operation='artifact_watch'").length).toBe(
      2,
    );
  } finally {
    f.close();
  }
});

test("SSE watch handles disconnect, timeout, explicit listen, archive and deletion", async () => {
  const f = await fixture();
  try {
    const id = f.artifact.id;
    const cancelled = await f.watch();
    await cancelled.body!.cancel();
    await Bun.sleep(0);
    expect(f.w.artifacts!.watches.current(id)).toBeUndefined();
    expect(await (await f.watch(1)).text()).toContain('"result":"timeout"');
    const held = await f.watch();
    const heldText = held.text();
    await f.call("artifacts_listen", {
      artifact_id: id,
      mode: "explicit",
      session_id: "new-listener",
      operator_kind: "agent",
    });
    expect(await heldText).toContain('"result":"superseded"');
    const archived = await f.watch();
    const archiveText = archived.text();
    await f.call("artifacts_archive", { artifact_id: id, comment: "Approved" });
    expect(await archiveText).toContain('"result":"archived"');
    expect(await (await f.watch()).text()).toContain('"result":"archived"');
    await f.call("artifacts_restore", { artifact_id: id });
    await f.acknowledge();
    const deleted = await f.watch();
    const deletedText = deleted.text();
    await f.call("artifacts_delete", { artifact_id: id });
    expect(await deletedText).toContain('"result":"deleted"');
  } finally {
    f.close();
  }
});

test("watch requires notification access and terminates on credential revocation", async () => {
  const f = await fixture();
  try {
    const invalid = await f.app.fetch(
      new Request(`${base}/api/artifacts/${f.artifact.id}/watch`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body: JSON.stringify({ timeout_ms: -1 }),
      }),
    );
    expect(invalid.status).toBe(400);
    const readOnly = await fixtureApiToken(
      base,
      fixtureBrowserCookie(f.db),
      ["artifacts:read"],
      (r) => f.app.fetch(r),
    );
    expect((await f.watch(1000, readOnly)).status).toBe(403);
    expect(f.w.artifacts!.watches.current(f.artifact.id)).toBeUndefined();
    const response = await f.watch();
    const output = response.text();
    f.db.exec("UPDATE oauth_tokens SET revoked=1");
    f.updates.emit();
    expect(await output).toContain("Watch access expired or was revoked");
    expect(f.w.artifacts!.watches.current(f.artifact.id)).toBeUndefined();
  } finally {
    f.close();
  }
});
