import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureResources } from "../scripts/fixture-auth.ts";
import { startServer } from "../server/index.ts";
import {
  type Machine,
  type Operation,
  operations,
  type Principal,
  type SessionCommand,
  type SessionRuntime,
} from "../shared/contracts.ts";
import { fixtureAgent, fixtureOwner, fullControls } from "./fixtures/tower-controls.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for Tower state");
}
test("Tower authentication, durable command receipts, transcript replay, and live request guards", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-tower-")),
    server = await startServer({
      dataDir: root,
      port: 0,
      ownerUrl: "http://localhost:0",
      gitSyncSeconds: 0,
      managedSessions: true,
    }),
    w = server.workspace;
  const owner = fixtureOwner(w);
  let socket: WebSocket | undefined;
  const call = <T>(name: Operation, input: Record<string, unknown> = {}, p = owner) =>
    w.execute(
      name,
      { ...(operations[name].write ? { operation_key: randomUUID() } : {}), ...input },
      p,
    ) as T;
  const NativeSocket = WebSocket as unknown as {
    new (url: string, options: { headers: Record<string, string> }): WebSocket;
  };
  const received: Record<string, unknown>[] = [];
  const connect = async (token: string) => {
    const s = new NativeSocket(server.settings.ownerUrl.replace("http:", "ws:") + "/tower", {
      headers: { authorization: `Bearer ${token}` },
    });
    s.onmessage = (e) => {
      const frame = JSON.parse(String(e.data));
      received.push(frame);
      if (frame.method === "policy.push")
        s.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              policy_id: "tower",
              previous_revision: null,
              applied_revision: frame.params.revision,
              outcome: "applied",
              changed_rule_ids: [],
              reason: null,
              received_at: Date.now(),
            },
          }),
        );
    };
    await new Promise<void>((resolve, reject) => {
      s.onopen = () => resolve();
      s.onerror = () => reject(new Error("Socket failed"));
    });
    s.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "hello",
        method: "hello",
        params: {
          protocol_version: { major: 1, minor: 4 },
          host_id: "test-host",
          tower_version: "test",
          capabilities: [
            "policy-sync.v1",
            "session-status.v1",
            "managed-acp.v1",
            "command-receipts.v1",
            "session-stream.v1",
          ],
          acp_harnesses: ["test-agent"],
          harness_controls: { "test-agent": fullControls() },
        },
      }),
    );
    await until(() => received.some((m) => m.id === "hello" && !!m.result));
    await until(() => w.one<{ n: number }>("SELECT count(*) n FROM machine_policy_reports")!.n > 0);
    return s;
  };
  try {
    const machine = call<Machine>("machines_create", { name: "Development" }),
      credential = w.executions.issueCredential(machine.id, "Test", [
        "read",
        "send",
        "acp:control",
      ]);
    expect(() =>
      call("session_launch", {
        machine_id: machine.id,
        harness: "test-agent",
        cwd: "/work/project",
      }),
    ).toThrow("advertise");
    socket = await connect(credential.access_key);
    call("sessions_declare", {
      target_session_id: "cli-before-managed",
      harness: "test-agent",
      source_namespace: "cli",
      native_session_id: "native-managed",
    });
    const launched = call<{ runtime: SessionRuntime; command: SessionCommand }>("session_launch", {
      machine_id: machine.id,
      harness: "test-agent",
      cwd: "/work/project",
    });
    await until(() => received.some((m) => m.id === launched.command.id));
    expect(received.filter((m) => m.id === launched.command.id)).toHaveLength(1);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: launched.command.id,
        result: {
          command_id: launched.command.id,
          runtime_id: launched.runtime.id,
          generation: launched.runtime.generation,
          receipt_revision: 1,
          state: "accepted",
          acceptance: { level: "adapter", at: new Date().toISOString() },
          dispatch: { state: "finished" },
          result: { tower_session_id: "tower-session", acp_session_id: "acp-session" },
        },
      }),
    );
    await until(() => w.executions.command(launched.command.id).state === "acknowledged");
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "ready",
        method: "session.events",
        params: {
          runtime_id: launched.runtime.id,
          generation: launched.runtime.generation,
          source_key: launched.runtime.generation,
          events: [
            {
              sequence: 1,
              key: "ready",
              kind: "runtime_state",
              command_id: launched.command.id,
              payload: {
                state: "idle",
                owner_id: "owner-fixture",
                tower_session_id: "tower-session",
                acp_session_id: "acp-session",
                native_session_id: "native-managed",
              },
            },
          ],
        },
      }),
    );
    await until(() => w.executions.runtime(launched.runtime.session_id)?.state === "idle");
    expect(w.sessions.get(launched.runtime.session_id).id).toBe("cli-before-managed");
    expect(w.executions.runtime("cli-before-managed")?.session_id).toBe(
      launched.runtime.session_id,
    );

    expect(() =>
      call("session_prompt", {
        target_session_id: launched.runtime.session_id,
        content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
      }),
    ).toThrow("session assets");
    const first = call<SessionCommand>("session_prompt", {
      target_session_id: launched.runtime.session_id,
      content: [{ type: "text", text: "Inspect this task" }],
    });
    await until(() => received.some((m) => m.id === first.id));
    expect(
      (received.find((m) => m.id === first.id)?.params as Record<string, unknown> | undefined)
        ?.session_id,
    ).toBe(launched.runtime.session_id);

    socket.close();
    await until(() => w.executions.command(first.id).state === "unknown");
    received.length = 0;
    socket = await connect(credential.access_key);
    await until(() => received.some((m) => m.id === `receipt:${first.id}`));
    expect(received.some((m) => m.id === first.id)).toBe(false);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `receipt:${first.id}`,
        error: { code: -32601, message: "No receipt" },
      }),
    );
    await Bun.sleep(30);
    expect(w.executions.command(first.id).state).toBe("unknown");
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `receipt:${first.id}`,
        result: {
          command_id: first.id,
          runtime_id: launched.runtime.id,
          generation: launched.runtime.generation,
          receipt_revision: 1,
          state: "accepted",
          acceptance: { level: "adapter", at: new Date().toISOString() },
          dispatch: { state: "in_flight" },
        },
      }),
    );
    await until(() => w.executions.command(first.id).state === "acknowledged");
    const base = {
        runtime_id: launched.runtime.id,
        generation: launched.runtime.generation,
        source_key: launched.runtime.generation,
      },
      events = [
        {
          sequence: 2,
          key: "event-one",
          kind: "agent_message",
          payload: { content: [{ type: "text", text: "Found a useful change" }] },
        },
        {
          sequence: 3,
          key: "permission-one",
          kind: "permission_request",
          payload: {
            toolCall: { toolCallId: "tool-1", title: "Run the tests" },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ],
          },
        },
      ];
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "events-one",
        method: "session.events",
        params: { ...base, events },
      }),
    );
    await until(() => received.some((m) => m.id === "events-one" && !!m.result));
    expect(
      call<{ items: unknown[] }>("session_transcript_events", {
        target_session_id: launched.runtime.session_id,
      }).items,
    ).toHaveLength(3);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "replay",
        method: "session.events",
        params: { ...base, events },
      }),
    );
    await until(() => received.some((m) => m.id === "replay" && !!m.result));
    expect(
      call<{ items: unknown[] }>("session_transcript_events", {
        target_session_id: launched.runtime.session_id,
      }).items,
    ).toHaveLength(3);
    expect(w.executions.runtime(launched.runtime.session_id)?.connected).toBe(false);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "reconnected-ready",
        method: "session.events",
        params: {
          ...base,
          events: [
            {
              sequence: 4,
              key: "reconnected-ready",
              kind: "runtime_state",
              payload: {
                state: "waiting",
                owner_id: "owner-fixture",
                tower_session_id: "tower-session",
                acp_session_id: "acp-session",
              },
            },
          ],
        },
      }),
    );
    await until(() => received.some((m) => m.id === "reconnected-ready" && !!m.result));
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "live-permission",
        method: "session.request",
        params: {
          runtime_id: launched.runtime.id,
          generation: launched.runtime.generation,
          owner_id: "owner-fixture",
          source_request_id: "permission-one",
          request_revision: 1,
          native_request_id: 1,
          kind: "permission",
          state: "pending",
          payload: events[1]!.payload,
        },
      }),
    );
    await until(() => received.some((m) => m.id === "live-permission" && !!m.result));
    const request = call<{ id: string; revision: number }[]>("session_requests", {
      target_session_id: launched.runtime.session_id,
    })[0];
    expect(() =>
      call("session_reply", {
        request_id: request.id,
        expected_revision: request.revision,
        response: { outcome: { outcome: "selected", optionId: "made-up" } },
      }),
    ).toThrow("offered");
    const reply = call<SessionCommand>("session_reply", {
      request_id: request.id,
      expected_revision: request.revision,
      response: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
    await until(() => received.some((m) => m.id === reply.id));
    expect(() =>
      call("session_reply", {
        request_id: request.id,
        expected_revision: request.revision,
        response: { outcome: { outcome: "cancelled" } },
      }),
    ).toThrow("no longer live");
    const reader: Principal = {
      id: "task-bot",
      kind: "client",
      resources: fixtureResources,
      scopes: ["tasks:read", "tasks:write"],
      inlet: "mcp",
    };
    expect(() =>
      call("session_transcript_events", { target_session_id: launched.runtime.session_id }, reader),
    ).toThrow("Scope");
    expect(() =>
      call(
        "session_prompt",
        {
          target_session_id: launched.runtime.session_id,
          content: [{ type: "text", text: "unauthorized" }],
        },
        reader,
      ),
    ).toThrow("Scope");
    const privateUrl = "https://auth.example.invalid/setup?ticket=private-test-token";
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "private-setup",
        method: "session.events",
        params: {
          ...base,
          events: [
            {
              sequence: 5,
              key: "setup-request",
              kind: "elicitation_request",
              payload: { mode: "url", url: privateUrl, message: "Sign in to the service" },
            },
          ],
        },
      }),
    );
    await until(() => received.some((m) => m.id === "private-setup" && !!m.result));
    expect(
      JSON.stringify(
        call("session_transcript_events", { target_session_id: launched.runtime.session_id }),
      ),
    ).not.toContain("private-test-token");
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "live-url",
        method: "session.request",
        params: {
          runtime_id: launched.runtime.id,
          generation: launched.runtime.generation,
          owner_id: "owner-fixture",
          source_request_id: "setup-request",
          request_revision: 1,
          native_request_id: 2,
          kind: "elicitation",
          state: "pending",
          payload: { mode: "url", url: privateUrl },
        },
      }),
    );
    await until(() => received.some((m) => m.id === "live-url" && !!m.result));
    expect(
      call<{ payload: { url?: string } }[]>("session_requests", {
        target_session_id: launched.runtime.session_id,
      }).some((r) => r.payload.url === privateUrl),
    ).toBe(true);
    call("session_transcript_import", {
      target_session_id: launched.runtime.session_id,
      source_key: "past",
      events: [{ key: "old-request", kind: "permission_request", payload: { options: [] } }],
    });
    expect(
      call<unknown[]>("session_requests", { target_session_id: launched.runtime.session_id }),
    ).toHaveLength(2);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "checkout",
        method: "checkout.push",
        params: { path: "/work/project" },
      }),
    );
    await until(() => received.some((m) => m.id === "checkout" && !!m.error));
    expect(call<unknown[]>("checkouts_list")).toHaveLength(0);
    call("sessions_declare", {
      target_session_id: "terminal-session",
      harness: "test-agent",
      source_namespace: "fixture",
      native_session_id: "terminal-native",
    });
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "state.push",
        params: {
          seq: 0,
          full: true,
          records: [
            {
              id: "tower-terminal",
              harness: "test-agent",
              native_session_id: "terminal-native",
              status: "idle",
              caps: { message: "hook" },
            },
          ],
        },
      }),
    );
    await until(() => !!w.one("SELECT 1 FROM tower_records WHERE tower_id='tower-terminal'"));
    const artifact = (await w.dispatch(
      "artifacts_create",
      { kind: "html", title: "Review", operation_key: randomUUID() },
      owner,
    )) as { id: string };
    await w.dispatch(
      "artifacts_listen",
      {
        artifact_id: artifact.id,
        session_id: "terminal-session",
        operator_kind: "agent",
        operation_key: randomUUID(),
      },
      await fixtureAgent(w, server.settings.ownerUrl),
    );
    await w.dispatch(
      "artifact_threads_add",
      {
        artifact_id: artifact.id,
        input: { body: "Please revise", target: { kind: "artifact" } },
        operation_key: randomUUID(),
      },
      owner,
    );
    await w.dispatch(
      "artifacts_submit",
      { artifact_id: artifact.id, operation_key: randomUUID() },
      owner,
    );
    await until(() => received.some((m) => m.method === "message.send"));
    const notification = received.find((m) => m.method === "message.send")!;
    expect(notification.params).toMatchObject({ to: "tower-terminal", from_label: "Allgather" });
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: notification.id,
        result: {
          state: "delivered",
          message_id: "delivery-1",
          method: "test",
          acknowledgement: "transport",
        },
      }),
    );
    await until(
      () =>
        w.one<{ state: string }>(
          "SELECT state FROM artifact_notifications WHERE id=?",
          String(notification.id),
        )?.state === "sent",
    );
    expect(w.artifacts!.conversations.hasPending(artifact.id)).toBe(true);
    expect(w.artifacts!.detail(artifact.id).delivery).toMatchObject({
      acknowledgement: "transport",
      message: expect.stringContaining("may hold or refuse"),
    });
    await w.dispatch(
      "artifacts_submit",
      { artifact_id: artifact.id, operation_key: randomUUID() },
      owner,
    );
    expect(received.filter((m) => m.method === "message.send")).toHaveLength(1);
    const archiving = w.dispatch(
      "artifacts_archive",
      {
        artifact_id: artifact.id,
        comment: "Proceed with implementation",
        operation_key: "archive-with-delivery",
      },
      owner,
    );
    await until(() => received.filter((m) => m.method === "message.send").length === 2);
    expect(w.artifacts!.store.get(artifact.id).state).toBe("active");
    const archiveNotice = received.filter((m) => m.method === "message.send")[1];
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: archiveNotice.id,
        result: { state: "delivered", message_id: "delivery-2", acknowledgement: "harness" },
      }),
    );
    const archived = (await archiving) as { notification: { acknowledgement: string } };
    expect(archived.notification.acknowledgement).toBe("harness");
    expect(w.artifacts!.store.get(artifact.id).state).toBe("archived");
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "end-and-late-state",
        method: "session.events",
        params: {
          ...base,
          events: [
            { sequence: 6, key: "end-runtime", kind: "runtime_state", payload: { state: "ended" } },
            { sequence: 7, key: "late-idle", kind: "runtime_state", payload: { state: "idle" } },
          ],
        },
      }),
    );
    await until(() => received.some((m) => m.id === "end-and-late-state" && !!m.result));
    expect(w.executions.runtime(launched.runtime.session_id)).toMatchObject({
      state: "ended",
      connected: false,
    });
    expect(
      call<{ state: string }[]>("session_requests", {
        target_session_id: launched.runtime.session_id,
      }).some((r) => r.state === "pending"),
    ).toBe(false);
    w.executions.revokeCredential(credential.id);
    w.onChange();
    await until(() => socket!.readyState === WebSocket.CLOSED);
    expect(w.executions.machine(machine.id).connected).toBe(false);
  } finally {
    socket?.close();
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
