import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, secret } from "../server/auth.ts";
import { startServer } from "../server/index.ts";
import { openDatabase } from "../server/storage.ts";

test("browser login tokens expire on inactivity and revocation invalidates dependent sessions", () => {
  const db = openDatabase(":memory:"),
    recovery = secret(),
    auth = new Auth(db, "https://allgather.example", recovery);
  try {
    expect(() => auth.signIn(recovery)).toThrow("login token");
    const token = auth.createLoginToken("Browser"),
      cookie = auth.signIn(token.token).split(";")[0],
      request = new Request(auth.baseUrl + "/api/session", { headers: { cookie } });
    expect(auth.principal(request)?.inlet).toBe("browser");
    expect(JSON.stringify(auth.loginTokens())).not.toContain(token.token);
    auth.revokeLoginToken(token.id);
    expect(auth.principal(request)).toBeNull();
    expect(() => auth.signIn(token.token)).toThrow("revoked");
    const inactive = auth.createLoginToken("Old");
    db.query("UPDATE login_tokens SET last_used_at=? WHERE id=?").run(
      "2000-01-01T00:00:00Z",
      inactive.id,
    );
    expect(() => auth.signIn(inactive.token)).toThrow("inactive");
  } finally {
    db.close();
  }
});
async function authorizeCli(
  running: Awaited<ReturnType<typeof startServer>>,
  env: NodeJS.ProcessEnv,
  scope?: string,
) {
  const url = running.settings.publicUrl;
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "cli/index.ts",
      "login",
      `${url}/`,
      ...(scope === undefined ? [] : ["--scope", scope]),
      "--json",
    ],
    {
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stderr.getReader();
    let log = "";
    const authorization = await Promise.race([
      (async () => {
        for (;;) {
          const part = await reader.read();
          if (part.done) throw new Error("Login exited before authorization");
          log += new TextDecoder().decode(part.value);
          const match = /http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?[^\s]+/.exec(log);
          if (match) return new URL(match[0]);
        }
      })(),
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error("No authorization URL")), 10000);
      }),
    ]);
    clearTimeout(timer);
    const login = await fetch(url + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({
        key: readFileSync(join(running.settings.dataDir, "login-token"), "utf8"),
      }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const approved = await fetch(url + "/api/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", origin: url, cookie },
      body: JSON.stringify(Object.fromEntries(authorization.searchParams)),
    });
    expect(approved.status).toBe(200);
    const redirect = (await approved.json()) as { redirect_uri: string };
    expect((await fetch(redirect.redirect_uri)).ok).toBe(true);
    expect(await child.exited).toBe(0);
    const result = JSON.parse(await new Response(child.stdout).text());
    expect(result.authenticated).toBe(true);
    return authorization.searchParams.get("scope")!.split(" ");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}
test("CLI browser OAuth stores private rotating credentials and API grants cannot access MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "allgather-oauth-cli-")),
    running = await startServer({
      dataDir: join(dir, "state"),
      port: 0,
      publicUrl: "http://127.0.0.1:0",
      gitSyncSeconds: 0,
    }),
    url = running.settings.publicUrl,
    env = {
      ...process.env,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      XDG_STATE_HOME: dir,
      ALLGATHER_URL: undefined,
      ALLGATHER_CONFIG_DIR: join(dir, "config"),
      ALLGATHER_TOKEN: undefined,
    };
  try {
    await authorizeCli(running, env);
    expect(JSON.parse(readFileSync(join(dir, "config", "server.json"), "utf8")).url).toBe(url);
    const credentials = join(dir, "config", "credentials.json"),
      saved = JSON.parse(readFileSync(credentials, "utf8"));
    expect(statSync(credentials).mode & 0o777).toBe(0o600);
    expect(saved[url].resource).toBe(url + "/api");
    expect(typeof saved[url].refresh_token).toBe("string");
    expect(
      (
        await fetch(url + "/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${saved[url].access_token}`,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    saved[url].expires_at = 0;
    writeFileSync(credentials, JSON.stringify(saved), { mode: 0o600 });
    const old = saved[url].access_token;
    const invoke = () =>
      Bun.spawn([process.execPath, "--no-env-file", "cli/index.ts", "project", "list", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    const calls = [invoke(), invoke()];
    for (const c of calls) {
      const err = await new Response(c.stderr).text();
      if (await c.exited) throw new Error(err);
      expect(JSON.parse(await new Response(c.stdout).text())).toEqual([]);
    }
    const refreshed = JSON.parse(readFileSync(credentials, "utf8"))[url];
    expect(refreshed.access_token).not.toBe(old);
    expect(refreshed.refresh_token).not.toBe(saved[url].refresh_token);
    expect(
      (
        await fetch(url + "/api/tower/credentials", {
          headers: { authorization: `Bearer ${refreshed.access_token}` },
        })
      ).status,
    ).toBe(403);
    running.workspace.db
      .query("UPDATE oauth_clients SET revoked=1 WHERE id=?")
      .run(refreshed.client_id);
    const denied = invoke();
    expect(await denied.exited).not.toBe(0);
  } finally {
    await running.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test("CLI administrative access requires explicit login scopes and default re-login replaces it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "allgather-cli-scopes-"));
  const running = await startServer({
    dataDir: join(dir, "state"),
    port: 0,
    publicUrl: "http://127.0.0.1:0",
    gitSyncSeconds: 0,
  });
  const env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    XDG_STATE_HOME: dir,
    ALLGATHER_CONFIG_DIR: join(dir, "config"),
    ALLGATHER_URL: undefined,
    ALLGATHER_TOKEN: undefined,
  };
  const invoke = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "cli/index.ts", ...args, "--json"],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      code,
      result: out ? JSON.parse(out) : undefined,
      error: err ? JSON.parse(err).error : undefined,
    };
  };
  try {
    const requested = await authorizeCli(running, env);
    expect(requested).not.toContain("admin");
    expect(requested).not.toContain("history:write");
    expect(requested).toContain("offline_access");
    const project = await invoke("project", "create", "--name", "Scoped project");
    expect(project.code).toBe(0);
    const task = await invoke(
      "task",
      "create",
      "--project",
      project.result.id,
      "--title",
      "Ordinary work",
    );
    expect(task.code).toBe(0);
    const repository = [
      "repo",
      "add",
      "--project",
      project.result.id,
      "--name",
      "Fixture repository",
      "--upstream",
      "https://example.invalid/project.git",
      "--pause",
    ];
    for (const args of [
      ["machine", "create", "--name", "Denied machine"],
      ["storage", "get"],
      ["audit", "list"],
      ["artifact", "gc"],
      repository,
    ]) {
      const denied = await invoke(...args);
      expect(denied.code).toBe(1);
      expect(denied.error.code).toBe("forbidden");
    }
    const input = join(dir, "admin-operation.json");
    writeFileSync(input, JSON.stringify({ name: "Generic API denial" }));
    expect((await invoke("api", "machines_create", "--input", input)).error.code).toBe("forbidden");
    expect(running.workspace.all("SELECT id FROM machines")).toEqual([]);
    const credentialPath = join(dir, "config", "credentials.json");
    const saved = () =>
      JSON.parse(readFileSync(credentialPath, "utf8"))[running.settings.publicUrl];
    expect(
      (
        await fetch(running.settings.publicUrl + "/api/tower/credentials", {
          headers: { authorization: `Bearer ${saved().access_token}` },
        })
      ).status,
    ).toBe(403);

    expect(await authorizeCli(running, env, "admin offline_access")).toEqual([
      "admin",
      "offline_access",
    ]);
    const admin = saved();
    expect((await invoke("machine", "create", "--name", "Explicit admin machine")).code).toBe(0);
    expect((await invoke("storage", "get")).code).toBe(0);

    expect(await authorizeCli(running, env, "history:read history:write offline_access")).toEqual([
      "history:read",
      "history:write",
      "offline_access",
    ]);
    expect((await invoke(...repository)).code).toBe(0);
    expect((await invoke("storage", "get")).error.code).toBe("forbidden");
    expect((await invoke("project", "list")).error.code).toBe("forbidden");

    expect(await authorizeCli(running, env)).toEqual(requested);
    expect(saved().access_token).not.toBe(admin.access_token);
    expect((await invoke("storage", "get")).error.code).toBe("forbidden");
    expect(
      (
        await invoke(
          "repo",
          "sync",
          running.workspace.all<{ id: string }>("SELECT id FROM repositories")[0].id,
        )
      ).error.code,
    ).toBe("forbidden");
    expect((await invoke("task", "show", task.result.id)).result.id).toBe(task.result.id);
  } finally {
    await running.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
