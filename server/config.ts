import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultPrivateNetworks, networks } from "./network.ts";

export interface Config {
  dataDir: string;
  hostname: string;
  port: number;
  ownerUrl: string;
  mcpUrl: string | null;
  mcpPort: number | null;
  mcpHostname: string;
  trustedProxies: string[];
  privateNetworks: string[];
  gitSyncSeconds: number;
  managedSessions: boolean;
}
function portNumber(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 65535)
    throw new Error(`${name} must be a valid port`);
  return value;
}
function origin(value: string, name: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error(`${name} must be an HTTP(S) origin without credentials or a path`);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.protocol !== "https:")
    throw new Error(`${name} requires HTTPS outside loopback`);
  return url.origin;
}
const ranges = (value: string | undefined, defaults: string[]) =>
  value === undefined
    ? defaults
    : value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

export function config(overrides: Partial<Config> = {}): Config {
  const managed = overrides.managedSessions ?? process.env.ALLGATHER_MANAGED_SESSIONS ?? true;
  if (managed !== true && managed !== false && managed !== "true" && managed !== "false")
    throw new Error("ALLGATHER_MANAGED_SESSIONS must be true or false");
  const port = portNumber(
    overrides.port ?? Number(process.env.ALLGATHER_PORT ?? 4390),
    "ALLGATHER_PORT",
  );
  const hostname = overrides.hostname ?? process.env.ALLGATHER_BIND ?? "127.0.0.1";
  const ownerUrl = origin(
    overrides.ownerUrl ?? process.env.ALLGATHER_OWNER_URL ?? `http://127.0.0.1:${port}`,
    "Owner URL",
  );
  if (
    !["localhost", "127.0.0.1", "::1"].includes(hostname) &&
    new URL(ownerUrl).protocol !== "https:"
  )
    throw new Error(
      "Set ALLGATHER_OWNER_URL to the private HTTPS origin before binding externally",
    );
  const rawMcpUrl =
    overrides.mcpUrl === undefined ? process.env.ALLGATHER_MCP_URL : overrides.mcpUrl;
  const mcpUrl = rawMcpUrl ? origin(rawMcpUrl, "MCP URL") : null;
  const mcpPort = mcpUrl
    ? portNumber(
        overrides.mcpPort ?? Number(process.env.ALLGATHER_MCP_PORT ?? 4391),
        "ALLGATHER_MCP_PORT",
      )
    : null;
  const mcpHostname = overrides.mcpHostname ?? process.env.ALLGATHER_MCP_BIND ?? "127.0.0.1";
  if (mcpUrl && mcpUrl === ownerUrl && new URL(mcpUrl).port !== "0")
    throw new Error("Owner and public MCP origins must differ");
  if (
    mcpUrl &&
    !["localhost", "127.0.0.1", "::1"].includes(mcpHostname) &&
    new URL(mcpUrl).protocol !== "https:"
  )
    throw new Error("Set ALLGATHER_MCP_URL to the public HTTPS origin before binding externally");
  const trustedProxies =
    overrides.trustedProxies ?? ranges(process.env.ALLGATHER_TRUSTED_PROXIES, []);
  const privateNetworks =
    overrides.privateNetworks ??
    ranges(process.env.ALLGATHER_PRIVATE_NETWORKS, defaultPrivateNetworks);
  networks(trustedProxies);
  networks(privateNetworks);
  const gitSyncSeconds =
    overrides.gitSyncSeconds ?? Number(process.env.ALLGATHER_GIT_SYNC_SECONDS ?? 300);
  if (
    !Number.isInteger(gitSyncSeconds) ||
    (gitSyncSeconds !== 0 && (gitSyncSeconds < 30 || gitSyncSeconds > 86400))
  )
    throw new Error("ALLGATHER_GIT_SYNC_SECONDS must be zero or between 30 and 86400");
  return {
    gitSyncSeconds,
    managedSessions: managed === true || managed === "true",
    dataDir: resolve(
      overrides.dataDir ??
        process.env.ALLGATHER_DATA_DIR ??
        join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "allgather"),
    ),
    hostname,
    port,
    ownerUrl,
    mcpUrl,
    mcpPort,
    mcpHostname,
    trustedProxies,
    privateNetworks,
  };
}
