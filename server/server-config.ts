import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { configDir, migrateClientConfig } from "../shared/local-config.ts";
import { config } from "./config.ts";

const port = z.number().int().min(0).max(65535);
const fields = {
  dataDir: z.string().min(1),
  hostname: z.string().min(1),
  port,
  ownerUrl: z.string().min(1),
  mcpUrl: z.string().min(1).nullable(),
  mcpPort: port,
  mcpHostname: z.string().min(1),
  ownerTrustedProxies: z.array(z.string()),
  mcpTrustedProxies: z.array(z.string()),
  privateNetworks: z.array(z.string()),
  gitSyncSeconds: z.number().int(),
  managedSessions: z.boolean(),
};
const schema = z.object(fields).partial().strict();
export type SavedServerConfig = z.infer<typeof schema>;
export function serverConfigPath() {
  return join(configDir(), "server.json");
}
export function readServerConfig(path = serverConfigPath()): SavedServerConfig | null {
  if (path === join(dirname(path), "server.json") && migrateClientConfig(dirname(path)))
    return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = schema.parse(JSON.parse(raw));
  if (parsed.dataDir) parsed.dataDir = resolve(dirname(path), parsed.dataDir);
  return parsed;
}
export function serverConfigCommand(args: string[], path = serverConfigPath()) {
  const [action, ...values] = args,
    saved = readServerConfig(path) ?? {};
  const key = (value: string) => {
    if (!Object.hasOwn(fields, value)) throw new Error(`Unknown server setting: ${value}`);
    return value as keyof SavedServerConfig;
  };
  if (action === "show" && !values.length) return { path, saved, effective: config({}, saved) };
  if (action === "get" && values.length === 1) return saved[key(values[0])] ?? null;
  const next: Record<string, unknown> = { ...saved };
  if (action === "set" && values.length > 0 && values.length % 2 === 0) {
    for (let i = 0; i < values.length; i += 2) {
      const name = key(values[i]),
        raw = values[i + 1];
      let value: unknown = raw;
      if (
        name === "ownerTrustedProxies" ||
        name === "mcpTrustedProxies" ||
        name === "privateNetworks"
      )
        value = raw.startsWith("[")
          ? JSON.parse(raw)
          : raw
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);
      else if (name === "port" || name === "mcpPort" || name === "gitSyncSeconds")
        value = /^\d+$/.test(raw) ? Number(raw) : NaN;
      else if (name === "managedSessions") {
        if (!["true", "false"].includes(raw))
          throw new Error("managedSessions must be true or false");
        value = raw === "true";
      } else if (name === "mcpUrl" && raw === "null") value = null;
      else if (name === "dataDir") value = resolve(fields.dataDir.parse(raw));
      next[name] = fields[name].parse(value);
    }
  } else if (action === "unset" && values.length) {
    for (const name of values) delete next[key(name)];
  } else
    throw new Error(
      "Use config show | get KEY | set KEY VALUE [KEY VALUE ...] | unset KEY [KEY ...]",
    );
  const checked = schema.parse(next);
  config({}, checked, {});
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(checked, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path, saved: checked, restart_required: true };
}
