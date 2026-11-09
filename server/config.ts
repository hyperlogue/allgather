import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type GatewayConfig, gatewayListSchema } from "./gateway-config.ts";
import { defaultPrivateNetworks, networks } from "./network.ts";

export interface Config {
  dataDir: string;
  hostname: string;
  port: number;
  ownerUrl: string;
  mcpUrl: string | null;
  mcpPort: number | null;
  mcpHostname: string;
  ownerTrustedProxies: string[];
  mcpTrustedProxies: string[];
  privateNetworks: string[];
  gitSyncSeconds: number;
  managedSessions: boolean;
  gateways: GatewayConfig[];
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

export function dataDirectory(
  override?: string,
  saved: Partial<Config> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  return resolve(
    override ??
      env.ALLGATHER_DATA_DIR ??
      saved.dataDir ??
      join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "allgather"),
  );
}
export function config(
  overrides: Partial<Config> = {},
  saved: Partial<Config> = {},
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const managed =
    overrides.managedSessions ?? env.ALLGATHER_MANAGED_SESSIONS ?? saved.managedSessions ?? true;
  if (managed !== true && managed !== false && managed !== "true" && managed !== "false")
    throw new Error("ALLGATHER_MANAGED_SESSIONS must be true or false");
  const port = portNumber(
    overrides.port ?? Number(env.ALLGATHER_PORT ?? saved.port ?? 4390),
    "ALLGATHER_PORT",
  );
  const hostname = overrides.hostname ?? env.ALLGATHER_BIND ?? saved.hostname ?? "127.0.0.1";
  const ownerUrl = origin(
    overrides.ownerUrl ?? env.ALLGATHER_OWNER_URL ?? saved.ownerUrl ?? `http://localhost:${port}`,
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
    overrides.mcpUrl === undefined ? (env.ALLGATHER_MCP_URL ?? saved.mcpUrl) : overrides.mcpUrl;
  const mcpUrl = rawMcpUrl ? origin(rawMcpUrl, "MCP URL") : null;
  const mcpPort = mcpUrl
    ? portNumber(
        overrides.mcpPort ?? Number(env.ALLGATHER_MCP_PORT ?? saved.mcpPort ?? 4391),
        "ALLGATHER_MCP_PORT",
      )
    : null;
  const mcpHostname =
    overrides.mcpHostname ?? env.ALLGATHER_MCP_BIND ?? saved.mcpHostname ?? "127.0.0.1";
  if (mcpUrl && mcpUrl === ownerUrl && new URL(mcpUrl).port !== "0")
    throw new Error("Owner and public MCP origins must differ");
  if (
    mcpUrl &&
    !["localhost", "127.0.0.1", "::1"].includes(mcpHostname) &&
    new URL(mcpUrl).protocol !== "https:"
  )
    throw new Error("Set ALLGATHER_MCP_URL to the public HTTPS origin before binding externally");
  if (env.ALLGATHER_TRUSTED_PROXIES !== undefined || "trustedProxies" in overrides)
    throw new Error(
      "Replace ALLGATHER_TRUSTED_PROXIES with separate ALLGATHER_OWNER_TRUSTED_PROXIES and ALLGATHER_MCP_TRUSTED_PROXIES",
    );
  const ownerTrustedProxies =
    overrides.ownerTrustedProxies ??
    ranges(env.ALLGATHER_OWNER_TRUSTED_PROXIES, saved.ownerTrustedProxies ?? []);
  const mcpTrustedProxies =
    overrides.mcpTrustedProxies ??
    ranges(env.ALLGATHER_MCP_TRUSTED_PROXIES, saved.mcpTrustedProxies ?? []);
  if (
    mcpUrl &&
    (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(mcpUrl).hostname) ||
      !["localhost", "127.0.0.1", "::1"].includes(mcpHostname)) &&
    !mcpTrustedProxies.length
  )
    throw new Error("Public MCP requires mcpTrustedProxies (ALLGATHER_MCP_TRUSTED_PROXIES)");
  const privateNetworks =
    overrides.privateNetworks ??
    ranges(env.ALLGATHER_PRIVATE_NETWORKS, saved.privateNetworks ?? defaultPrivateNetworks);
  networks(ownerTrustedProxies);
  networks(mcpTrustedProxies);
  networks(privateNetworks);
  const gitSyncSeconds =
    overrides.gitSyncSeconds ??
    Number(env.ALLGATHER_GIT_SYNC_SECONDS ?? saved.gitSyncSeconds ?? 300);
  if (
    !Number.isInteger(gitSyncSeconds) ||
    (gitSyncSeconds !== 0 && (gitSyncSeconds < 30 || gitSyncSeconds > 86400))
  )
    throw new Error("ALLGATHER_GIT_SYNC_SECONDS must be zero or between 30 and 86400");
  return {
    gateways: gatewayListSchema.parse(
      overrides.gateways ??
        (env.ALLGATHER_GATEWAYS === undefined
          ? (saved.gateways ?? [])
          : JSON.parse(env.ALLGATHER_GATEWAYS)),
    ),
    gitSyncSeconds,
    managedSessions: managed === true || managed === "true",
    dataDir: dataDirectory(overrides.dataDir, saved, env),
    hostname,
    port,
    ownerUrl,
    mcpUrl,
    mcpPort,
    mcpHostname,
    ownerTrustedProxies,
    mcpTrustedProxies,
    privateNetworks,
  };
}
