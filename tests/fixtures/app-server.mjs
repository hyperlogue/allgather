// Synthetic Codex host for verify-tower-managed.ts. No model calls or tool execution.
// Implements only this runner's native methods; unsupported requests fail explicitly.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "-V") {
  console.log("codex-cli 0.166.0");
  process.exit(0);
}
const home = process.env.HOME;
const shell = process.env.SHELL ?? "/bin/bash";
if (!home || !isAbsolute(home) || !isAbsolute(shell))
  throw new Error("Fixture requires absolute HOME and SHELL paths");
const codexHome = process.env.CODEX_HOME ?? join(home, ".codex");
if (!isAbsolute(codexHome)) throw new Error("Fixture requires absolute CODEX_HOME");
const controlRoot = join(codexHome, "app-server-control");
const controlFile = join(controlRoot, "fixture-control.json");
const defaultSocket = join(controlRoot, "app-server-control.sock");
const reachable = (socketPath) =>
  new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.setTimeout(1000);
    const finish = (value) => {
      probe.destroy();
      resolve(value);
    };
    probe.once("connect", () => finish(true));
    probe.once("error", () => finish(false));
    probe.once("timeout", () => finish(false));
  });
function control() {
  return existsSync(controlFile) ? JSON.parse(readFileSync(controlFile, "utf8")) : null;
}
async function daemon(command) {
  if (!["start", "ensure", "status", "stop"].includes(command))
    throw new Error(`Unsupported fixture daemon command: ${command}`);
  mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  if (command === "start" || command === "ensure") {
    if (!(await reachable(defaultSocket))) {
      const log = openSync(join(controlRoot, "fixture-host.log"), "a", 0o600);
      const child = spawn(
        process.execPath,
        ["--no-env-file", process.argv[1], "app-server", "--listen", `unix://${defaultSocket}`],
        {
          detached: true,
          stdio: ["ignore", log, log],
          env: process.env,
        },
      );
      closeSync(log);
      let spawnError;
      child.on("error", (error) => {
        spawnError = error;
      });
      child.unref();
      const deadline = Date.now() + 10000;
      while (!(await reachable(defaultSocket))) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || Date.now() >= deadline)
          throw new Error("Synthetic Codex daemon failed to start; inspect fixture-host.log");
        await Bun.sleep(25);
      }
    }
  }
  const current = control();
  if (command === "stop" && current && (await reachable(current.socket))) {
    const response = await fetch("http://localhost/__fixture/stop", {
      unix: current.socket,
      method: "POST",
      headers: { authorization: `Bearer ${current.token}` },
    });
    if (!response.ok) throw new Error("Synthetic Codex daemon refused shutdown");
    await response.text();
    const deadline = Date.now() + 10000;
    while (await reachable(current.socket)) {
      if (Date.now() >= deadline) throw new Error("Synthetic Codex daemon did not stop");
      await Bun.sleep(25);
    }
  }
  const running = current && (await reachable(current.socket));
  console.log(
    JSON.stringify({
      status: running ? "running" : "stopped",
      socketPath: current?.socket ?? defaultSocket,
      ...(running ? { pid: current.pid } : {}),
    }),
  );
}
if (args[0] === "app-server" && args[1] === "daemon") {
  await daemon(args[2]);
  process.exit(0);
}
const listen = args.indexOf("--listen");
const endpoint = listen > 0 ? args[listen + 1] : undefined;
if (args[0] !== "app-server" || !endpoint?.startsWith("unix://") || !isAbsolute(endpoint.slice(7)))
  throw new Error("Fixture requires app-server --listen unix://PATH");
const socketPath = endpoint.slice(7);
mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
const token = randomUUID();

const threads = new Map();
let nextThread = 0;
let nextTurn = 0;
const send = (socket, message) => socket.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
const reply = (socket, id, result) => send(socket, { id, result });
function heldByExternalClient(thread) {
  const path = join(home, "held-native-thread");
  return existsSync(path) && readFileSync(path, "utf8").trim() === thread.id;
}
const status = (thread) => ({
  type:
    !thread.subscribers.size && !thread.active && !heldByExternalClient(thread)
      ? "notLoaded"
      : thread.active
        ? "active"
        : "idle",
  ...(thread.active ? { activeFlags: thread.approval ? ["waitingOnApproval"] : [] } : {}),
});
const view = (thread) => ({
  id: thread.id,
  cwd: thread.cwd,
  status: status(thread),
  turns: thread.turns,
});
function notify(thread, method, params) {
  for (const socket of thread.subscribers)
    send(socket, { method, params: { threadId: thread.id, ...params } });
}
function finish(thread, outcome) {
  if (!thread.active) return;
  if (thread.approval) notify(thread, "serverRequest/resolved", { requestId: thread.approval.id });
  thread.approval = null;
  if (outcome === "completed")
    notify(thread, "item/agentMessage/delta", {
      turnId: thread.active.id,
      itemId: `message-${thread.active.id}`,
      delta: "Synthetic turn finished.",
    });
  thread.active.status = outcome;
  notify(thread, "turn/completed", { turn: thread.active });
  thread.active = null;
  notify(thread, "thread/status/changed", { status: status(thread) });
}
function receive(socket, message) {
  const { id, method, params = {} } = message;
  const thread = threads.get(params.threadId);
  if (!method) {
    const pending = [...threads.values()].find(
      (t) => t.approval?.id === id && t.approval.socket === socket,
    );
    if (!pending) throw new Error("No live approval matches this reply");
    const decision = message.result?.decision;
    if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision))
      throw new Error("Invalid approval decision");
    finish(pending, decision === "decline" || decision === "cancel" ? "interrupted" : "completed");
    return;
  }
  if (method === "initialize") {
    if (socket.data.initialized) throw new Error("Already initialized");
    socket.data.initialized = true;
    reply(socket, id, { userAgent: "codex-app-server/0.166.0" });
    return;
  }
  if (!socket.data.initialized) throw new Error("Initialize first");
  if (method === "initialized") return;
  if (id === undefined) throw new Error("Request ID required");
  if (
    (method.startsWith("thread/") || method.startsWith("turn/")) &&
    !["thread/start", "thread/list", "thread/loaded/list"].includes(method) &&
    !thread
  )
    throw new Error("Unknown native thread");
  switch (method) {
    case "environment/info":
      reply(socket, id, { environment: { id: "local", cwd: home, shell: { path: shell } } });
      break;
    case "config/read":
      reply(socket, id, { config: { allow_login_shell: true, features: {}, mcp_servers: {} } });
      break;
    case "thread/start":
    case "thread/resume": {
      appendFileSync(
        join(home, "native-opens.jsonl"),
        JSON.stringify({ method, thread_id: thread?.id ?? null }) + "\n",
        { mode: 0o600 },
      );
      const current = thread ?? {
        id: `fixture-thread-${++nextThread}`,
        cwd: params.cwd,
        subscribers: new Set(),
        active: null,
        approval: null,
        turns: [],
      };
      threads.set(current.id, current);
      current.subscribers.add(socket);
      reply(socket, id, { thread: view(current) });
      notify(current, "thread/status/changed", { status: status(current) });
      break;
    }
    case "thread/read":
      reply(socket, id, { thread: view(thread) });
      break;
    case "thread/list":
      reply(socket, id, { data: [...threads.values()].map(view), nextCursor: null });
      break;
    case "thread/loaded/list":
      reply(socket, id, {
        data: [...threads.values()]
          .filter((t) => t.subscribers.size || t.active || heldByExternalClient(t))
          .map((t) => t.id),
        nextCursor: null,
      });
      break;
    case "thread/turns/list":
      reply(socket, id, {
        data: thread.turns
          .slice()
          .reverse()
          .slice(0, params.limit ?? 100),
        nextCursor: null,
      });
      break;
    case "thread/goal/get":
      reply(socket, id, { goal: null });
      break;
    case "thread/backgroundTerminals/list":
      reply(socket, id, { data: [], nextCursor: null });
      break;
    case "thread/unsubscribe": {
      const removed = thread.subscribers.delete(socket);
      reply(socket, id, { status: removed ? "unsubscribed" : "notSubscribed" });
      break;
    }
    case "turn/start": {
      if (!thread.subscribers.has(socket) || thread.active)
        throw new Error("Thread is unavailable");
      if (
        !Array.isArray(params.input) ||
        !params.input.length ||
        params.input.some((b) => b.type !== "text" || typeof b.text !== "string")
      )
        throw new Error("Fixture accepts text input only");
      const text = params.input.map((b) => b.text).join(" ");
      appendFileSync(
        join(home, "dispatches"),
        JSON.stringify({ thread_id: thread.id, method, text }) + "\n",
        { mode: 0o600 },
      );
      thread.active = { id: `turn-${++nextTurn}`, status: "inProgress" };
      thread.turns.push(thread.active);
      reply(socket, id, { turn: thread.active });
      notify(thread, "turn/started", { turn: thread.active });
      if (text.includes("permission")) {
        thread.approval = { id: `approval-${nextTurn}`, socket };
        send(socket, {
          id: thread.approval.id,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: thread.id,
            turnId: thread.active.id,
            itemId: `tool-${nextTurn}`,
            command: "synthetic-private-request: no executable tool is invoked",
          },
        });
        notify(thread, "thread/status/changed", { status: status(thread) });
      } else if (!text.includes("hold")) finish(thread, "completed");
      break;
    }
    case "turn/interrupt":
      if (!thread.active || thread.active.id !== params.turnId)
        throw new Error("Turn is not active");
      reply(socket, id, {});
      finish(thread, "interrupted");
      break;
    default:
      send(socket, {
        id,
        error: { code: -32601, message: `Unsupported fixture method: ${method}` },
      });
  }
}

const server = Bun.serve({
  unix: socketPath,
  fetch(request, server) {
    if (new URL(request.url).pathname === "/__fixture/stop") {
      if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response("Forbidden", { status: 403 });
      setTimeout(() => void shutdown(), 10);
      return new Response("Stopping");
    }
    if (server.upgrade(request, { data: { initialized: false } })) return;
    return new Response("WebSocket required", { status: 400 });
  },
  websocket: {
    maxPayloadLength: 1024 * 1024,
    message(socket, bytes) {
      let message;
      try {
        message = JSON.parse(String(bytes));
        receive(socket, message);
      } catch (error) {
        if (message?.id !== undefined && message.method)
          send(socket, { id: message.id, error: { code: -32602, message: error.message } });
        else socket.close(1008, "Invalid fixture message");
      }
    },
    close(socket) {
      for (const thread of threads.values()) {
        thread.subscribers.delete(socket);
        if (thread.approval?.socket === socket) thread.approval = null;
      }
    },
  },
});
chmodSync(socketPath, 0o600);
writeFileSync(controlFile, JSON.stringify({ pid: process.pid, socket: socketPath, token }), {
  mode: 0o600,
});
appendFileSync(join(home, "hosts.jsonl"), JSON.stringify({ pid: process.pid }) + "\n", {
  mode: 0o600,
});
async function shutdown() {
  await server.stop(true);
  if (control()?.token === token) rmSync(controlFile, { force: true });
  rmSync(socketPath, { force: true });
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
