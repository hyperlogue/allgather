import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseUrl } from "../cli/client.ts";
import { controlRequest, type ServerStatus, serverStatus } from "../server/control.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "allgather-lifecycle-")),
    state = join(root, "state");
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_STATE_HOME: root,
    ALLGATHER_CONFIG_DIR: join(root, "config"),
    ALLGATHER_DATA_DIR: state,
    ALLGATHER_URL: undefined,
    ALLGATHER_TOKEN: undefined,
    ALLGATHER_PORT: "0",
    ALLGATHER_OWNER_URL: "http://127.0.0.1:0",
    ALLGATHER_BIND: "127.0.0.1",
    ALLGATHER_GIT_SYNC_SECONDS: "0",
  };
  const invoke = async (entry: string, ...args: string[]) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args, "--json"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  };
  const command = async <T = ServerStatus>(...args: string[]): Promise<T> => {
    const result = await invoke("server/cli.ts", ...args);
    if (result.code) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, state, env, invoke, command };
}

test("client guide is offline and hostname login normalization is explicit", async () => {
  const f = fixture();
  try {
    expect(baseUrl("allgather.example")).toBe("https://allgather.example");
    expect(baseUrl("https://allgather.example/")).toBe("https://allgather.example");
    expect(baseUrl("localhost:4390")).toBe("http://localhost:4390");
    expect(baseUrl("[::1]:4390/")).toBe("http://[::1]:4390");
    expect(() => baseUrl("http://allgather.example")).toThrow("HTTPS");
    expect(() => baseUrl("https://allgather.example/path")).toThrow("origin");
    expect(() => baseUrl("https://user:secret@allgather.example")).toThrow("origin");
    const guide = await f.invoke("cli/index.ts", "guide");
    expect(guide.code).toBe(0);
    expect(JSON.parse(guide.stdout).workflow).toContain("context");
    expect(existsSync(join(f.root, "config"))).toBe(false);
    const help = await f.invoke("cli/index.ts", "help");
    for (const command of ["key", "keys", "revoke-key"]) {
      expect(help.stdout).not.toContain(
        command === "revoke-key" ? "revoke-key" : "machine " + command + " ",
      );
      const removed = await f.invoke("cli/index.ts", "machine", command, "fixture-id");
      expect(removed.code).not.toBe(0);
      expect(removed.stderr).toContain("Unknown operation");
    }

    expect((await f.invoke("cli/index.ts", "guide", "--project", "project_example")).code).toBe(1);
    for (const command of ["server", "auth", "backup", "restore"])
      expect((await f.invoke("cli/index.ts", command)).stderr).toContain("allgather-server");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("server lifecycle uses authenticated local ownership, retains settings, and owns tokens and backup", async () => {
  const f = fixture();
  try {
    expect((await f.command("status")).state).toBe("stopped");
    const started = await f.command(
      "start",
      "--mcp-url",
      "http://127.0.0.1:0",
      "--mcp-port",
      "0",
      "--owner-trusted-proxies",
      "192.0.2.1/32",
      "--mcp-trusted-proxies",
      "192.0.2.2/32",
    );
    expect(started.settings!.mcpUrl).not.toBe(started.settings!.ownerUrl);
    expect(started.settings!.ownerTrustedProxies).toEqual(["192.0.2.1/32"]);
    expect(started.settings!.mcpTrustedProxies).toEqual(["192.0.2.2/32"]);
    expect((await fetch(started.settings!.mcpUrl + "/api/session")).status).toBe(404);
    expect(started.state).toBe("running");
    expect(started.pid).not.toBe(process.pid);
    expect((await f.command("start")).instance).toBe(started.instance);
    const path = join(f.state, "server-control.json"),
      saved = JSON.parse(readFileSync(path, "utf8"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await fetch(`http://127.0.0.1:${saved.port}/status`)).status).toBe(403);
    expect(
      (
        await fetch(`http://127.0.0.1:${saved.port}/stop`, {
          method: "POST",
          headers: { authorization: `Bearer ${saved.token}`, origin: started.settings!.ownerUrl },
        })
      ).status,
    ).toBe(403);
    const issued = await f.command<{ token: string; id: string }>(
      "auth",
      "create-token",
      "--label",
      "Lifecycle browser",
    );
    const login = await fetch(started.settings!.ownerUrl + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: started.settings!.ownerUrl },
      body: JSON.stringify({ key: issued.token }),
    });
    expect(login.ok).toBe(true);
    const listed = await f.command<{ id: string }[]>("auth", "list-tokens");
    expect(listed.some((t) => t.id === issued.id)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(issued.token);
    await f.command("auth", "revoke-token", issued.id);
    const session = await fetch(started.settings!.ownerUrl + "/api/session", {
      headers: { cookie: login.headers.get("set-cookie")!.split(";")[0] },
    });
    expect(((await session.json()) as { authenticated: boolean }).authenticated).toBe(false);
    const backup = join(f.root, "backup.zip");
    await f.command("backup", backup);
    expect(readFileSync(backup).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const restarted = await f.command("restart");
    expect(restarted.state).toBe("running");
    expect(restarted.instance).not.toBe(started.instance);
    expect(restarted.settings).toEqual(started.settings);
    await expect(controlRequest(f.state, "stop", {}, started.instance)).rejects.toThrow(
      "instance changed",
    );
    expect((await f.command("status")).instance).toBe(restarted.instance);
    const stops = await Promise.all([f.command("stop"), f.command("stop")]);
    expect(stops.every((result) => result.state === "stopped")).toBe(true);
    expect((await f.command("stop")).state).toBe("stopped");
    expect(existsSync(join(f.state, "server.lock"))).toBe(false);
    expect(existsSync(path)).toBe(false);
    const restored = join(f.root, "restored");
    expect(
      (await f.command<{ restored: boolean }>("restore", backup, "--data-dir", restored)).restored,
    ).toBe(true);
    expect(existsSync(join(restored, "allgather.sqlite"))).toBe(true);
  } finally {
    await f.command("stop").catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
}, 30000);

test("foreground shutdown cleans ownership and an unreachable PID is never signaled", async () => {
  const f = fixture();
  const child = Bun.spawn([process.execPath, "--no-env-file", "server/cli.ts", "run"], {
    env: f.env,
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 100 && (await serverStatus(f.state)).state !== "running"; i++)
      await Bun.sleep(50);
    expect((await serverStatus(f.state)).state).toBe("running");
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect((await f.command("status")).state).toBe("stopped");
    mkdirSync(f.state, { recursive: true });
    writeFileSync(join(f.state, "server.lock"), String(process.pid));
    expect((await f.command("status")).state).toBe("unreachable");
    const result = await f.invoke("server/cli.ts", "stop");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refusing to signal");
    expect(readFileSync(join(f.state, "server.lock"), "utf8")).toBe(String(process.pid));
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);
