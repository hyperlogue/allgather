import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadArtifact } from "../cli/artifact-download.ts";
import { artifactCommand } from "../cli/artifacts.ts";
import type { Client } from "../cli/client.ts";

test("download writes the first chunk before the response completes and protects existing outputs", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
  );
  const chunks: Buffer[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation(((
    chunk: Uint8Array,
    callback: () => void,
  ) => {
    chunks.push(Buffer.from(chunk));
    callback();
    return true;
  }) as typeof process.stdout.write);
  try {
    const pending = downloadArtifact(response);
    controller.enqueue(new Uint8Array([0, 255]));
    await Bun.sleep(0);
    expect(chunks).toEqual([Buffer.from([0, 255])]);
    controller.enqueue(new Uint8Array([128]));
    controller.close();
    expect(await pending).toBe(3);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 128]));
  } finally {
    stdout.mockRestore();
  }
  const root = mkdtempSync(join(tmpdir(), "allgather-download-"));
  try {
    const file = join(root, "output");
    writeFileSync(file, "keep");
    await expect(downloadArtifact(new Response("replacement"), file)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe("keep");
    const broken = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.error(new Error("lost download"));
        },
      }),
    );
    await expect(downloadArtifact(broken, join(root, "partial"))).rejects.toThrow("lost download");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC forwards retention and reports partial failures as failure exits", async () => {
  let input: unknown;
  const client = {
    call: async (_op: string, value: unknown) => {
      input = value;
      return { failures: [{ id: "artifact", error: "locked" }] };
    },
  } as unknown as Client;
  const print = spyOn(console, "log").mockImplementation(() => {}),
    prior = process.exitCode;
  try {
    await artifactCommand(client, ["artifact", "gc"], { ttl: "7d", apply: true });
    expect(input).toMatchObject({ input: { ttlDays: 7, dryRun: false } });
    expect(process.exitCode).toBe(1);
    await expect(artifactCommand(client, ["artifact", "gc"], { ttl: "0d" })).rejects.toThrow(
      "whole days",
    );
    await expect(
      artifactCommand(client, ["artifact", "create"], { title: "-", summary: "-" }),
    ).rejects.toThrow("Only one input");
  } finally {
    process.exitCode = prior ?? 0;
    print.mockRestore();
  }
});
