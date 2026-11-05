import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js/index-native.js";
import { backupWorkspace, restoreWorkspace } from "../server/backup.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import { fixtureOwner } from "./fixtures/tower-controls.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "allgather-backup-test-")),
    db = openDatabase(":memory:"),
    w = new Workspace(db, undefined, undefined, { dataDir: join(root, "source") });
  fixtureOwner(w);
  const content = randomBytes(256 * 1024),
    blob = await w.blobs!.put(content);
  w.run("INSERT INTO blobs VALUES(?,?,?)", blob.hash, blob.byteLength, w.now());
  const blobName = `blobs/${blob.hash.slice(0, 2)}/${blob.hash.slice(2)}`;
  return {
    root,
    db,
    w,
    content,
    blobName,
    hash: blob.hash,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function unpack(bytes: Uint8Array) {
  const archive = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
    checkCrc32: true,
  });
  const entries = new Map<string, Uint8Array>();
  try {
    for await (const entry of archive.getEntriesGenerator()) {
      if (entry.directory) throw new Error("Unexpected ZIP directory");
      entries.set(entry.filename, await entry.getData(new Uint8ArrayWriter()));
    }
    return entries;
  } finally {
    await archive.close();
  }
}
async function pack(entries: Map<string, Uint8Array>, options: { zip64?: boolean } = {}) {
  const archive = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, ...options });
  for (const [name, bytes] of entries) await archive.add(name, new Uint8ArrayReader(bytes));
  return archive.close();
}

test("ZIP backups omit credentials, restore ZIP64, and preserve existing destinations", async () => {
  const f = await fixture();
  try {
    const bytes = new Uint8Array(await new Response(backupWorkspace(f.w)).arrayBuffer());
    const entries = await unpack(bytes);
    expect([...entries.keys()]).toEqual(["manifest.json", "allgather.sqlite", f.blobName]);
    expect(JSON.parse(new TextDecoder().decode(entries.get("manifest.json"))).format).toBe(4);
    expect(Buffer.from(entries.get("allgather.sqlite")!).subarray(0, 16).toString()).toBe(
      "SQLite format 3\0",
    );
    expect(Buffer.from(entries.get(f.blobName)!)).toEqual(f.content);
    const archivePath = join(f.root, "backup.zip"),
      target = join(f.root, "restored");
    writeFileSync(archivePath, await pack(entries, { zip64: true }));
    expect(await restoreWorkspace(archivePath, target)).toEqual({ restored: true, blobs: 1 });
    expect(readFileSync(join(target, f.blobName))).toEqual(f.content);
    expect(existsSync(join(target, "owner-key"))).toBe(false);
    const restoredDb = openDatabase(join(target, "allgather.sqlite"));
    expect(restoredDb.query("SELECT count(*) n FROM sessions").get()).toEqual({ n: 0 });
    expect(
      restoredDb.query("SELECT count(*) n FROM login_tokens WHERE revoked_at IS NULL").get(),
    ).toEqual({ n: 0 });
    restoredDb.close();
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(statSync(join(target, f.blobName)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(target, "manifest.json"))).toBe(false);
    await expect(restoreWorkspace(archivePath, target)).rejects.toThrow("new data directory");
    expect(readFileSync(join(target, f.blobName))).toEqual(f.content);
  } finally {
    f.close();
  }
});

test("legacy ZIP restore discards the old raw key and requires fresh authentication", async () => {
  const f = await fixture();
  try {
    const entries = await unpack(
      new Uint8Array(await new Response(backupWorkspace(f.w)).arrayBuffer()),
    );
    const manifest = JSON.parse(new TextDecoder().decode(entries.get("manifest.json")));
    entries.set(
      "manifest.json",
      new TextEncoder().encode(JSON.stringify({ ...manifest, format: 3 })),
    );
    entries.set("owner-key", new TextEncoder().encode("obsolete-raw-owner-key"));
    const archive = join(f.root, "legacy.zip"),
      target = join(f.root, "legacy-restored");
    writeFileSync(archive, await pack(entries));
    expect(await restoreWorkspace(archive, target)).toEqual({ restored: true, blobs: 1 });
    expect(existsSync(join(target, "owner-key"))).toBe(false);
    const db = openDatabase(join(target, "allgather.sqlite"));
    try {
      expect(db.query("SELECT count(*) n FROM sessions").get()).toEqual({ n: 0 });
      expect(db.query("SELECT value FROM settings WHERE key='owner_key_hash'").get()).toBeNull();
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});

test("ZIP restore rejects missing, corrupt, unreferenced, and unsafe entries without leaving partial data", async () => {
  const f = await fixture();
  try {
    const entries = await unpack(
      new Uint8Array(await new Response(backupWorkspace(f.w)).arrayBuffer()),
    );
    const variants: Map<string, Uint8Array>[] = [];
    const missing = new Map(entries);
    missing.delete(f.blobName);
    variants.push(missing);
    const wrongBlob = new Map(entries);
    wrongBlob.set(f.blobName, new Uint8Array(f.content.length));
    variants.push(wrongBlob);
    const wrongKey = new Map(entries);
    wrongKey.set("owner-key", new TextEncoder().encode("wrong-key"));
    variants.push(wrongKey);
    const wrongDb = new Map(entries);
    wrongDb.set("allgather.sqlite", new Uint8Array(entries.get("allgather.sqlite")!.length));
    variants.push(wrongDb);
    const unknown = new Map(entries);
    unknown.set("unexpected.txt", new Uint8Array([1]));
    variants.push(unknown);
    const unreferenced = new Map(entries);
    unreferenced.set(`blobs/aa/${"b".repeat(62)}`, new Uint8Array([1]));
    variants.push(unreferenced);
    const traversal = new Map(entries);
    traversal.set("../escaped", new Uint8Array([1]));
    variants.push(traversal);
    for (let i = 0; i < variants.length; i++) {
      const archive = join(f.root, `bad-${i}.zip`),
        target = join(f.root, `bad-${i}`);
      writeFileSync(archive, await pack(variants[i]));
      await expect(restoreWorkspace(archive, target)).rejects.toThrow();
      expect(existsSync(target)).toBe(false);
    }
    expect(existsSync(join(f.root, "escaped"))).toBe(false);
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    await writer.add("owner-key", new Uint8ArrayReader(new TextEncoder().encode("elsewhere")), {
      unixMode: 0o120777,
    });
    const linkArchive = join(f.root, "symlink.zip");
    writeFileSync(linkArchive, await writer.close());
    await expect(restoreWorkspace(linkArchive, join(f.root, "symlink"))).rejects.toThrow(
      "Invalid backup ZIP entry",
    );
  } finally {
    f.close();
  }
});

test("restore rejects non-ZIP input before creating a destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-nonzip-"));
  try {
    for (const format of [1, 2]) {
      const file = join(root, `unsupported-${format}.json`),
        target = join(root, `restored-${format}`);
      writeFileSync(file, JSON.stringify({ format, database: "", ownerKey: "unused", blobs: {} }));
      await expect(restoreWorkspace(file, target)).rejects.toThrow("Allgather ZIP backup");
      expect(existsSync(target)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup cancellation and corrupt source bytes release the publication hold", async () => {
  const f = await fixture();
  try {
    const reader = backupWorkspace(f.w).getReader();
    await reader.read();
    let collected = false;
    const cleanup = f.w
      .blobs!.collect(() => new Set([f.hash]))
      .then(() => {
        collected = true;
      });
    await Bun.sleep(15);
    expect(collected).toBe(false);
    await reader.cancel();
    await cleanup;
    expect(collected).toBe(true);
    const path = join(f.root, "source", f.blobName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "broken");
    await expect(new Response(backupWorkspace(f.w)).arrayBuffer()).rejects.toThrow();
    await f.w.blobs!.collect(() => new Set());
  } finally {
    f.close();
  }
});
