import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../server/index.ts";
import {
  type Machine,
  type Operation,
  operations,
  type SessionCommand,
  type SessionRuntime,
} from "../shared/contracts.ts";
import type { MachineScope } from "../shared/tower-acp.ts";
import { fixtureLogin, fixtureMcpToken } from "./fixture-auth.ts";
import { stopFixturePool, towerFixture } from "./tower-fixture.ts";

const bundle = towerFixture("allgather-terminal-integration-");
const harness = "pi";
const { root } = bundle;
const home = join(root, "home"),
  bin = join(root, "bin"),
  project = join(root, "project"),
  config = join(root, "config", "tower");
for (const path of [home, bin, project, config, join(root, "runtime")])
  mkdirSync(path, { recursive: true, mode: 0o700 });
writeFileSync(join(home, ".allgather-terminal-fixture"), "synthetic", { mode: 0o600 });
writeFileSync(
  join(bin, harness),
  `#!${process.execPath} --no-env-file\n${readFileSync(new URL("../tests/fixtures/terminal-harness.mjs", import.meta.url), "utf8")}`,
  { mode: 0o700 },
);
writeFileSync(
  join(config, "config.toml"),
  '[scan]\nenabled=false\n[allgather]\nscopes=["read","send","terminal:control"]\n',
  { mode: 0o600 },
);
const env = {
  PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  HOME: home,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  TOKIO_WORKER_THREADS: "2",
};
let running = await startServer({
  dataDir: join(root, "server"),
  port: 0,
  ownerUrl: "http://localhost:0",
  gitSyncSeconds: 0,
});
const origin = running.settings.ownerUrl;
let cookie = "",
  mcp: McpClient | undefined;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function command(executable: string, args: string[]) {
  const child = Bun.spawn([executable, ...args], {
    env,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(`${args[0]} failed: ${(err || out).slice(0, 500)}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
async function cli<T = Record<string, unknown>>(...args: string[]): Promise<T> {
  const out = await command(bundle.cli, ["--json", ...args]);
  return JSON.parse(out.trim() || "null") as T;
}
async function request(path: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${data.error?.code ?? response.status}`);
  return data;
}
const operation = async <T>(name: Operation, input: Record<string, unknown> = {}): Promise<T> =>
  (
    await request(`/api/operations/${name}`, {
      ...(operations[name].write ? { operation_key: randomUUID() } : {}),
      ...input,
    })
  ).result;
async function signIn() {
  cookie = await fixtureLogin(join(root, "server"), origin);
}
async function enroll(scopes: MachineScope[]) {
  const machines = await operation<Machine[]>("machines_list");
  const invitation = await request("/api/tower/invitations", {
    machine_id: machines[0]?.id,
    node_label: "Terminal fixture",
    scopes,
  });
  const child = Bun.spawn([bundle.cli, "--json", "login", origin, invitation.pairing_code], {
    env,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new Response(child.stdout).text(),
    errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const [out, err, code] = await Promise.all([output, errors, child.exited]);
    assert(
      code === 0 && /"state"\s*:\s*"complete"/.test(out),
      `Enrollment failed: ${err.slice(0, 300)}`,
    );
    assert(
      !/"(confirmation_token|access_key)"\s*:/.test(out),
      "Enrollment printed a private credential",
    );
    await until(
      async () =>
        (await operation<Machine[]>("machines_list")).some(
          (m) => m.connected && m.connection_scopes.includes(scopes.at(-1)!),
        ),
      "enrolled connection",
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}
function starts(): { pid: number; cwd: string }[] {
  const path = join(home, "terminal-starts.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
async function runtime(id: string) {
  return (
    await operation<{ runtime: SessionRuntime }>("session_runtime_get", { target_session_id: id })
  ).runtime;
}
async function denied(
  name: Operation,
  input: Record<string, unknown>,
  expected = "unsupported_control",
) {
  const response = await fetch(origin + `/api/operations/${name}`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ operation_key: randomUUID(), ...input }),
  });
  const data = await response.json();
  assert(!response.ok && data.error?.code === expected, `${name} did not reject with ${expected}`);
}
async function connectMcp() {
  const { tokens } = await fixtureMcpToken(origin, cookie, {
    scopes: [
      "sessions:read",
      "sessions:launch",
      "sessions:prompt",
      "sessions:stop",
      "sessions:resume",
      "transcripts:read",
    ],
    name: "Terminal fixture MCP",
  });
  mcp = new McpClient({ name: "terminal-fixture", version: "1.0.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  return mcp;
}
try {
  await signIn();
  await enroll(["read", "send"]);
  let machine = (await operation<Machine[]>("machines_list"))[0];
  await denied(
    "session_launch",
    { machine_id: machine.id, mode: "terminal", harness, cwd: project },
    "control_scope_required",
  );
  assert(starts().length === 0, "Missing consent launched a process");
  await enroll(["read", "send", "terminal:control"]);
  await until(async () => {
    machine = (await operation<Machine[]>("machines_list"))[0];
    return !!machine.terminal_controls[harness] && machine.policy_status === "applied";
  }, "terminal descriptor and applied policy");
  await cli(
    "rpc",
    "rules.put",
    JSON.stringify({
      rule: {
        id: "fixture.allgather",
        from: "allgather",
        kind: "session",
        to: "*",
        action: "allow",
        created_by: "fixture",
        created_at: Date.now(),
      },
    }),
  );
  const input = {
    machine_id: machine.id,
    mode: "terminal",
    harness,
    cwd: project,
    operation_key: randomUUID(),
  };
  const launched = await operation<{ runtime: SessionRuntime; command: SessionCommand }>(
    "session_launch",
    input,
  );
  const id = launched.runtime.session_id;
  await until(
    async () => (await runtime(id)).state === "running" && starts().length === 1,
    "verified terminal launcher",
  );
  const initial = await runtime(id);
  assert(
    initial.protocol === "terminal" &&
      !initial.acp_session_id &&
      !!initial.tower_session_id &&
      !!initial.owner_id,
    "Terminal identity was not bound honestly",
  );
  const snapshot = await cli<{ cols: number; rows: number; buffer: string }>(
    "snapshot",
    initial.tower_session_id!,
  );
  assert(
    snapshot.cols === 80 &&
      snapshot.rows === 24 &&
      snapshot.buffer.includes("TERMINAL_OUTPUT_MUST_STAY_LOCAL"),
    "Initial local terminal snapshot did not match 80x24 fixture",
  );
  const retry = await operation<{ command: SessionCommand }>("session_launch", input);
  assert(
    retry.command.id === launched.command.id && starts().length === 1,
    "Exact launch retry created another process",
  );
  await denied("session_launch", { ...input, cwd: root }, "key_conflict");
  await denied("session_prompt", {
    target_session_id: id,
    content: [{ type: "text", text: "Do not inject" }],
  });
  await denied("session_configure", { target_session_id: id, config: {} });
  await denied("session_resume", { target_session_id: id, machine_id: machine.id, cwd: project });
  const sources = await operation<{ kind: string; format_version: string; coverage: string }[]>(
    "session_transcript_sources",
    { target_session_id: id },
  );
  assert(
    sources.length === 1 &&
      sources[0].kind === "terminal_lifecycle" &&
      sources[0].format_version === "terminal.v1" &&
      sources[0].coverage !== "complete",
    "Terminal lifecycle was mislabeled as transcript data",
  );
  const priorEvents = await operation<{ items: { id: string; kind: string; payload: unknown }[] }>(
    "session_transcript_events",
    { target_session_id: id },
  );
  assert(
    priorEvents.items.every((e) => e.kind === "runtime_state") &&
      !JSON.stringify(priorEvents).includes("TERMINAL_OUTPUT_MUST_STAY_LOCAL"),
    "PTY output reached Allgather",
  );
  const settings = { ...running.settings };
  await cli("daemon", "stop");
  await running.stop();
  running = await startServer(settings);
  await signIn();
  await cli("rpc", "daemon.info");
  await until(
    async () => (await runtime(id)).connected,
    "surviving terminal readiness after both servers restart",
  );
  const recovered = await runtime(id);
  for (const field of ["id", "generation", "owner_id", "tower_session_id"] as const)
    assert(recovered[field] === initial[field], `Restart changed ${field}`);
  assert(starts().length === 1, "Restart replayed terminal creation");
  const afterEvents = await operation<{ items: { id: string; kind: string }[] }>(
    "session_transcript_events",
    { target_session_id: id },
  );
  assert(
    priorEvents.items.every((e) => afterEvents.items.filter((x) => x.id === e.id).length === 1),
    "Event replay duplicated retained identities",
  );
  await operation("session_cancel", { target_session_id: id });
  await until(
    async () => (await runtime(id)).termination === "confirmed" && (await runtime(id)).fenced === 1,
    "confirmed terminal stop",
  );
  await until(() => {
    try {
      process.kill(starts()[0].pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH";
    }
  }, "fixture process exit");
  const client = await connectMcp();
  const mcpLaunch = await client.callTool({
    name: "session_launch",
    arguments: { ...input, operation_key: randomUUID() },
  });
  assert(!mcpLaunch.isError, "MCP terminal launch failed");
  const second = (mcpLaunch.structuredContent as { result: { runtime: SessionRuntime } }).result
    .runtime;
  await until(
    async () => (await runtime(second.session_id)).state === "running" && starts().length === 2,
    "MCP terminal launcher",
  );
  const unsupported = await client.callTool({
    name: "session_prompt",
    arguments: {
      target_session_id: second.session_id,
      content: [{ type: "text", text: "Unsupported" }],
      operation_key: randomUUID(),
    },
  });
  assert(
    unsupported.isError === true && JSON.stringify(unsupported).includes("unsupported_control"),
    "MCP silently accepted an unsupported terminal prompt",
  );
  await command(bundle.pool, ["stop"]);
  await until(async () => !!(await runtime(second.session_id)).fenced, "pool loss fencing");
  await cli("daemon", "stop");
  await cli("rpc", "daemon.info");
  await until(
    async () => (await operation<Machine[]>("machines_list"))[0].connected,
    "daemon recovery after pool loss",
  );
  assert(
    starts().length === 2 && (await runtime(second.session_id)).generation === second.generation,
    "Pool loss silently recreated a terminal generation",
  );
  console.log(
    "Terminal integration passed: real three-binary Tower, synthetic named pi terminal fixture, explicit enrollment consent, HTTP and MCP launch, 80x24 local snapshot, exact retry/no duplicate, unsupported controls, lifecycle-only source, same owner/generation over both restarts, confirmed stop, and pool-loss fencing without replay. No installed native CLI or live provider claim.",
  );
} finally {
  await mcp?.close();
  try {
    const records = await cli<{ id: string }[]>("ls", "--ownership", "owned");
    for (const record of records) await cli("kill", record.id).catch(() => {});
  } catch {}
  await cli("--no-start", "daemon", "stop").catch(() => {});
  await stopFixturePool(bundle, env);
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}
