import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Auth, secret } from "./auth.ts";
import { backupWorkspace } from "./backup.ts";
import type { Config } from "./config.ts";
import type { Workspace } from "./workspace.ts";

interface ControlRecord {
  port: number;
  token: string;
  instance: string;
  pid: number;
}
export interface ServerStatus {
  state: "running" | "stopping" | "stopped" | "unreachable";
  instance?: string;
  pid?: number;
  settings?: Config;
}
const recordPath = (directory: string) => join(directory, "server-control.json");
function record(directory: string): ControlRecord | null {
  try {
    return JSON.parse(readFileSync(recordPath(directory), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function controlRequest(
  directory: string,
  action: string,
  body?: unknown,
  expectedInstance?: string,
) {
  const saved = record(directory);
  if (!saved) throw new Error("The local server is not running. Run allgather-server start first.");
  if (expectedInstance && saved.instance !== expectedInstance)
    throw new Error("The local server instance changed; the request was not sent.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), action === "backup" ? 120000 : 3000);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${saved.port}/${action}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${saved.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`Local server: ${await response.text()}`);
  return response;
}
export async function serverStatus(directory: string): Promise<ServerStatus> {
  const saved = record(directory);
  if (saved) {
    try {
      const status = (await (await controlRequest(directory, "status")).json()) as ServerStatus;
      if (status.instance !== saved.instance) throw new Error("Local server identity changed");
      return status;
    } catch {}
  }
  const lock = join(directory, "server.lock");
  let lockValue: string;
  try {
    lockValue = readFileSync(lock, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "stopped" };
    throw error;
  }
  const pid = Number(lockValue);
  if (!Number.isInteger(pid) || pid <= 0) return { state: "unreachable" };
  try {
    process.kill(pid, 0);
    return { state: "unreachable", pid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { state: "unreachable", pid };
  }
  return { state: "stopped" };
}
export function startLocalControl(
  settings: Config,
  workspace: Workspace,
  shutdown: () => Promise<void>,
) {
  const token = secret(),
    instance = secret();
  const auth = new Auth(workspace.db, settings.ownerUrl);
  let stopping = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    maxRequestBodySize: 64 * 1024,
    async fetch(request) {
      if (
        request.headers.has("origin") ||
        request.headers.get("authorization") !== `Bearer ${token}`
      )
        return new Response("Local server authorization required", { status: 403 });
      const path = new URL(request.url).pathname;
      if (path === "/status" && request.method === "GET")
        return Response.json({
          state: stopping ? "stopping" : "running",
          instance,
          pid: process.pid,
          settings,
        });
      if (stopping) return new Response("Server is stopping", { status: 409 });
      try {
        if (path === "/stop" && request.method === "POST") {
          stopping = true;
          setTimeout(() => {
            void shutdown().catch((error) => {
              console.error(error);
              process.exitCode = 1;
            });
          }, 0);
          return Response.json({ state: "stopping", instance });
        }
        if (path === "/backup" && request.method === "GET")
          return new Response(backupWorkspace(workspace), {
            headers: { "content-type": "application/zip" },
          });
        if (path === "/auth/reset" && request.method === "POST") {
          auth.resetAccess();
          workspace.onChange();
          return Response.json({ reset: true });
        }
        if (path === "/auth/list-tokens" && request.method === "GET")
          return Response.json(auth.loginTokens());
        if (path === "/auth/create-token" && request.method === "POST") {
          const input = (await request.json()) as { label?: string };
          return Response.json(auth.createLoginToken(input.label));
        }
        if (path === "/auth/revoke-token" && request.method === "POST") {
          const input = (await request.json()) as { id?: string };
          if (!input.id || typeof input.id !== "string") throw new Error("Supply a token ID");
          auth.revokeLoginToken(input.id);
          return Response.json({ revoked: true });
        }
        return new Response("Unknown local control action", { status: 404 });
      } catch (error) {
        return new Response(error instanceof Error ? error.message : "Local control failed", {
          status: 400,
        });
      }
    },
  });
  const path = recordPath(settings.dataDir),
    temporary = `${path}.${instance}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ port: server.port, token, instance, pid: process.pid }),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, path);
  } catch (error) {
    void server.stop(true);
    throw error;
  }
  return {
    beginShutdown() {
      stopping = true;
    },
    async close() {
      stopping = true;
      await server.stop(true);
      if (record(settings.dataDir)?.instance === instance) unlinkSync(path);
    },
  };
}
