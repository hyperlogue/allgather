import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import type { Machine, Principal } from "../shared/contracts.ts";
import type { TowerPolicyRule } from "../shared/tower-policy.ts";
import { stopFixturePool, towerFixture } from "./tower-fixture.ts";

const bundle = towerFixture("allgather-real-tower-");
const { root } = bundle;
const dataDir = join(root, "allgather");
let running = await startServer({
  dataDir,
  port: 0,
  publicUrl: "http://127.0.0.1:0",
  gitSyncSeconds: 0,
});
const owner: Principal = { id: "owner", kind: "owner", scopes: ["admin"], inlet: "browser" };
const machine = running.workspace.execute(
  "machines_create",
  { name: "Protocol integration", operation_key: randomUUID() },
  owner,
) as Machine;
const key = running.workspace.executions.issueCredential(machine.id, "Temporary integration test");
const remoteRule: TowerPolicyRule = {
  id: "remote.deny",
  from: "*",
  to: "*",
  action: "deny",
  created_by: "owner",
  created_at: Date.now(),
};
running.workspace.execute(
  "machines_update",
  {
    machine_id: machine.id,
    expected_revision: 1,
    policy: [remoteRule],
    operation_key: randomUUID(),
  },
  owner,
);
const config = join(root, "config", "tower");
mkdirSync(config, { recursive: true, mode: 0o700 });
writeFileSync(
  join(config, "config.toml"),
  `[scan]\nenabled=false\n[allgather]\nurl = "${running.settings.publicUrl.replace("http:", "ws:")}/tower"\npolicy_id = "tower"\nclient_id = "tower"\n`,
  { mode: 0o600 },
);
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TOKIO_WORKER_THREADS: "2",
  HOME: join(root, "home"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
};
mkdirSync(env.HOME!, { recursive: true, mode: 0o700 });
mkdirSync(env.XDG_RUNTIME_DIR!, { recursive: true, mode: 0o700 });
const daemon = Bun.spawn([bundle.server, "run"], {
  env,
  cwd: root,
  stdout: "ignore",
  stderr: Bun.file(join(root, "tower.log")),
});
interface RpcReply {
  error?: { message?: string; data?: { code?: string } };
  [key: string]: unknown;
}
async function raw(args: string[], input?: string) {
  const p = Bun.spawn([bundle.cli, "--no-start", "--json", ...args], {
    env,
    cwd: root,
    stdin: input ? new Blob([input]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  let body: RpcReply;
  try {
    body = JSON.parse(out);
  } catch {
    throw new Error((err || "Tower did not return JSON").replaceAll(key.access_key, "[redacted]"));
  }
  return { body, code };
}
async function rpc<T>(method: string, params: unknown = {}): Promise<T> {
  const r = await raw(["rpc", method, JSON.stringify(params)]);
  if (r.code) throw new Error(r.body.error?.message ?? "Tower RPC failed");
  return r.body as T;
}
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error("Timed out waiting for the real Tower/Allgather state");
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
interface Status {
  mode: string;
  connected: boolean;
  policy_revision: number | null;
  policy_stale: boolean;
}
interface Rules {
  local_rules: TowerPolicyRule[];
  allgather_rules: TowerPolicyRule[];
  policy_revision: number | null;
}
try {
  await until(async () => {
    try {
      await rpc("daemon.info");
      return true;
    } catch {
      return false;
    }
  });
  await rpc("rules.put", {
    rule: {
      id: "local.allow",
      kind: "session",
      from: "*",
      to: "*",
      action: "allow",
      created_by: "fixture",
      created_at: 1,
    },
  });
  const login = await raw(["login", "--key-stdin"], key.access_key);
  assert(login.code === 0, "Machine-key login failed");
  await until(async () => {
    const s = await rpc<Status>("allgather.status");
    return (
      s.connected &&
      s.policy_revision === 2 &&
      running.workspace.executions.machine(machine.id).policy_status === "applied"
    );
  });
  let rules = await rpc<Rules>("rules.list");
  assert(
    rules.local_rules.some((r) => r.id === "local.allow"),
    "Remote policy replaced a local rule",
  );
  assert(
    rules.allgather_rules.length === 1 && rules.allgather_rules[0].id === "remote.deny",
    "Nonempty remote policy was not applied",
  );
  const registered = await rpc<{ id: string }>("agent.register", {
    harness: "fixture",
    cwd: root,
    native_session_id: null,
    pid: null,
    display_name: "Metadata fixture",
  });
  await until(async () => {
    const projection = running.workspace.one<{ record: string }>(
      "SELECT record FROM tower_records WHERE machine_id=? AND tower_id=?",
      machine.id,
      registered.id,
    );
    const record = await rpc<{ sync_state: string }>("agent.get", { id: registered.id });
    return !!projection && record.sync_state === "synced";
  });
  const projection = JSON.parse(
    running.workspace.one<{ record: string }>(
      "SELECT record FROM tower_records WHERE machine_id=? AND tower_id=?",
      machine.id,
      registered.id,
    )!.record,
  );
  assert(
    projection.display_name === "Metadata fixture" && !("token" in projection),
    "Incorrect public status projection",
  );
  const forbidden = await fetch(running.settings.publicUrl + "/api/operations/tasks_search", {
    method: "POST",
    headers: { authorization: `Bearer ${key.access_key}`, "content-type": "application/json" },
    body: "{}",
  });
  assert(forbidden.status === 401, "Machine key gained generic API authority");
  await forbidden.arrayBuffer();
  const settings = {
    dataDir,
    port: running.settings.port,
    publicUrl: running.settings.publicUrl,
    gitSyncSeconds: 0,
  };
  await running.stop();
  await until(async () => !(await rpc<Status>("allgather.status")).connected);
  const offline = await rpc<Status>("allgather.status");
  assert(
    offline.mode === "allgather" && offline.policy_revision === 2 && offline.policy_stale,
    "Disconnect discarded enrollment or cached policy",
  );
  const denied = await raw([
    "rpc",
    "session.open",
    JSON.stringify({ harness: "fixture", cwd: root }),
  ]);
  assert(
    denied.code !== 0 && denied.body.error?.data?.code === "denied",
    "Cached remote deny did not prevent an offline start",
  );
  await rpc("rules.put", {
    rule: {
      id: "local.offline",
      kind: "session",
      from: "human",
      to: "*",
      action: "allow",
      created_by: "fixture",
      created_at: 1,
    },
  });
  rules = await rpc<Rules>("rules.list");
  assert(
    rules.local_rules.some((r) => r.id === "local.offline") &&
      rules.allgather_rules[0]?.id === "remote.deny",
    "Offline local administration changed the remote policy",
  );
  running = await startServer(settings);
  await until(async () => {
    const s = await rpc<Status>("allgather.status");
    return (
      s.connected &&
      running.workspace.executions.machine(machine.id).policy_status === "applied" &&
      !!running.workspace.one(
        "SELECT 1 FROM tower_records WHERE machine_id=? AND tower_id=?",
        machine.id,
        registered.id,
      )
    );
  });
  running.workspace.executions.revokeCredential(key.id);
  running.workspace.onChange();
  await until(() => !running.workspace.executions.machine(machine.id).connected);
  await until(async () => !(await rpc<Status>("allgather.status")).connected);
  assert(
    (await rpc<Status>("allgather.status")).mode === "allgather",
    "Key revocation silently switched Tower to standalone",
  );
  console.log(
    "Real Tower integration passed: machine-key enrollment, handshake, nonempty policy and ACK, local/remote rule separation, public record and status ACK, reconnect/full resync, offline deny and local administration, API isolation, key revocation.",
  );
} finally {
  daemon.kill("SIGTERM");
  await daemon.exited;
  await stopFixturePool(bundle, env);
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}
