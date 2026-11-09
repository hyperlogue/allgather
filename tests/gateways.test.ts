import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../server/config.ts";
import { serverStatus } from "../server/control.ts";
import { Gateways } from "../server/gateways.ts";
import { startServer } from "../server/index.ts";
import { readServerConfig, serverConfigCommand } from "../server/server-config.ts";

async function until(condition: () => boolean | Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Gateway condition timed out");
    await Bun.sleep(30);
  }
}
const command = (code: string) => [process.execPath, "--no-env-file", "-e", code];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

test("gateway config is local, strict, unique and preserves argument arrays", () => {
  const directory = mkdtempSync(join(tmpdir(), "allgather-gateway-config-"));
  try {
    const path = join(directory, "server.json");
    serverConfigCommand(
      [
        "set",
        "gateways",
        JSON.stringify([
          { name: "public", command: ["gateway", "literal $PORT", ""], cwd: directory },
        ]),
      ],
      path,
    );
    expect(readServerConfig(path)?.gateways?.[0].command).toEqual(["gateway", "literal $PORT", ""]);
    for (const gateways of [
      [{ name: "../escape", command: ["gateway"] }],
      [{ name: "public", command: [] }],
      [{ name: "public", command: [" "] }],
      [{ name: "public", command: ["gateway", "\0"] }],
      [{ name: "public", command: ["gateway"], shell: true }],
      [
        { name: "public", command: ["gateway"] },
        { name: "public", command: ["other"] },
      ],
    ])
      expect(() => config({ gateways: gateways as never })).toThrow();
    expect(
      config(
        {},
        { gateways: [{ name: "saved", command: ["gateway"] }] },
        { ALLGATHER_GATEWAYS: "[]" },
      ).gateways,
    ).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("server gateways receive bound ports, restart after exit, and stop with the server", async () => {
  const directory = mkdtempSync(join(tmpdir(), "allgather-gateway-server-"));
  const running = await startServer({
    dataDir: directory,
    port: 0,
    ownerUrl: "http://localhost:0",
    mcpPort: 0,
    mcpUrl: "http://127.0.0.1:0",
    gitSyncSeconds: 0,
    gateways: [
      {
        name: "public",
        command: command(`
      const fs = require('node:fs');
      const next = fs.existsSync('attempts') ? Number(fs.readFileSync('attempts','utf8'))+1 : 1;
      fs.writeFileSync('attempts', String(next));
      console.log(JSON.stringify({ ownerPort: process.env.ALLGATHER_OWNER_PORT, mcpPort: process.env.ALLGATHER_MCP_PORT, ownerUrl: process.env.ALLGATHER_OWNER_URL, mcpUrl: process.env.ALLGATHER_MCP_URL, name: process.env.ALLGATHER_GATEWAY_NAME }));
      if(next===1) process.exit(7);
      setInterval(()=>{},1000);
    `),
      },
    ],
  });
  try {
    await until(async () => (await serverStatus(directory)).gateways?.[0].state === "backoff");
    let status = (await serverStatus(directory)).gateways![0];
    expect(status.exit_code).toBe(7);
    expect(Date.parse(status.next_restart_at!) - Date.now()).toBeGreaterThan(0);
    await until(async () => {
      const row = (await serverStatus(directory)).gateways?.[0];
      return (
        row?.state === "running" &&
        row.restarts === 1 &&
        readFileSync(join(directory, "attempts"), "utf8") === "2"
      );
    });
    status = (await serverStatus(directory)).gateways![0];
    const sample = JSON.parse(readFileSync(status.log_file, "utf8").trim().split("\n")[0]);
    expect(sample).toEqual({
      ownerPort: String(running.settings.port),
      mcpPort: String(running.settings.mcpPort),
      ownerUrl: running.settings.ownerUrl,
      mcpUrl: running.settings.mcpUrl,
      name: "public",
    });
    expect(statSync(status.log_file).mode & 0o777).toBe(0o600);
    const pid = status.pid!;
    await running.stop();
    expect(alive(pid)).toBe(false);
    await Bun.sleep(1100);
    expect(readFileSync(join(directory, "attempts"), "utf8")).toBe("2");
  } finally {
    await running.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

test("spawn failure backs off without crashing and shutdown cancels retries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "allgather-gateway-missing-"));
  const gateways = new Gateways(
    config({
      dataDir: directory,
      gateways: [
        { name: "missing", command: [join(directory, "missing")] },
        { name: "disabled", command: ["never-run"], enabled: false },
      ],
    }),
  );
  try {
    gateways.start();
    await until(() => gateways.status()[0].state === "backoff");
    expect(gateways.status()[0].error).toBe("ENOENT");
    expect(gateways.status()[1].state).toBe("disabled");
    await gateways.stop();
    await Bun.sleep(1100);
    expect(gateways.status()[0]).toMatchObject({ state: "stopped", restarts: 0 });
    expect(gateways.status()[0].next_restart_at).toBeUndefined();
  } finally {
    await gateways.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("gateway shutdown kills a resistant foreground process and logs remain bounded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "allgather-gateway-stop-"));
  const gateways = new Gateways(
    config({
      dataDir: directory,
      gateways: [
        {
          name: "noisy",
          command: command(`
    process.on('SIGTERM',()=>{});
    console.log('mcp-disabled:'+process.env.ALLGATHER_MCP_PORT+':'+process.env.ALLGATHER_MCP_URL);
    process.stdout.write(Buffer.alloc(3*1024*1024, 'x'));
    require('node:fs').writeFileSync('ready','ready');
    setInterval(()=>{},1000);
  `),
        },
      ],
    }),
  );
  try {
    gateways.start();
    await until(
      () =>
        existsSync(join(directory, "ready")) && existsSync(gateways.status()[0].log_file + ".1"),
    );
    const status = gateways.status()[0];
    expect(statSync(status.log_file).size).toBeLessThanOrEqual(1024 * 1024);
    expect(statSync(status.log_file + ".1").size).toBeLessThanOrEqual(1024 * 1024);
    await gateways.stop();
    expect(alive(status.pid!)).toBe(false);
    expect(gateways.status()[0].state).toBe("stopped");
  } finally {
    await gateways.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

test("gateway process groups include descendants during shutdown", async () => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync(join(tmpdir(), "allgather-gateway-group-"));
  const descendant = `const fs=require('node:fs'); let n=0; setInterval(()=>fs.writeFileSync('ticks',String(++n)),30);`;
  const gateways = new Gateways(
    config({
      dataDir: directory,
      gateways: [
        {
          name: "group",
          command: command(`
    require('node:child_process').spawn(process.execPath,['--no-env-file','-e',${JSON.stringify(descendant)}],{stdio:'ignore'});
    setInterval(()=>{},1000);
  `),
        },
      ],
    }),
  );
  try {
    gateways.start();
    await until(() => existsSync(join(directory, "ticks")));
    await gateways.stop();
    await Bun.sleep(150);
    const stopped = readFileSync(join(directory, "ticks"), "utf8");
    await Bun.sleep(200);
    expect(readFileSync(join(directory, "ticks"), "utf8")).toBe(stopped);
  } finally {
    await gateways.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
