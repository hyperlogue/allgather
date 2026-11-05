import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/storage.ts";
import { migrateTranscriptContent } from "../server/transcript-migration.ts";
import { Workspace } from "../server/workspace.ts";
import {
  type Operation,
  operations,
  type Principal,
  type SessionEvent,
} from "../shared/contracts.ts";
import { fixtureAgent, fixtureOwner } from "./fixtures/tower-controls.ts";

test("transcript deletion preserves cursors, replay proof, snapshot boundaries and shared assets", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-retention-")),
    path = join(root, "db.sqlite");
  let db = openDatabase(path),
    w = new Workspace(db, undefined, undefined, { dataDir: root }),
    owner = fixtureOwner(w);
  const call = <T>(op: Operation, input: Record<string, unknown> = {}, p = owner) =>
    w.dispatch(
      op,
      { ...(operations[op].write ? { operation_key: randomUUID() } : {}), ...input },
      p,
    ) as Promise<T>;
  const events = [
    { key: "first", kind: "agent_message_chunk", payload: { text: "original capture" } },
  ];
  const assetBody = {
    target_session_id: "captured",
    media_type: "text/plain",
    data: Buffer.from("shared bytes").toString("base64"),
    name: "file.txt",
  };
  try {
    await call("sessions_declare", { target_session_id: "captured" });
    const imported = await call<{ source_id: string; cursor: number }>(
      "session_transcript_import",
      { target_session_id: "captured", source_key: "native", events, coverage: "complete" },
    );
    const asset = await call<{ id: string; blob_hash: string }>("session_assets_add", assetBody);
    await call("sessions_declare", { target_session_id: "other" });
    const other = await call<{ id: string }>("session_assets_add", {
      ...assetBody,
      target_session_id: "other",
    });
    const preview = await call<{ through_sequence: number; through_asset_sequence: number }>(
      "transcript_delete_preview",
      { target_session_id: "captured" },
    );
    await call("session_transcript_import", {
      target_session_id: "captured",
      source_key: "native",
      events: [{ key: "later", kind: "agent_message_chunk", payload: { text: "keep later" } }],
    });
    const later = await call<{ id: string }>("session_assets_add", {
      ...assetBody,
      name: "later.txt",
    });
    const input = {
      target_session_id: "captured",
      through_sequence: preview.through_sequence,
      through_asset_sequence: preview.through_asset_sequence,
      operation_key: randomUUID(),
    };
    const removed = await call<Record<string, unknown>>("transcript_delete", input);
    expect(await call<Record<string, unknown>>("transcript_delete", input)).toEqual(removed);
    expect(w.one("SELECT * FROM session_assets WHERE id=?", asset.id)).toBeNull();
    expect(w.one("SELECT * FROM session_assets WHERE id=?", later.id)).not.toBeNull();
    expect(w.one("SELECT * FROM session_assets WHERE id=?", other.id)).not.toBeNull();
    expect((await w.blobs!.read(asset.blob_hash)).toString()).toBe("shared bytes");
    const replay = await call<{ added: number; cursor: number }>("session_transcript_import", {
      target_session_id: "captured",
      source_key: "native",
      events,
    });
    expect(replay).toMatchObject({ added: 0, cursor: 2 });
    await expect(
      call("session_transcript_import", {
        target_session_id: "captured",
        source_key: "native",
        events: [{ ...events[0], payload: { text: "changed" } }],
      }),
    ).rejects.toThrow("different content");
    await expect(call("session_assets_add", assetBody)).rejects.toThrow("deleted");
    expect(
      w.one<{ cursor: number; coverage: string }>(
        "SELECT cursor,coverage FROM transcript_sources WHERE id=?",
        imported.source_id,
      ),
    ).toEqual({ cursor: 2, coverage: "partial" });
    const page = await call<{ items: SessionEvent[]; content_revision: number }>(
      "session_transcript_events",
      { target_session_id: "captured" },
    );
    expect(page.items[0].payload).toMatchObject({ deleted: true });
    expect(page.items[1].payload).toEqual({ text: "keep later" });
    expect(page.content_revision).toBeGreaterThan(0);
    expect(JSON.stringify(w.all("SELECT * FROM audit_changes"))).not.toContain("original capture");
    expect(() =>
      db
        .query("UPDATE session_event_content SET payload='revived',deleted_at=NULL WHERE id=?")
        .run(page.items[0].id),
    ).toThrow();
    const api = await fixtureAgent(w);
    await expect(
      call("transcript_delete", { ...input, operation_key: randomUUID() }, api),
    ).rejects.toThrow("owner browser");
    const mcp: Principal = { ...api, inlet: "mcp" };
    await expect(call("transcript_retention_get", {}, mcp)).rejects.toThrow("not available");
    db.close();
    db = openDatabase(path);
    w = new Workspace(db, undefined, undefined, { dataDir: root });
    owner = fixtureOwner(w);
    expect(
      (
        await call<{ items: SessionEvent[] }>("session_transcript_events", {
          target_session_id: "captured",
        })
      ).items[0].payload,
    ).toMatchObject({ deleted: true });
    expect(
      (
        await call<{ added: number }>("session_transcript_import", {
          target_session_id: "captured",
          source_key: "native",
          events,
        })
      ).added,
    ).toBe(0);
    for (const session of ["captured", "other"]) {
      const boundary = await call<{ through_sequence: number; through_asset_sequence: number }>(
        "transcript_delete_preview",
        { target_session_id: session },
      );
      await call("transcript_delete", {
        target_session_id: session,
        through_sequence: boundary.through_sequence,
        through_asset_sequence: boundary.through_asset_sequence,
      });
    }
    await expect(w.blobs!.read(asset.blob_hash)).rejects.toThrow();
    await expect(call("session_assets_add", assetBody)).rejects.toThrow("deleted");
    await expect(w.blobs!.read(asset.blob_hash)).rejects.toThrow();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retention is opt-in, uses receipt age rather than imported timestamps and preserves later captures", async () => {
  const db = openDatabase(":memory:");
  let now = Date.now();
  const w = new Workspace(db, () => new Date(now)),
    owner = fixtureOwner(w);
  const call = (op: Operation, input: Record<string, unknown> = {}) =>
    w.dispatch(
      op,
      { ...(operations[op].write ? { operation_key: randomUUID() } : {}), ...input },
      owner,
    );
  try {
    await call("sessions_declare", { target_session_id: "retained" });
    await call("session_transcript_import", {
      target_session_id: "retained",
      source_key: "native",
      events: [{ key: "one", kind: "agent_message_chunk", payload: { text: "old" } }],
    });
    now += 2 * 86400000;
    await w.transcripts.sweep();
    expect(
      w.one<{ payload: string }>("SELECT payload FROM session_event_content")?.payload,
    ).toContain("old");
    await call("session_transcript_import", {
      target_session_id: "retained",
      source_key: "native",
      events: [
        {
          key: "two",
          kind: "agent_message_chunk",
          at: "2000-01-01T00:00:00.000Z",
          payload: { text: "new" },
        },
      ],
    });
    await call("transcript_retention_update", { days: 1, expected_revision: 1 });
    const rows = w.all<{ payload: string | null }>(
      "SELECT payload FROM session_event_content ORDER BY rowid",
    );
    expect(rows[0].payload).toBeNull();
    expect(rows[1].payload).toContain("new");
    await expect(
      call("transcript_retention_update", { days: null, expected_revision: 1 }),
    ).rejects.toThrow("current retention");
    await call("transcript_retention_update", { days: null, expected_revision: 2 });
    now += 86400000 * 5;
    await w.transcripts.sweep();
    expect(
      w.one<{ n: number }>(
        "SELECT COUNT(*) n FROM session_event_content WHERE payload IS NOT NULL",
      )!.n,
    ).toBe(1);
  } finally {
    db.close();
  }
});

test("content migration preserves event identity and immutable replay digest", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE agent_sessions(id TEXT PRIMARY KEY); CREATE TABLE session_events(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TRIGGER session_events_immutable BEFORE UPDATE ON session_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TABLE session_assets(id TEXT PRIMARY KEY,created_at TEXT); INSERT INTO session_events VALUES('event','{\"text\":\"retained\"}'); INSERT INTO session_assets VALUES('asset','2026-01-01');",
    );
    migrateTranscriptContent(db);
    expect(db.query("SELECT * FROM session_events").get()).toEqual({
      id: "event",
      payload_hash: createHash("sha256").update('{"text":"retained"}').digest("hex"),
    });
    expect(db.query("SELECT payload FROM session_event_content").get()).toEqual({
      payload: '{"text":"retained"}',
    });
    expect(() => db.query("UPDATE session_events SET payload_hash='changed'").run()).toThrow(
      "append-only",
    );
    db.query("UPDATE session_event_content SET payload=NULL,deleted_at='now'").run();
    expect(() =>
      db.query("UPDATE session_event_content SET payload='revived',deleted_at=NULL").run(),
    ).toThrow("only be deleted");
    db.query("DELETE FROM session_assets WHERE id='asset'").run();
    expect(db.query("SELECT deleted_at FROM session_asset_identity").get()).not.toEqual({
      deleted_at: null,
    });
    expect(() => db.query("INSERT INTO session_assets VALUES('asset','later')").run()).toThrow(
      "Deleted assets",
    );
  } finally {
    db.close();
  }
});
