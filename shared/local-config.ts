import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const configDir = () =>
  process.env.ALLGATHER_CONFIG_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "allgather");

export function migrateClientConfig(directory: string) {
  const legacy = join(directory, "server.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(legacy, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
    throw error;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 1 ||
    !("url" in value) ||
    typeof value.url !== "string"
  )
    return;
  const client = join(directory, "client.json");
  try {
    writeFileSync(client, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return true;
}
