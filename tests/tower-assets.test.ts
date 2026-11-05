import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, Updates } from "../server/app.ts";
import { Auth } from "../server/auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import type { Machine, SessionRuntime } from "../shared/contracts.ts";
import { fixtureOwner, fullControls } from "./fixtures/tower-controls.ts";

test("asset retry identity survives response loss and reads require the exact runtime owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-assets-test-")),
    db = openDatabase(":memory:");
  const w = new Workspace(db, undefined, undefined, { dataDir: root, managedSessions: true });
  const origin = "http://127.0.0.1:4390",
    auth = new Auth(db, origin, "test-owner-".repeat(5)),
    app = createApp(w, auth, new Updates());
  const owner = fixtureOwner(w);
  try {
    const machines = ["First", "Second"].map(
      (name) =>
        w.execute("machines_create", { name, operation_key: randomUUID() }, owner) as Machine,
    );
    for (const m of machines)
      w.run(
        "UPDATE machines SET capabilities=?,harnesses=?,harness_controls=? WHERE id=?",
        JSON.stringify([
          "managed-acp.v1",
          "command-receipts.v1",
          "session-stream.v1",
          "session-resume.v1",
        ]),
        JSON.stringify(["fixture"]),
        JSON.stringify({ fixture: fullControls() }),
        m.id,
      );
    const keys = machines.map((m) =>
      w.executions.issueCredential(m.id, "Test", ["read", "send", "acp:control"]),
    );
    const r = (
      w.execute(
        "session_launch",
        {
          machine_id: machines[0]!.id,
          harness: "fixture",
          cwd: "/work/project",
          operation_key: randomUUID(),
        },
        owner,
      ) as { runtime: SessionRuntime }
    ).runtime;
    const req = (path: string, key: string, body?: unknown) =>
      app.request(origin + path, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const input = {
      runtime_id: r.id,
      generation: r.generation,
      media_type: "text/plain",
      name: "example.txt",
      data: Buffer.from("example").toString("base64"),
    };
    const asset = await (await req("/api/tower/assets", keys[0]!.access_key, input)).json();
    expect(await (await req("/api/tower/assets", keys[0]!.access_key, input)).json()).toEqual(
      asset,
    );
    const path = `/api/tower/assets/${asset.id}?runtime_id=${r.id}&generation=${r.generation}`;
    expect(await (await req(path, keys[0]!.access_key)).text()).toBe("example");
    expect((await req(path, keys[1]!.access_key)).status).toBe(404);
    expect((await req(`/api/tower/assets/${asset.id}`, keys[0]!.access_key)).status).toBe(400);
    expect((await req("/api/tower/assets", keys[1]!.access_key, input)).status).toBe(403);
    expect(
      (await req("/api/tower/assets", keys[0]!.access_key, { ...input, generation: "wrong" }))
        .status,
    ).toBe(403);
    w.run(
      "UPDATE session_runtimes SET state='ended',termination='confirmed',acp_session_id='native-test' WHERE id=?",
      r.id,
    );
    const next = (
      w.execute(
        "session_resume",
        {
          target_session_id: r.session_id,
          machine_id: machines[0]!.id,
          cwd: "/work/project",
          operation_key: randomUUID(),
        },
        owner,
      ) as { runtime: SessionRuntime }
    ).runtime;
    expect(
      (
        await req(
          `/api/tower/assets/${asset.id}?runtime_id=${next.id}&generation=${next.generation}`,
          keys[0]!.access_key,
        )
      ).status,
    ).toBe(404);
    const other = await (
      await req("/api/tower/assets", keys[0]!.access_key, {
        ...input,
        runtime_id: next.id,
        generation: next.generation,
      })
    ).json();
    expect(other.id).not.toBe(asset.id);
    expect(w.all("SELECT * FROM blobs")).toHaveLength(1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
