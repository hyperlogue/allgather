import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { BlobReader, TextReader, ZipReader, ZipWriter } from "@zip.js/zip.js/index-native.js";
import { revokeCredentials } from "./auth.ts";
import { BlobStore } from "./blobs.ts";
import { openDatabase, SCHEMA_VERSION, writeDatabaseSnapshot } from "./storage.ts";
import type { Workspace } from "./workspace.ts";

const blobPath = (hash: string) => `blobs/${hash.slice(0, 2)}/${hash.slice(2)}`;
async function fileHash(path: string) {
  const digest = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) digest.update(chunk);
  return digest.digest("hex");
}

export function backupWorkspace(w: Workspace): ReadableStream<Uint8Array> {
  let fail!: (error: unknown) => void;
  const output = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      fail = (error) => controller.error(error);
    },
  });
  const save = async () => {
    const directory = mkdtempSync(join(tmpdir(), "allgather-backup-"));
    let snapshot: Database | undefined;
    try {
      const path = join(directory, "allgather.sqlite");
      writeDatabaseSnapshot(w.db, path);
      snapshot = new Database(path, { readonly: true });
      const archive = new ZipWriter(output.writable, { useWebWorkers: false });
      const manifest = { format: 4, database_sha256: await fileHash(path) };
      await archive.add("manifest.json", new TextReader(JSON.stringify(manifest)), {
        unixMode: 0o100600,
      });
      await archive.add("allgather.sqlite", new BlobReader(Bun.file(path)), { unixMode: 0o100600 });
      for (const row of snapshot
        .query<{ hash: string }, []>("SELECT hash FROM blobs ORDER BY hash")
        .iterate()) {
        if (!w.blobs) throw new Error("Blob storage unavailable");
        await archive.add(
          blobPath(row.hash),
          Readable.toWeb(
            Readable.from(w.blobs.stream(row.hash)),
          ) as unknown as ReadableStream<Uint8Array>,
          {
            unixMode: 0o100600,
          },
        );
      }
      await archive.close();
    } finally {
      snapshot?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
  void (w.blobs ? w.blobs.publishing(save) : save()).catch(fail);
  return output.readable;
}

async function restoreZip(file: string, target: string) {
  const archive = new ZipReader(new BlobReader(Bun.file(file)), {
    useWebWorkers: false,
    strictness: "strict",
    checkCrc32: true,
  });
  const files = new Set<string>();
  try {
    for await (const entry of archive.getEntriesGenerator()) {
      const name = entry.filename;
      if (
        entry.directory ||
        entry.encrypted ||
        entry.executable ||
        entry.symlink ||
        !/^(manifest\.json|allgather\.sqlite|owner-key|blobs\/[0-9a-f]{2}\/[0-9a-f]{62})$/.test(
          name,
        ) ||
        files.has(name) ||
        !Number.isSafeInteger(entry.uncompressedSize) ||
        (["manifest.json", "owner-key"].includes(name) && entry.uncompressedSize > 4096)
      )
        throw new Error("Invalid backup ZIP entry");
      files.add(name);
      if (name === "owner-key") {
        await entry.getData(new WritableStream({ write() {} }));
        continue;
      }
      const path = join(target, name);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, "wx", 0o600);
      try {
        await entry.getData(Writable.toWeb(handle.createWriteStream()));
      } finally {
        await handle.close();
      }
    }
  } finally {
    await archive.close();
  }
  const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
  if (
    ![3, 4].includes(manifest.format) ||
    manifest.database_sha256 !== (await fileHash(join(target, "allgather.sqlite")))
  )
    throw new Error("Backup manifest or database digest failed");
  if (manifest.format === 4 && files.has("owner-key"))
    throw new Error("Credential included in backup");
  files.delete("owner-key");
  rmSync(join(target, "manifest.json"));
  files.delete("manifest.json");
  return files;
}
async function validateRestored(target: string, files: ReadonlySet<string>) {
  const db = new Database(join(target, "allgather.sqlite"), { readonly: true }),
    blobs = new BlobStore(join(target, "blobs")),
    expected = new Set(["allgather.sqlite"]);
  let count = 0;
  try {
    const version = (db.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (
      version < 1 ||
      version > SCHEMA_VERSION ||
      (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !==
        "ok" ||
      db.query("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Backup schema or integrity check failed");
    for (const row of db
      .query<{ hash: string; byte_length: number }, []>("SELECT hash,byte_length FROM blobs")
      .iterate()) {
      if (!/^[0-9a-f]{64}$/.test(row.hash)) throw new Error("Invalid backup blob name");
      const path = blobPath(row.hash);
      if (!files.has(path) || statSync(join(target, path)).size !== row.byte_length)
        throw new Error("Backup blob integrity check failed");
      for await (const _ of blobs.stream(row.hash)) {
      }
      expected.add(path);
      count++;
    }
    if (files.size !== expected.size || [...files].some((name) => !expected.has(name)))
      throw new Error("Backup contains unreferenced files");
  } finally {
    db.close();
  }
  return count;
}
export async function restoreWorkspace(file: string, directory: string) {
  const target = resolve(directory);
  if (existsSync(target)) throw new Error("Restore only writes to a new data directory");
  const signature = Buffer.from(await Bun.file(file).slice(0, 4).arrayBuffer());
  if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    throw new Error("Restore requires an Allgather ZIP backup");
  mkdirSync(target, { mode: 0o700 });
  try {
    const files = await restoreZip(file, target);
    const blobs = await validateRestored(target, files);
    const db = openDatabase(join(target, "allgather.sqlite"));
    try {
      revokeCredentials(db);
    } finally {
      db.close();
    }
    return { restored: true, blobs };
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
