import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../server/blobs.ts";
import { NativeGit } from "../server/native-git.ts";
import { openDatabase } from "../server/storage.ts";
import { UpstreamSync } from "../server/upstream-sync.ts";
import { Workspace } from "../server/workspace.ts";

test("storage growth uses allocated bytes and counts shared artifact/session content once", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-storage-")),
    db = openDatabase(":memory:");
  let now = new Date("2026-01-01T00:00:00Z");
  const w = new Workspace(db, () => now, undefined, { dataDir: root }),
    sync = new UpstreamSync(w, new NativeGit(join(root, "git-cache")), 0);
  const measure = async () => {
    await sync.measure();
    return JSON.parse(
      w.one<{ value: string }>("SELECT value FROM storage_observations WHERE id=1")!.value,
    ) as {
      blob_store_bytes: number;
      growth: { since: string; blob_store_bytes: number } | null;
      history: unknown[];
    };
  };
  try {
    const before = await measure();
    expect(before.growth).toBeNull();
    await w.blobs!.put(new Uint8Array(1024 * 1024).fill(42));
    now = new Date("2026-01-01T00:05:00Z");
    const after = await measure();
    expect(after.blob_store_bytes).toBeGreaterThan(before.blob_store_bytes);
    expect(after.growth!.blob_store_bytes).toBe(after.blob_store_bytes - before.blob_store_bytes);
    expect(after.growth!.since).toBe("2026-01-01T00:00:00.000Z");
    await w.blobs!.put(new Uint8Array(1024 * 1024).fill(42));
    now = new Date("2026-01-01T00:06:00Z");
    const shared = await measure();
    expect(shared.blob_store_bytes).toBe(after.blob_store_bytes);
    expect(shared.history).toHaveLength(2);
    now = new Date("2026-01-03T00:00:00Z");
    expect((await measure()).growth).toBeNull();
  } finally {
    await sync.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("routine work notifications reuse a recent storage sample instead of walking blobs again", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-measure-")),
    db = openDatabase(":memory:");
  let now = new Date("2026-01-01T00:00:00Z");
  const w = new Workspace(db, () => now, undefined, { dataDir: root }),
    sync = new UpstreamSync(w, new NativeGit(join(root, "git-cache")), 0);
  const measurements = spyOn(sync, "measure");
  try {
    await sync.runOnce();
    for (let i = 0; i < 5; i++) await sync.runOnce();
    expect(measurements).toHaveBeenCalledTimes(1);
    now = new Date("2026-01-01T00:00:31Z");
    await sync.runOnce();
    expect(measurements).toHaveBeenCalledTimes(2);
    expect(w.one<{ at: string }>("SELECT at FROM storage_observations WHERE id=1")?.at).toBe(
      now.toISOString(),
    );
  } finally {
    measurements.mockRestore();
    await sync.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("garbage collection waits for nested attachment preparation through its metadata commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-nested-blobs-")),
    blobs = new BlobStore(root),
    live = new Set<string>();
  let prepared!: () => void, resume!: () => void;
  const preparing = new Promise<void>((resolve) => {
      prepared = resolve;
    }),
    continued = new Promise<void>((resolve) => {
      resume = resolve;
    });
  try {
    const publishing = blobs.publishing(async () => {
      const frame = await blobs.put("frame");
      prepared();
      await continued;
      const attachment = await blobs.publishing(() => blobs.put("attachment"));
      // SQL reference creation happens only after all content is prepared.
      live.add(frame.hash);
      live.add(attachment.hash);
      return [frame, attachment];
    });
    await preparing;
    const collecting = blobs.collect(() => live);
    resume();
    const [stored, removed] = await Promise.all([publishing, collecting]);
    expect(removed).toBe(0);
    expect((await blobs.read(stored[0].hash)).toString()).toBe("frame");
    expect((await blobs.read(stored[1].hash)).toString()).toBe("attachment");
    live.clear();
    expect(await blobs.collect(() => live)).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);
