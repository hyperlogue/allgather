import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  console.log("0.0.0 (pi terminal fixture)");
  process.exit(0);
}
const home = process.env.HOME;
if (!home || !existsSync(join(home, ".allgather-terminal-fixture")))
  throw new Error("Terminal fixture requires its isolated HOME marker");
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));
process.stdin.on("data", (chunk) => process.stdout.write("fixture input: " + chunk));
process.stdin.resume();
setInterval(() => {}, 1000);
appendFileSync(
  join(home, "terminal-starts.jsonl"),
  JSON.stringify({ pid: process.pid, cwd: process.cwd() }) + "\n",
  { mode: 0o600 },
);
process.stdout.write("TERMINAL_OUTPUT_MUST_STAY_LOCAL\r\n");
