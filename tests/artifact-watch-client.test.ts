import { expect, test } from "bun:test";
import { watchArtifact } from "../cli/artifact-watch.ts";
import type { Client } from "../cli/client.ts";

function clientWith(chunks: string[]) {
  const requests: unknown[][] = [];
  let cancelled = false;
  const client = {
    operator: { operator_kind: "user" },
    request: async (...args: unknown[]) => {
      requests.push(args);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  } as unknown as Client;
  return { client, requests, cancelled: () => cancelled };
}

test("CLI consumes fragmented SSE results in one request and closes the stream", async () => {
  const f = clientWith([
    "event: ready\r\ndata: {}\r\n\r\nevent: heart",
    'beat\ndata: {}\n\nevent: result\ndata: {"result":',
    '"superseded"}\n\n',
  ]);
  expect(await watchArtifact(f.client, "artifact", 5)).toEqual({ result: "superseded" });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject([
    "/api/artifacts/artifact/watch",
    { operator_kind: "user", timeout_ms: 5000 },
    { stream: true },
  ]);
  expect(f.cancelled()).toBe(true);
});

test("CLI reports SSE authorization errors and rejects truncated streams without retrying takeover", async () => {
  const f = clientWith(['event: error\ndata: {"message":"Access revoked"}\n\n']);
  await expect(watchArtifact(f.client, "artifact", 1)).rejects.toThrow("Access revoked");
  expect(f.cancelled()).toBe(true);
  let count = 0;
  const client = {
    operator: {},
    request: async () => {
      count++;
      return new Response("event: ready\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  } as unknown as Client;
  await expect(watchArtifact(client, "artifact", 1)).rejects.toThrow(
    "disconnected before a result",
  );
  expect(count).toBe(1);
});
