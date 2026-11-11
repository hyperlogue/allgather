import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { startServer } from "../server/index.ts";
import {
  type Machine,
  type Operation,
  operations,
  type Project,
  type Repository,
} from "../shared/contracts.ts";
import type {
  CheckoutObservation,
  RepositoryCatalog,
  TowerCheckout,
} from "../shared/tower-catalog.ts";
import { fixtureLogin } from "./fixture-auth.ts";
import { stopFixturePool, towerFixture } from "./tower-fixture.ts";

// Actual Tower + Allgather + host Git. All data, credentials, and Git history are synthetic.
// The loopback relay forwards real frames unchanged; its trace retains only method/size metadata.
const bundle = towerFixture("ag-catalog-");
const { root } = bundle;
const home = join(root, "home"),
  config = join(root, "config", "tower"),
  binary = bundle.cli;
for (const path of [home, config, join(root, "runtime")])
  mkdirSync(path, { recursive: true, mode: 0o700 });
writeFileSync(
  join(config, "config.toml"),
  '[scan]\nenabled=false\n[allgather]\nscopes=["read","send"]\n',
  { mode: 0o600 },
);
const env = {
  PATH: process.env.PATH ?? dirname(process.execPath),
  HOME: home,
  XDG_STATE_HOME: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  TOKIO_WORKER_THREADS: "2",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "file",
};
interface Trace {
  direction: "tower" | "allgather";
  connection: number;
  method: string;
  bytes: number;
  ids: string[];
  revision?: number;
}
interface RelayData {
  upstream: WebSocket;
  connection: number;
  client?: ServerWebSocket<RelayData>;
  pending: string[];
}
const frames: Trace[] = [];
const peers = new Set<ServerWebSocket<RelayData>>();
const NativeSocket = WebSocket as unknown as {
  new (url: string, options: { headers: Record<string, string> }): WebSocket;
};
let destination = "",
  connection = 0;
function observe(direction: Trace["direction"], connection: number, body: string) {
  const frame = JSON.parse(body);
  if (typeof frame.method !== "string") return;
  const records = frame.params?.upserts ?? frame.params?.records;
  frames.push({
    direction,
    connection,
    method: frame.method,
    bytes: Buffer.byteLength(body),
    ids: Array.isArray(records) ? records.map((r: { id: string }) => r.id) : [],
    revision: frame.params?.revision,
  });
}
const relay = Bun.serve<RelayData>({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    if (!destination) return new Response("Starting", { status: 503 });
    const incoming = new URL(request.url),
      target = destination + incoming.pathname + incoming.search;
    if (incoming.pathname === "/tower") {
      const upstream = new NativeSocket(target.replace(/^http/, "ws"), {
        headers: { authorization: request.headers.get("authorization") ?? "", host: incoming.host },
      });
      const data: RelayData = { upstream, connection: ++connection, pending: [] };
      upstream.onopen = () => {
        for (const body of data.pending.splice(0)) upstream.send(body);
      };
      upstream.onmessage = (event) => {
        const body = String(event.data);
        observe("allgather", data.connection, body);
        data.client?.send(body);
      };
      upstream.onclose = () => data.client?.close(1001, "Upstream closed");
      upstream.onerror = () => data.client?.close(1011, "Upstream unavailable");
      if (server.upgrade(request, { data })) return;
      upstream.close();
      return new Response("WebSocket required", { status: 400 });
    }
    const headers = new Headers(request.headers);
    try {
      return await fetch(target, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      });
    } catch {
      return new Response("Upstream unavailable", { status: 503 });
    }
  },
  websocket: {
    maxPayloadLength: 1024 * 1024,
    open(socket) {
      socket.data.client = socket;
      peers.add(socket);
    },
    message(socket, bytes) {
      const body = String(bytes);
      observe("tower", socket.data.connection, body);
      if (socket.data.upstream.readyState === WebSocket.OPEN) socket.data.upstream.send(body);
      else if (socket.data.pending.length < 4) socket.data.pending.push(body);
      else socket.close(1011, "Upstream handshake unavailable");
    },
    close(socket) {
      peers.delete(socket);
      socket.data.upstream.close();
    },
  },
});
const origin = `http://localhost:${relay.port}`;
let running: Awaited<ReturnType<typeof startServer>> | undefined,
  online = false,
  cookie = "";
async function start(port = 0) {
  running = await startServer({
    dataDir: join(root, "server"),
    port,
    ownerUrl: origin,
    gitSyncSeconds: 0,
  });
  destination = `http://127.0.0.1:${running.settings.port}`;
  online = true;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(150);
  }
  throw new Error(`Timed out: ${what}`);
}
async function processOutput(
  args: string[],
  options: { input?: string; extra?: Record<string, string>; cwd?: string } = {},
) {
  const child = Bun.spawn(args, {
    env: { ...env, ...options.extra },
    cwd: options.cwd ?? root,
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
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
    return { out, err, code };
  } finally {
    clearTimeout(timer);
  }
}
async function cli<T>(
  args: string[],
  options: { input?: string; extra?: Record<string, string> } = {},
): Promise<T> {
  const result = await processOutput([binary, "--json", ...args], options);
  if (result.code !== 0)
    throw new Error(
      `Tower ${args.slice(0, 2).join(" ")}: ${(result.err || result.out).slice(0, 600)}`,
    );
  return result.out.trim() ? (JSON.parse(result.out) as T) : (null as T);
}
async function rejected(args: string[], code: string) {
  const result = await processOutput([binary, "--json", ...args]);
  assert(
    result.code !== 0 && (result.out + result.err).includes(code),
    `Expected Tower ${args.slice(0, 2).join(" ")} rejection ${code}; got ${result.out || result.err}`,
  );
}
async function git(cwd: string, ...args: string[]) {
  const result = await processOutput(["git", ...args], { cwd });
  assert(result.code === 0, `Git ${args[0]} failed: ${result.err}`);
  return result.out.trim();
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert(response.ok, `${path}: ${data.error?.code ?? response.status}`);
  return data as T;
}
async function operation<T>(name: Operation, input: Record<string, unknown> = {}): Promise<T> {
  return (
    await request<{ result: T }>(`/api/operations/${name}`, {
      ...input,
      ...(operations[name].write ? { operation_key: randomUUID() } : {}),
    })
  ).result;
}
const pathOf = (checkout: TowerCheckout) =>
  checkout.path.startsWith("~/") ? join(home, checkout.path.slice(2)) : checkout.path;
const local = () => cli<TowerCheckout[]>(["checkout", "list"]);
const catalog = () => cli<{ catalog: RepositoryCatalog | null; current: boolean }>(["catalog"]);
let machineId = "";
const observed = () =>
  operation<CheckoutObservation[]>("checkouts_list", {
    machine_id: machineId,
    include_removed: true,
  });
const observedOne = async (id: string) => (await observed()).find((c) => c.checkout_id === id);
const prepare = (id: string, kind: string, options: Record<string, unknown> = {}) =>
  cli<{ plan_id: string; state: string }>([
    "vcs",
    "prepare",
    id,
    kind,
    "--options",
    JSON.stringify(options),
  ]);
const execute = (plan: string) =>
  cli<{ plan_id: string; state: string; error?: unknown }>(["vcs", "execute", plan, "--wait"]);
async function connected() {
  await until(async () => {
    const m = await operation<Machine>("machines_get", { machine_id: machineId });
    return (
      m.connected &&
      m.policy_status === "applied" &&
      !!m.catalog_sync?.checkouts_current &&
      (await catalog()).current
    );
  }, "current catalog, policy and full checkout sync");
}
try {
  await start();
  cookie = await fixtureLogin(join(root, "server"), origin);
  const project = await operation<Project>("projects_create", { name: "Catalog fixture" });
  const repo = await operation<Repository>("repositories_create", {
    project_id: project.id,
    name: "Shared repo",
    upstream_url: "https://example.invalid/team/main.git",
    url_aliases: ["ssh://git@example.invalid/team/main.git"],
    sync_enabled: false,
  });
  const invitation = await request<{ pairing_code: string }>("/api/tower/invitations", {
    node_label: "Catalog fixture",
    scopes: ["read"],
  });
  const loggedIn = await processOutput([
    binary,
    "--json",
    "login",
    origin,
    invitation.pairing_code,
    "--read-only",
  ]);
  assert(
    loggedIn.code === 0 && /"state"\s*:\s*"complete"/.test(loggedIn.out),
    `Tower enrollment failed: ${loggedIn.err}`,
  );
  assert(
    loggedIn.out.includes(`${origin}/tower/enroll/`) &&
      !/(confirmation_token|access_key)/.test(loggedIn.out),
    "Enrollment output leaked credentials or lost its browser URL",
  );
  machineId = (await operation<Machine[]>("machines_list"))[0].id;
  await connected();
  assert(
    (await catalog()).catalog?.repositories.some(
      (r) => r.id === repo.id && r.project_ids.includes(project.id),
    ),
    "Catalog membership did not arrive",
  );
  console.log("Passed browser enrollment and initial full catalog/checkout sync.");
  await cli([
    "rpc",
    "rules.put",
    JSON.stringify({
      rule: {
        id: "allow.fixture.human",
        kind: "session",
        from: "human",
        to: "*",
        action: "allow",
        created_by: "fixture",
        created_at: Date.now(),
      },
    }),
  ]);
  const count = frames.length;
  await operation("projects_update", {
    project_id: project.id,
    expected_revision: project.revision,
    name: "Catalog fixture updated",
  });
  await until(
    async () =>
      (await catalog()).catalog?.projects.some(
        (p) => p.id === project.id && p.name === "Catalog fixture updated",
      ) ?? false,
    "catalog name delta",
  );
  const catalogDelta = frames.slice(count).find((f) => f.method === "catalog.delta");
  assert(catalogDelta, "Catalog update did not use a real delta");
  assert(
    catalogDelta.bytes < frames.find((f) => f.method === "catalog.push")!.bytes,
    "Catalog delta did not reduce traffic",
  );

  const mainPath = join(home, "main");
  mkdirSync(mainPath);
  await git(mainPath, "init", "-b", "main");
  await git(mainPath, "config", "user.name", "Fixture");
  await git(mainPath, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(mainPath, "file.txt"), "Initial local fixture\n");
  await git(mainPath, "add", "file.txt");
  await git(mainPath, "commit", "-m", "Initial fixture");
  await git(mainPath, "remote", "add", "origin", repo.upstream_url!);
  const main = (
    await cli<{ checkouts: TowerCheckout[] }>([
      "checkout",
      "register",
      mainPath,
      "--repository",
      repo.id,
    ])
  ).checkouts[0];
  const clonePath = join(home, "clone");
  await git(home, "clone", mainPath, clonePath);
  await git(clonePath, "remote", "set-url", "origin", repo.url_aliases[0]);
  const clone = (await cli<{ checkouts: TowerCheckout[] }>(["checkout", "register", clonePath]))
    .checkouts[0];
  assert(
    main.id !== clone.id && clone.repository_id === repo.id,
    `Clone identities or alias association were lost: ${JSON.stringify({ main_id: main.id, clone_id: clone.id, expected_repository_id: repo.id, clone_repository_id: clone.repository_id })}`,
  );
  await until(
    async () => !!(await observedOne(main.id)) && !!(await observedOne(clone.id)),
    "two clones in one repository",
  );
  const create = await prepare(main.id, "checkout.create", {
    name: "feature",
    target: { kind: "new_branch", branch: "feature" },
  });
  assert(
    (await execute(create.plan_id)).state === "completed",
    "Worktree creation did not complete",
  );
  assert(
    (await execute(create.plan_id)).state === "completed",
    "Completed plan retry was not idempotent",
  );
  await until(
    async () => (await local()).some((c) => c.branch === "feature"),
    "created checkout metadata refresh",
  );
  const feature = (await local()).find((c) => c.branch === "feature");
  assert(feature, "Created worktree is missing");
  await until(async () => !!(await observedOne(feature.id)), "created worktree projection");
  const stable = await cli<TowerCheckout>(["vcs", "status", feature.id]);
  const probe = await cli<TowerCheckout>(["vcs", "status", feature.id]);
  assert(
    stable.revision === probe.revision && stable.observed_at === probe.observed_at,
    "Timestamp-only probe changed equal-revision facts",
  );
  writeFileSync(join(pathOf(feature), "untracked.txt"), "Keep local work\n");
  await cli(["vcs", "status", feature.id]);
  await until(
    async () => (await observedOne(feature.id))?.dirty === true,
    "dirty observation delta",
  );
  await rejected(["vcs", "prepare", feature.id, "checkout.remove"], "dirty");
  assert(existsSync(join(pathOf(feature), "untracked.txt")), "Rejected removal changed local work");
  rmSync(join(pathOf(feature), "untracked.txt"));
  await cli(["vcs", "status", feature.id]);
  const agent = await cli<{ id: string; token: string }>([
    "register",
    "--harness",
    "fixture",
    "--cwd",
    pathOf(feature),
  ]);
  // Re-observation links registered sessions through Tower's normal checkout discovery.
  await cli(["checkout", "register", pathOf(feature), "--repository", repo.id]);
  await until(async () => {
    const m = await operation<Machine & { agents: { id: string; checkout_id?: string }[] }>(
      "machines_get",
      { machine_id: machineId },
    );
    return m.agents.some((record) => record.id === agent.id && record.checkout_id === feature.id);
  }, "negotiated session checkout reference");
  const move = await prepare(feature.id, "checkout.move", { name: "moved" });
  await rejected(["vcs", "execute", move.plan_id, "--wait"], "checkout_in_use");
  assert(existsSync(pathOf(feature)), "Active-session rejection moved the worktree");
  await cli(["unregister"], {
    extra: { TOWER_AGENT_ID: agent.id, TOWER_AGENT_TOKEN: agent.token },
  });
  assert((await execute(move.plan_id)).state === "completed", "Worktree move failed");
  await until(
    async () => (await cli<TowerCheckout>(["checkout", "get", feature.id])).path !== feature.path,
    "moved checkout metadata refresh",
  );
  const moved = await cli<TowerCheckout>(["checkout", "get", feature.id]);
  assert(
    moved.id === feature.id && moved.path !== feature.path && !existsSync(pathOf(feature)),
    "Move did not preserve checkout identity",
  );
  await until(
    async () => (await observedOne(feature.id))?.path === moved.path,
    "same-ID moved worktree observation",
  );
  const delta = frames.findLast((f) => f.method === "checkout.delta" && f.ids.includes(feature.id));
  assert(delta, "Checkout change did not cross the real channel as a delta");
  console.log(
    `Passed catalog delta (${catalogDelta.bytes} bytes), clone aliases, worktree create/move, dirty/active-session refusal, status checkout reference and checkout deltas.`,
  );

  await cli(["daemon", "stop"]);
  const reconnectMark = frames.length;
  await cli(["rpc", "daemon.info"]);
  await connected();
  assert(
    (await cli<TowerCheckout>(["checkout", "get", feature.id])).id === feature.id,
    "Daemon restart changed checkout identity",
  );
  assert(
    frames.slice(reconnectMark).some((f) => f.method === "catalog.push") &&
      frames.slice(reconnectMark).some((f) => f.method === "checkout.snapshot"),
    "Reconnect did not use full recovery",
  );
  const rotation = await request<{ pairing_code: string }>("/api/tower/invitations", {
    machine_id: machineId,
    scopes: ["read"],
  });
  const rotated = await processOutput([
    binary,
    "--json",
    "login",
    origin,
    rotation.pairing_code,
    "--read-only",
  ]);
  assert(rotated.code === 0 && /"state"\s*:\s*"complete"/.test(rotated.out), "Re-pairing failed");
  assert(
    !/(confirmation_token|access_key)/.test(rotated.out),
    "Re-pairing printed a private credential",
  );
  await connected();
  assert(
    (await operation<Machine[]>("machines_list")).length === 1 &&
      (await observedOne(feature.id))?.checkout_id === feature.id,
    "Rotation changed machine/checkout identity",
  );

  const offlinePlan = await prepare(main.id, "checkout.create", {
    name: "offline-plan",
    target: { kind: "new_branch", branch: "offline-plan" },
  });
  const port = running!.settings.port;
  await running!.stop();
  online = false;
  await until(async () => !(await catalog()).current, "offline cached catalog");
  assert(
    (await catalog()).catalog?.repositories.some((r) => r.id === repo.id),
    "Offline mode discarded the catalog",
  );
  assert((await cli<TowerCheckout>(["vcs", "status", main.id])).available, "Offline read failed");
  await rejected(
    [
      "vcs",
      "prepare",
      main.id,
      "checkout.create",
      "--options",
      JSON.stringify({ name: "denied", target: { kind: "new_branch", branch: "denied" } }),
    ],
    "offline_restricted",
  );
  await rejected(["vcs", "execute", offlinePlan.plan_id, "--wait"], "offline_restricted");
  await cli(["daemon", "stop"]);
  await cli(["rpc", "daemon.info"]);
  assert(
    !(await catalog()).current && (await local()).some((c) => c.id === feature.id),
    "Offline restart discarded local identities or marked the cache current",
  );
  await start(port);
  await connected();
  assert(
    (await cli<{ state: string }>(["vcs", "operation", offlinePlan.plan_id])).state === "prepared",
    "Offline mutation was replayed on reconnect",
  );
  assert(
    !existsSync(join(home, "worktrees", "offline-plan")),
    "Offline worktree appeared without explicit execution",
  );
  assert(
    (await observedOne(feature.id))?.path === moved.path,
    "Server restart changed the checkout mapping",
  );
  console.log(
    "Passed daemon/server reconnect, key rotation, cached offline reads, mutation refusal and no replay.",
  );

  const remove = await prepare(feature.id, "checkout.remove");
  assert(
    (await execute(remove.plan_id)).state === "completed" && !existsSync(pathOf(moved)),
    "Worktree removal failed",
  );
  await until(
    async () => (await observedOne(feature.id))?.available === false,
    "unavailable worktree observation",
  );
  await cli(["checkout", "forget", feature.id]);
  await until(
    async () => (await observedOne(feature.id))?.present === false,
    "retained absent checkout identity",
  );
  assert(
    (await observedOne(main.id))?.available && (await observedOne(clone.id))?.available,
    "Removing one worktree affected another clone",
  );
  console.log(
    `Catalog/worktree integration passed with actual Allgather, Tower, and local Git. ${frames.length} observed frames; catalog/checkouts delta + full recovery verified. No live provider or remote Git operations.`,
  );
} catch (error) {
  console.error(
    "Catalog integration evidence",
    JSON.stringify({ lastFrames: frames.slice(-16), serverOnline: online }),
  );
  if (online && running)
    console.error(
      "Machine sync",
      JSON.stringify(
        running.workspace.all(
          "SELECT machine_id,catalog_revision,catalog_error,checkout_error,checkouts_current FROM machine_catalog_sync",
        ),
      ),
    );
  throw error;
} finally {
  try {
    await cli(["--no-start", "daemon", "stop"]);
  } finally {
    await stopFixturePool(bundle, env);
    if (online) await running?.stop();
    for (const peer of peers) {
      peer.data.upstream.close();
      peer.close();
    }
    await relay.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}
