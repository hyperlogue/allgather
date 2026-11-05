import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("synthetic Codex daemon lifecycle owns one private host and stops through its socket", async () => {
  const home = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ag-codex-"));
  const fixture = new URL("./fixtures/app-server.mjs", import.meta.url).pathname;
  const run = async (verb: string) => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", fixture, "app-server", "daemon", verb],
      {
        env: { HOME: home, SHELL: "/bin/bash" },
        cwd: home,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill(), 15000);
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code) throw new Error(err || `Fixture exited ${code}`);
      return JSON.parse(out) as { status: string; pid?: number; socketPath: string };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    expect((await run("status")).status).toBe("stopped");
    const started = await run("start");
    expect(started.status).toBe("running");
    expect(started.pid).toBeGreaterThan(0);
    expect(started.socketPath).toBe(
      join(home, ".codex/app-server-control/app-server-control.sock"),
    );
    expect(await run("ensure")).toEqual(started);
    expect(await run("start")).toEqual(started);
    expect(readFileSync(join(home, "hosts.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    const denied = await fetch("http://localhost/__fixture/stop", {
      unix: started.socketPath,
      method: "POST",
      headers: { authorization: "Bearer wrong-fixture" },
    });
    expect(denied.status).toBe(403);
    await denied.text();
    expect(await run("status")).toEqual(started);
    expect((await run("stop")).status).toBe("stopped");
    expect(existsSync(started.socketPath)).toBe(false);
    expect((await run("status")).status).toBe("stopped");
    expect((await run("stop")).status).toBe("stopped");
    await expect(run("unknown")).rejects.toThrow("Unsupported fixture daemon command");
  } finally {
    await run("stop").catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);
