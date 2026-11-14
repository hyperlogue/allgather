import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageLargeFiles } from "../cli/artifact-upload.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import type { Artifact, ArtifactUpload, ArtifactVersion } from "../shared/artifacts.ts";
import { type Operation, operations, type Principal } from "../shared/contracts.ts";

const owner: Principal = { id: "owner", kind: "owner", inlet: "browser", scopes: ["admin"] };

test("staged parts assemble into published files, expire, and are collected", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-uploads-")),
    db = openDatabase(":memory:");
  let now = new Date("2026-01-01T00:00:00Z");
  const w = new Workspace(db, () => now, undefined, { dataDir: root });
  const call = async <T>(name: Operation, input: Record<string, unknown>) =>
    (await w.dispatch(
      name,
      { ...(operations[name].write ? { operation_key: randomUUID() } : {}), ...input },
      owner,
    )) as T;
  try {
    const artifact = await call<Artifact>("artifacts_create", { kind: "files" });
    const upload = (text: string) =>
      call<ArtifactUpload>("artifacts_upload", {
        artifact_id: artifact.id,
        data: Buffer.from(text).toString("base64"),
      });
    const pieces = ["# Title\n\n", "Body ", "text\n"];
    const parts = [];
    for (const piece of pieces) parts.push((await upload(piece)).hash);
    const single = await upload("standalone");
    const version = await call<ArtifactVersion>("artifacts_publish", {
      artifact_id: artifact.id,
      expected_seq: 0,
      content: {
        kind: "files",
        files: [
          { path: "doc.md", mediaType: "text/markdown", parts },
          { path: "one.txt", mediaType: "text/plain", parts: [single.hash] },
          {
            path: "inline.txt",
            mediaType: "text/plain",
            base64: Buffer.from(pieces.join("")).toString("base64"),
          },
        ],
      },
    });
    const store = w.artifacts!.store;
    expect((await store.readFile(artifact.id, version.seq, "doc.md")).toString()).toBe(
      pieces.join(""),
    );
    expect((await store.readFile(artifact.id, version.seq, "doc.md", true)).toString()).toContain(
      "Title",
    );
    expect((await store.readFile(artifact.id, version.seq, "one.txt")).toString()).toBe(
      "standalone",
    );
    const files = store.files(artifact.id, version.seq);
    const hash = (path: string) => files.find((file) => file.path === path)?.hash;
    expect(hash("doc.md")).toBeString();
    expect(hash("doc.md")).toBe(hash("inline.txt"));

    const orphan = await upload("abandoned");
    now = new Date("2026-01-02T00:00:01Z");
    await expect(
      call("artifacts_publish", {
        artifact_id: artifact.id,
        expected_seq: 1,
        content: {
          kind: "files",
          files: [{ path: "late.txt", mediaType: "text/plain", parts: [orphan.hash] }],
        },
      }),
    ).rejects.toMatchObject({ code: "artifact_conflict" });
    await call("artifacts_gc", { input: { ttlDays: 30 } });
    expect(w.all("SELECT * FROM artifact_uploads")).toEqual([]);
    const blob = join(root, "blobs", orphan.hash.slice(0, 2), orphan.hash.slice(2));
    expect(existsSync(blob)).toBe(false);
    expect((await store.readFile(artifact.id, version.seq, "one.txt")).toString()).toBe(
      "standalone",
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI stages the largest files until the inline request fits", async () => {
  const file = (path: string, size: number) => ({
    path,
    mediaType: "application/octet-stream",
    base64: Buffer.alloc(size, path).toString("base64"),
  });
  const uploads: string[] = [];
  const content = {
    kind: "files",
    files: [file("small", 10), file("large", 300), file("medium", 120)],
  };
  const staged = (await stageLargeFiles(
    content,
    async (data) => {
      uploads.push(data);
      return `hash-${uploads.length}`;
    },
    200,
  )) as { files: Record<string, unknown>[] };
  expect(staged.files).toEqual([
    content.files[0],
    { path: "large", mediaType: "application/octet-stream", parts: ["hash-1"] },
    content.files[2],
  ]);
  expect(Buffer.from(uploads[0]!, "base64").equals(Buffer.alloc(300, "large"))).toBe(true);
  expect(await stageLargeFiles({ kind: "diff", patch: "" }, async () => "x")).toEqual({
    kind: "diff",
    patch: "",
  });
});
