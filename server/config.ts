import { homedir } from "node:os";
import { join, resolve } from "node:path";
export interface Config {
  dataDir: string;
  hostname: string;
  port: number;
  publicUrl: string;
  gitSyncSeconds: number;
  managedSessions: boolean;
}
export function config(overrides: Partial<Config> = {}): Config {
  const managed = overrides.managedSessions ?? process.env.ALLGATHER_MANAGED_SESSIONS ?? true;
  if (managed !== true && managed !== false && managed !== "true" && managed !== "false")
    throw new Error("ALLGATHER_MANAGED_SESSIONS must be true or false");
  const port = overrides.port ?? Number(process.env.ALLGATHER_PORT ?? 4390);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("ALLGATHER_PORT must be a valid port");
  const hostname = overrides.hostname ?? process.env.ALLGATHER_BIND ?? "127.0.0.1";
  const publicUrl = (
    overrides.publicUrl ??
    process.env.ALLGATHER_PUBLIC_URL ??
    `http://127.0.0.1:${port}`
  ).replace(/\/$/, "");
  const url = new URL(publicUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("Public URL must be an HTTP(S) origin without credentials or a path");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && url.protocol !== "https:")
    throw new Error("A public server needs HTTPS through a reverse proxy");
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname) && local)
    throw new Error(
      "Set ALLGATHER_PUBLIC_URL to the external HTTPS origin before binding externally",
    );
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
    publicUrl,
  };
}
