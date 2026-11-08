import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { GatewayConfig } from "./gateway-config.ts";

export interface GatewayStatus {
  name: string;
  state: "disabled" | "starting" | "running" | "backoff" | "stopping" | "stopped";
  pid?: number;
  restarts: number;
  started_at?: string;
  next_restart_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  error?: string;
  log_file: string;
}
interface Gateway {
  config: GatewayConfig;
  status: GatewayStatus;
  child?: ChildProcess;
  timer?: ReturnType<typeof setTimeout>;
  done?: Promise<void>;
  failures: number;
}
const logLimit = 1024 * 1024;
function appendLog(path: string, chunk: Buffer) {
  const bytes = chunk.subarray(-logLimit);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (size + bytes.length > logLimit) {
    rmSync(`${path}.1`, { force: true });
    renameSync(path, `${path}.1`);
  }
  appendFileSync(path, bytes, { mode: 0o600 });
}
function signal(child: ChildProcess, value: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(value);
    else process.kill(-child.pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
export class Gateways {
  private readonly rows: Gateway[];
  private stopping = false;
  constructor(private readonly settings: Config) {
    const directory = join(settings.dataDir, "gateways");
    if (settings.gateways.length) mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.rows = settings.gateways.map((config) => ({
      config,
      failures: 0,
      status: {
        name: config.name,
        state: config.enabled === false ? "disabled" : "stopped",
        restarts: 0,
        log_file: join(directory, `${config.name}.log`),
      },
    }));
  }
  status(): GatewayStatus[] {
    return this.rows.map((row) => ({ ...row.status }));
  }
  start() {
    for (const row of this.rows)
      if (row.config.enabled !== false && !row.child && !row.timer && !this.stopping)
        this.launch(row);
  }
  private launch(row: Gateway) {
    row.status.state = "starting";
    delete row.status.error;
    delete row.status.next_restart_at;
    const started = Date.now();
    const finished = () => {
      delete row.child;
      delete row.status.pid;
      if (this.stopping) {
        row.status.state = "stopped";
        return;
      }
      row.failures = Date.now() - started >= 60000 ? 1 : row.failures + 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(row.failures - 1, 5));
      row.status.state = "backoff";
      row.status.next_restart_at = new Date(Date.now() + delay).toISOString();
      row.timer = setTimeout(() => {
        delete row.timer;
        if (!this.stopping) {
          row.status.restarts++;
          this.launch(row);
        }
      }, delay);
    };
    try {
      const child = spawn(row.config.command[0], row.config.command.slice(1), {
        cwd: row.config.cwd ?? this.settings.dataDir,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ALLGATHER_GATEWAY_NAME: row.config.name,
          ALLGATHER_DATA_DIR: this.settings.dataDir,
          ALLGATHER_OWNER_BIND: this.settings.hostname,
          ALLGATHER_OWNER_PORT: String(this.settings.port),
          ALLGATHER_OWNER_URL: this.settings.ownerUrl,
          ALLGATHER_MCP_BIND: this.settings.mcpHostname,
          ALLGATHER_MCP_PORT: this.settings.mcpPort === null ? "" : String(this.settings.mcpPort),
          ALLGATHER_MCP_URL: this.settings.mcpUrl ?? "",
        },
      });
      row.child = child;
      row.done = new Promise((resolve) =>
        child.once("close", (code, value) => {
          row.status.exit_code = code;
          row.status.signal = value;
          finished();
          resolve();
        }),
      );
      child.once("spawn", () => {
        row.status.pid = child.pid;
        row.status.started_at = new Date().toISOString();
        row.status.state = this.stopping ? "stopping" : "running";
        if (this.stopping) signal(child, "SIGTERM");
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        row.status.error = error.code ?? "spawn_failed";
      });
      child.once("exit", () => signal(child, "SIGKILL"));
      const log = (chunk: Buffer) => {
        try {
          appendLog(row.status.log_file, chunk);
        } catch {
          row.status.error = "log_write_failed";
        }
      };
      child.stdout!.on("data", log);
      child.stderr!.on("data", log);
    } catch (error) {
      row.status.error = (error as NodeJS.ErrnoException).code ?? "spawn_failed";
      finished();
    }
  }
  async stop() {
    this.stopping = true;
    await Promise.all(
      this.rows.map(async (row) => {
        clearTimeout(row.timer);
        delete row.timer;
        delete row.status.next_restart_at;
        const child = row.child;
        if (!child) {
          if (row.status.state !== "disabled") row.status.state = "stopped";
          return;
        }
        row.status.state = "stopping";
        signal(child, "SIGTERM");
        const kill = setTimeout(() => signal(child, "SIGKILL"), 3000);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            row.done,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error(`Gateway ${row.config.name} did not stop`)),
                5000,
              );
            }),
          ]);
        } finally {
          clearTimeout(kill);
          clearTimeout(timeout);
        }
      }),
    );
  }
}
