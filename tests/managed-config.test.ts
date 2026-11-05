import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../server/auth.ts";
import { config } from "../server/config.ts";
import { startServer } from "../server/index.ts";
import type { Machine, SessionCommand } from "../shared/contracts.ts";
import { fullControls } from "./fixtures/tower-controls.ts";

test("managed sessions default on with validated explicit opt-outs", () => {
  const previous = process.env.ALLGATHER_MANAGED_SESSIONS;
  try {
    delete process.env.ALLGATHER_MANAGED_SESSIONS;
    expect(config().managedSessions).toBe(true);
    expect(config({ managedSessions: false }).managedSessions).toBe(false);
    process.env.ALLGATHER_MANAGED_SESSIONS = "false";
    expect(config().managedSessions).toBe(false);
    expect(config({ managedSessions: true }).managedSessions).toBe(true);
    process.env.ALLGATHER_MANAGED_SESSIONS = "typo";
    expect(() => config()).toThrow("must be true or false");
  } finally {
    if (previous === undefined) delete process.env.ALLGATHER_MANAGED_SESSIONS;
    else process.env.ALLGATHER_MANAGED_SESSIONS = previous;
  }
});

test("normal handshake exposes support without granting control, and opt-out suppresses it", async () => {
  const previous = process.env.ALLGATHER_MANAGED_SESSIONS;
  delete process.env.ALLGATHER_MANAGED_SESSIONS;
  const NativeSocket = WebSocket as unknown as {
    new (url: string, options: { headers: Record<string, string> }): WebSocket;
  };
  try {
    for (const enabled of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), "allgather-managed-config-"));
      const running = await startServer({
        dataDir: root,
        port: 0,
        ownerUrl: "http://127.0.0.1:0",
        gitSyncSeconds: 0,
        ...(enabled ? {} : { managedSessions: false }),
      });
      let socket: WebSocket | undefined;
      try {
        const w = running.workspace,
          auth = new Auth(w.db, running.settings.ownerUrl);
        const cookie = auth.signIn(auth.createLoginToken("Fixture").token).split(";")[0];
        const principal = auth.principal(new Request(auth.baseUrl, { headers: { cookie } }))!;
        const machine = w.execute(
          "machines_create",
          { name: "Fixture", operation_key: randomUUID() },
          principal,
        ) as Machine;
        const key = w.executions.issueCredential(machine.id, "Read/send only");
        const frames: Record<string, any>[] = [];
        socket = new NativeSocket(running.settings.ownerUrl.replace("http:", "ws:") + "/tower", {
          headers: { authorization: `Bearer ${key.access_key}` },
        });
        socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
        await new Promise<void>((resolve, reject) => {
          socket!.onopen = () => resolve();
          socket!.onerror = () => reject(new Error("Socket failed"));
        });
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "hello",
            method: "hello",
            params: {
              protocol_version: { major: 1, minor: 4 },
              tower_version: "fixture",
              host_id: "fixture-host",
              capabilities: [
                "policy-sync.v1",
                "session-status.v1",
                "managed-acp.v1",
                "command-receipts.v1",
                "session-stream.v1",
              ],
              acp_harnesses: ["fixture"],
              harness_controls: { fixture: fullControls() },
            },
          }),
        );
        for (let i = 0; i < 100 && !frames.some((frame) => frame.id === "hello"); i++)
          await Bun.sleep(10);
        const capabilities = frames.find((frame) => frame.id === "hello")?.result?.capabilities;
        expect(capabilities).toContain("session-status.v1");
        expect(capabilities.includes("managed-acp.v1")).toBe(enabled);
        expect(w.executions.machine(machine.id).managed_enabled).toBe(enabled);
        const launch = () =>
          w.execute(
            "session_launch",
            {
              machine_id: machine.id,
              harness: "fixture",
              cwd: "/work/project",
              operation_key: randomUUID(),
            },
            principal,
          ) as { command: SessionCommand };
        if (enabled) {
          const valid = launch();
          expect(w.executions.managed.authority(valid.command.id)).not.toBeNull();
          const unbound = w.execute(
            "session_launch",
            {
              machine_id: machine.id,
              harness: "fixture",
              cwd: "/work/project",
              operation_key: randomUUID(),
            },
            { id: "owner", kind: "owner", scopes: ["admin"] },
          ) as { command: SessionCommand };
          expect(w.executions.managed.authority(unbound.command.id)).toBeNull();
          const policy = frames.find((frame) => frame.method === "policy.push")!;
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: policy.id,
              result: {
                policy_id: "tower",
                previous_revision: null,
                applied_revision: 1,
                outcome: "applied",
                changed_rule_ids: [],
                reason: null,
                received_at: Date.now(),
              },
            }),
          );
          await Bun.sleep(40);
          expect(frames.some((frame) => frame.method === "command.execute")).toBe(false);
        } else expect(launch).toThrow("disabled in server configuration");
      } finally {
        socket?.close();
        await running.stop();
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ALLGATHER_MANAGED_SESSIONS;
    else process.env.ALLGATHER_MANAGED_SESSIONS = previous;
  }
}, 15000);
