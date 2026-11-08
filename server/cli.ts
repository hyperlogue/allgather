#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "../cli/args.ts";
import { restoreWorkspace } from "./backup.ts";
import { type Config, config, dataDirectory } from "./config.ts";
import { controlRequest, type ServerStatus, serverStatus } from "./control.ts";
import { startServer } from "./index.ts";
import { readServerConfig, serverConfigCommand } from "./server-config.ts";

export const HELP = `allgather-server — local Allgather server administration

  start       Start in the background; wait until ready
  stop        Stop the authenticated local server and wait for shutdown
  restart     Restart with saved configuration; retain running settings when no file exists
  status      Report running, stopping, stopped, or unreachable
  run         Run in the foreground (for terminals and service managers)
  config show | get KEY | set KEY VALUE [KEY VALUE ...] | unset KEY [KEY ...]
  auth create-token [--label NAME] | list-tokens | revoke-token TOKEN_ID | reset
  backup FILE
  restore FILE --data-dir NEW_DIRECTORY

Use --data-dir DIR to select the local instance. Control results are JSON; run prints logs.
Private server: --port PORT --bind HOST --owner-url URL.
Public MCP (opt in): --mcp-url URL --mcp-port PORT --mcp-bind HOST.
Network: --owner-trusted-proxies CIDRS --mcp-trusted-proxies CIDRS --private-networks CIDRS (comma separated).
Execution: --managed-sessions true|false.
Server config: $ALLGATHER_CONFIG_DIR/server.json or $XDG_CONFIG_HOME/allgather/server.json (default ~/.config/allgather/server.json).
Keys: dataDir, hostname, port, ownerUrl, mcpUrl, mcpPort, mcpHostname, ownerTrustedProxies, mcpTrustedProxies, privateNetworks, gitSyncSeconds, managedSessions, gateways.
Proxy/network values accept comma-separated CIDRs or a JSON array. Set related keys together atomically. Set mcpUrl to null to disable public MCP.
Gateways: config set gateways '[{"name":"public","command":["gateway-program","serve"]}]'. Optional cwd and enabled fields. Commands must stay in the foreground; no implicit shell expansion.
Children receive ALLGATHER_OWNER_BIND/PORT/URL, ALLGATHER_MCP_BIND/PORT/URL (empty port/URL when disabled), ALLGATHER_DATA_DIR and ALLGATHER_GATEWAY_NAME. Default cwd is the data directory.
Gateway exits restart with 1–30 second backoff; status reports process state, not tunnel reachability. Stop/restart shuts down owned gateway process groups. Logs rotate at 1 MiB with one previous file in DATA_DIR/gateways. Allgather itself still needs a service manager for reboot/crash recovery.
config show reports saved and effective settings; config get reads a saved override.
Priority: command flags > environment > saved settings > defaults. Writes save only explicit values; start/restart applies them. dataDir selects the instance.
Example: allgather-server config set ownerUrl https://owner.example mcpUrl https://mcp.example mcpTrustedProxies 127.0.0.1/32
Auth and backup require a running local server. Login codes expire after ten minutes and work once.
Auth reset revokes all browser, connector and machine access. Restore also revokes prior credentials.
Restore writes to a new directory.
Backup and restore use the Allgather ZIP format.
Client work uses allgather login <hostname-or-url>, then allgather guide.
`;

async function stop(directory: string) {
  let prior = await serverStatus(directory);
  if (prior.state === "unreachable") {
    await Bun.sleep(250);
    prior = await serverStatus(directory);
  }
  if (prior.state === "stopped") return prior;
  if (prior.state === "unreachable")
    throw new Error(
      "The server is unreachable; refusing to signal a PID without a verified owner.",
    );
  if (prior.state === "running") {
    try {
      await controlRequest(directory, "stop", {}, prior.instance);
    } catch (error) {
      const current = await serverStatus(directory);
      if (
        current.state !== "stopped" &&
        current.state !== "stopping" &&
        (!current.instance || current.instance === prior.instance)
      )
        throw error;
    }
  }
  for (let i = 0; i < 300; i++) {
    const current = await serverStatus(directory);
    if (current.state === "stopped" || (current.instance && current.instance !== prior.instance))
      return { state: "stopped", instance: prior.instance };
    await Bun.sleep(100);
  }
  throw new Error("Server shutdown did not complete; no force signal was sent.");
}
async function start(settings: Config): Promise<ServerStatus> {
  const prior = await serverStatus(settings.dataDir);
  if (prior.state === "running") return prior;
  if (prior.state !== "stopped")
    throw new Error(`Local server is ${prior.state}; inspect it before starting.`);
  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  const temporary = join(settings.dataDir, "tmp");
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const log = join(settings.dataDir, "server.log"),
    fd = openSync(log, "a", 0o600);
  const args = [
    "run",
    "--data-dir",
    settings.dataDir,
    "--port",
    String(settings.port),
    "--bind",
    settings.hostname,
    "--owner-url",
    settings.ownerUrl,
    "--owner-trusted-proxies",
    settings.ownerTrustedProxies.join(","),
    "--mcp-trusted-proxies",
    settings.mcpTrustedProxies.join(","),
    "--private-networks",
    settings.privateNetworks.join(","),
    "--mcp-url",
    settings.mcpUrl ?? "",
    "--mcp-bind",
    settings.mcpHostname,
    ...(settings.mcpPort === null ? [] : ["--mcp-port", String(settings.mcpPort)]),
    "--managed-sessions",
    String(settings.managedSessions),
  ];
  const compiled = import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN");
  const child = spawn(
    process.execPath,
    compiled ? args : ["--no-env-file", import.meta.path, ...args],
    {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        TMPDIR: temporary,
        ALLGATHER_GIT_SYNC_SECONDS: String(settings.gitSyncSeconds),
        ALLGATHER_GATEWAYS: JSON.stringify(settings.gateways),
      },
    },
  );
  closeSync(fd);
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
  });
  child.unref();
  for (let i = 0; i < 300; i++) {
    const current = await serverStatus(settings.dataDir);
    if (current.state === "running") return current;
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Server startup failed. Inspect ${log}`);
    await Bun.sleep(100);
  }
  throw new Error(`Server has not become ready. Inspect ${log}; it may still be starting.`);
}
export async function main(argv = process.argv.slice(2)) {
  const { positional: p, flags: f } = parse(argv);
  const text = (key: string) => (typeof f[key] === "string" ? (f[key] as string) : undefined);
  const print = (value: unknown) =>
    console.log(JSON.stringify(value, null, f.json ? undefined : 2));
  if (!p.length || p[0] === "help" || f.help) {
    console.log(HELP);
    return;
  }
  if (
    !["run", "start", "stop", "restart", "status", "auth", "backup", "restore", "config"].includes(
      p[0],
    )
  )
    throw new Error("Unknown server command. Run allgather-server help.");
  const startup = ["run", "start", "restart"].includes(p[0]);
  const allowed = new Set([
    "json",
    "data-dir",
    ...(startup
      ? [
          "port",
          "bind",
          "owner-url",
          "mcp-url",
          "mcp-port",
          "mcp-bind",
          "owner-trusted-proxies",
          "mcp-trusted-proxies",
          "private-networks",
          "managed-sessions",
        ]
      : []),
    ...(p[0] === "auth" ? ["label"] : []),
  ]);
  for (const flag of Object.keys(f))
    if (!allowed.has(flag)) throw new Error(`Unknown option --${flag}`);
  if (p[0] === "config") {
    if (Object.keys(f).some((flag) => flag !== "json"))
      throw new Error("Config commands use ALLGATHER_CONFIG_DIR, not instance flags");
    print(serverConfigCommand(p.slice(1)));
    return;
  }
  if (p[0] === "restore") {
    if (p.length !== 2 || !text("data-dir"))
      throw new Error("restore needs FILE and --data-dir NEW_DIRECTORY");
    print(await restoreWorkspace(p[1], text("data-dir")!));
    return;
  }
  const managed = text("managed-sessions");
  if (managed !== undefined && managed !== "true" && managed !== "false")
    throw new Error("--managed-sessions must be true or false");
  const overrides: Partial<Config> = Object.fromEntries(
    Object.entries({
      dataDir: text("data-dir"),
      port: text("port") === undefined ? undefined : Number(f.port),
      hostname: text("bind"),
      ownerUrl: text("owner-url"),
      mcpUrl: text("mcp-url"),
      mcpPort: text("mcp-port") === undefined ? undefined : Number(f["mcp-port"]),
      mcpHostname: text("mcp-bind"),
      ownerTrustedProxies: text("owner-trusted-proxies")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      mcpTrustedProxies: text("mcp-trusted-proxies")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      privateNetworks: text("private-networks")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      managedSessions: managed === undefined ? undefined : managed === "true",
    }).filter(([, value]) => value !== undefined),
  );
  const saved = !startup && overrides.dataDir ? null : readServerConfig();
  const directory = dataDirectory(overrides.dataDir, saved ?? {});
  if (p[0] === "auth") {
    if (p[1] === "reset" && p.length === 2)
      print(await (await controlRequest(directory, "auth/reset", {})).json());
    else if (p[1] === "create-token" && p.length === 2)
      print(
        await (
          await controlRequest(directory, "auth/create-token", { label: text("label") })
        ).json(),
      );
    else if (p[1] === "list-tokens" && p.length === 2)
      print(await (await controlRequest(directory, "auth/list-tokens")).json());
    else if (p[1] === "revoke-token" && p.length === 3)
      print(await (await controlRequest(directory, "auth/revoke-token", { id: p[2] })).json());
    else throw new Error("Use auth create-token, list-tokens, revoke-token TOKEN_ID, or reset");
    return;
  }
  if (p[0] === "backup") {
    if (p.length !== 2) throw new Error("Supply a backup file");
    const file = await open(p[1], "wx", 0o600);
    try {
      const response = await controlRequest(directory, "backup");
      if (!response.body) throw new Error("Backup response has no data");
      await pipeline(Readable.from(response.body), file.createWriteStream());
    } catch (error) {
      await file.close();
      await rm(p[1], { force: true });
      throw error;
    } finally {
      await file.close();
    }
    print({ saved: true });
    return;
  }
  if (p.length !== 1) throw new Error("Unexpected server command argument");
  if (p[0] === "status") {
    print(await serverStatus(directory));
    return;
  }
  if (p[0] === "stop") {
    print(await stop(directory));
    return;
  }
  if (p[0] === "restart") {
    const prior = await serverStatus(directory);
    const next =
      saved === null ? config({ ...prior.settings, ...overrides }) : config(overrides, saved);
    await stop(directory);
    print(await start(next));
    return;
  }
  const settings = config(overrides, saved ?? {});
  if (p[0] === "start") {
    print(await start(settings));
    return;
  }
  const running = await startServer(settings);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void running.stop().then(() => process.exit(0));
    });
}
if (import.meta.main)
  main().catch((error) => {
    console.error(JSON.stringify({ error: { code: "server_failed", message: error.message } }));
    process.exitCode = 1;
  });
