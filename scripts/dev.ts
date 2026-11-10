#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const port = 4490;

export function devTarget(base = root) {
  const workspace = join(base, "workspace");
  const url = `http://localhost:${port}`;
  return {
    url,
    dataDir: join(workspace, "allgather"),
    configDir: join(workspace, "dev-config"),
  };
}

export function devEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  base = root,
): NodeJS.ProcessEnv {
  const target = devTarget(base);
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("ALLGATHER_"))),
    ALLGATHER_DEV: "1",
    ALLGATHER_DATA_DIR: target.dataDir,
    ALLGATHER_CONFIG_DIR: target.configDir,
    ALLGATHER_PORT: String(port),
    ALLGATHER_OWNER_URL: target.url,
    ALLGATHER_URL: target.url,
  };
}

export const HELP = `scripts/dev.ts — source-backed Allgather against the development instance

  watch           Run the server in the foreground; reload on server edits, rebuild web on change
  server ARGS     allgather-server ARGS (start, stop, restart, status, login, ...)
  cli ARGS        allgather ARGS
  env             Print the development target

The development instance listens on http://localhost:${port} and keeps its data and
client configuration in workspace/. Inherited ALLGATHER_* variables are ignored, so
these commands never reach the installed server.
`;

const instanceFlags = ["--data-dir", "--port", "--owner-url"];

export function devCommand(argv: string[]) {
  const [command, ...rest] = argv;
  const source = (path: string) => join(root, path);
  if (command === "watch" && !rest.length)
    return [process.execPath, "--no-env-file", "--watch", source("server/cli.ts"), "run"];
  if (command === "server") {
    const flag = rest.find((value) => instanceFlags.includes(value.split("=")[0]));
    if (flag) throw new Error(`${flag.split("=")[0]} would leave the development instance`);
    return [process.execPath, "--no-env-file", source("server/cli.ts"), ...rest];
  }
  if (command === "cli")
    return [process.execPath, "--no-env-file", source("cli/index.ts"), ...rest];
  return null;
}

const logSize = (log: string) => (existsSync(log) ? statSync(log).size : 0);

function logSince(log: string, offset: number, lines = 40) {
  if (logSize(log) <= offset) return "";
  return readFileSync(log)
    .subarray(offset)
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .join("\n");
}

async function main(argv: string[]) {
  const target = devTarget();
  if (!argv.length || argv[0] === "help" || argv[0] === "--help") {
    console.log(HELP);
    return 0;
  }
  if (argv[0] === "env" && argv.length === 1) {
    console.log(JSON.stringify(target, null, 2));
    return 0;
  }
  const command = devCommand(argv);
  if (!command) {
    console.error(HELP);
    return 2;
  }
  console.error(
    `allgather dev: ${target.url} · data ${relative(process.cwd(), target.dataDir) || "."}`,
  );
  const log = join(target.dataDir, "server.log");
  const offset = logSize(log);
  const child = Bun.spawn(command, {
    cwd: root,
    env: devEnvironment(),
    stdio: ["inherit", "inherit", "inherit"],
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  const code = await child.exited;
  if (code !== 0 && argv[0] === "server" && ["start", "restart"].includes(argv[1] ?? "")) {
    const written = logSince(log, offset);
    if (written) console.error(`\n${log} during this command:\n${written}`);
  }
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
