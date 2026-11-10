import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactCommand } from "../cli/artifacts.ts";
import type { Client } from "../cli/client.ts";
import { AppError } from "../shared/contracts.ts";

test("uncertain first publication reports the original publication key and retries creation identically", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-cli-retry-"));
  const requests: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    url: "http://localhost",
    operator: { operator_kind: "user" },
    call: async (name: string, input: Record<string, unknown>) => {
      requests.push({ name, input });
      if (name === "artifacts_create") return { id: "artifact_fixture" };
      throw new Error("Lost response");
    },
  } as unknown as Client;
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    writeFileSync(join(root, "index.html"), "<h1>Review</h1>");
    const flags = { kind: "html", root, key: "stable", remote: "https://example.invalid/project" };
    await expect(artifactCommand(client, ["artifact", "create"], flags)).rejects.toThrow(
      "Lost response",
    );
    expect(requests[1].input.expected_seq).toBe(0);
    expect(error.mock.calls[0][0]).toContain(JSON.stringify(requests[1].input.operation_key));
    expect(error.mock.calls[0][0]).toContain('"artifact_id":"artifact_fixture"');
    expect(requests[0].input.operation_key).not.toBe(requests[1].input.operation_key);
    await expect(artifactCommand(client, ["artifact", "create"], flags)).rejects.toThrow(
      "Lost response",
    );
    expect(requests.slice(2)).toEqual(requests.slice(0, 2));
  } finally {
    error.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("targeted reply failures retain the original publication and anchor guards", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    operator: { operator_kind: "user" },
    request: async () =>
      Response.json({ id: "thread", artifactId: "artifact", anchor: { revision: 7 } }),
    call: async (name: string, input: Record<string, unknown>) => {
      if (name === "artifacts_get") return { versions: [{ seq: 3 }] };
      calls.push(input);
      throw new Error("Lost reply response");
    },
  } as unknown as Client;
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      artifactCommand(client, ["artifact", "comment", "thread"], {
        key: "reply-key",
        body: "Fixed",
        file: "a.txt",
        view: "source",
        version: "3",
      }),
    ).rejects.toThrow("Lost reply");
    expect(calls[0]).toMatchObject({
      operation_key: "reply-key",
      input: { reanchor: { expectedSeq: 3, expectedAnchorRevision: 7 } },
    });
    expect(error.mock.calls[0][0]).toContain(
      '"key":"reply-key","expectedSeq":3,"expectedAnchorRevision":7',
    );
  } finally {
    error.mockRestore();
  }
});

test("failed stdout never acknowledges or subscribes; failed subscription only warns", async () => {
  const calls: string[] = [];
  let outputFails = true;
  const client = {
    operator: { operator_kind: "agent", session_id: "fixture" },
    request: async () =>
      Response.json({
        text: "Pending review",
        itemCount: 1,
        attachments: [],
        acknowledgment: { expectedFingerprint: "snapshot" },
      }),
    call: async (name: string) => {
      calls.push(name);
      if (name === "artifacts_listen")
        throw new AppError("forbidden", "No notification scope", 403);
    },
  } as unknown as Client;
  const output = spyOn(process.stdout, "write").mockImplementation(((
    _bytes: unknown,
    callback: (error?: Error) => void,
  ) => {
    callback(outputFails ? new Error("EPIPE") : undefined);
    return true;
  }) as typeof process.stdout.write);
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(artifactCommand(client, ["artifact", "comments", "artifact"], {})).rejects.toThrow(
      "EPIPE",
    );
    expect(calls).toEqual([]);
    outputFails = false;
    await artifactCommand(client, ["artifact", "comments", "artifact"], {});
    expect(calls).toEqual(["artifact_comments_ack", "artifacts_listen"]);
    expect(error.mock.calls[0][0]).toContain("subscription failed");
    calls.length = 0;
    await artifactCommand(client, ["artifact", "comments", "artifact"], { all: true });
    expect(calls).toEqual([]);
  } finally {
    output.mockRestore();
    error.mockRestore();
  }
});

test("watch gives archive priority during output and leaves the snapshot unacknowledged", async () => {
  let archived = false;
  const writes: string[] = [];
  const client = {
    operator: { operator_kind: "user" },
    request: async () =>
      Response.json({
        text: "Pending",
        itemCount: 1,
        attachments: [],
        acknowledgment: { expectedFingerprint: "snapshot" },
      }),
    call: async (name: string) => {
      if (name === "artifacts_get") return { state: archived ? "archived" : "active" };
      writes.push(name);
    },
  } as unknown as Client;
  const prior = process.exitCode;
  const output = spyOn(process.stdout, "write").mockImplementation(((
    _bytes: unknown,
    callback: (error?: Error) => void,
  ) => {
    archived = true;
    callback();
    return true;
  }) as typeof process.stdout.write);
  try {
    await artifactCommand(client, ["artifact", "watch", "artifact"], { timeout: "1" });
    expect(process.exitCode).toBe(0);
    expect(writes).toEqual([]);
  } finally {
    output.mockRestore();
    process.exitCode = prior;
  }
});
