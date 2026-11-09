import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureApiToken, fixtureLogin, fixtureResources } from "../scripts/fixture-auth.ts";
import { Auth, hash, secret } from "../server/auth.ts";
import { controlRequest } from "../server/control.ts";
import { startServer } from "../server/index.ts";
import { serverConfigCommand } from "../server/server-config.ts";
import { openDatabase } from "../server/storage.ts";
import { restoreSessionSchema31 } from "./fixtures/session-schema.ts";
import { restoreTaskSchema36 } from "./fixtures/task-schema.ts";

async function authorizeCli(
  running: Awaited<ReturnType<typeof startServer>>,
  env: NodeJS.ProcessEnv,
  scope?: string,
) {
  const url = running.settings.ownerUrl;
  const scopes = (
    scope ?? "tasks:read tasks:write projects:read projects:write repositories:read offline_access"
  ).split(" ");
  const cookie = await fixtureLogin(running.settings.dataDir, url);
  const opened = await fetch(url + "/api/cli/pairings", {
    method: "POST",
    headers: { cookie, origin: url, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Remote CLI",
      scopes: scopes.filter((s) => s !== "offline_access"),
      resource_grants: fixtureResources,
      permission_modes: {},
    }),
  });
  expect(opened.status).toBe(201);
  const pairing = await opened.json();
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "cli/index.ts",
      "login",
      `${url}/`,
      "--pairing-code-stdin",
      "--json",
    ],
    {
      env,
      stdin: new Blob([pairing.pairing_code + "\n"]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(err).not.toContain(pairing.pairing_code);
  expect(exit).toBe(0);
  expect(JSON.parse(out).authenticated).toBe(true);
  expect(
    running.workspace.one<{ confirmed_at: string }>(
      "SELECT confirmed_at FROM cli_pairings WHERE id=?",
      pairing.pairing_id,
    )?.confirmed_at,
  ).toBeTruthy();
  return scopes;
}

test("CLI pairing stores private rotating credentials and API grants cannot access MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "allgather-oauth-cli-")),
    running = await startServer({
      dataDir: join(dir, "state"),
      port: 0,
      ownerUrl: "http://localhost:0",
      gitSyncSeconds: 0,
    }),
    url = running.settings.ownerUrl,
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
    const serverConfig = join(dir, "config", "server.json");
    serverConfigCommand(["set", "ownerUrl", url], serverConfig);
    const serverSettings = readFileSync(serverConfig, "utf8");
    await authorizeCli(running, env);
    expect(readFileSync(serverConfig, "utf8")).toBe(serverSettings);
    expect(JSON.parse(readFileSync(join(dir, "config", "client.json"), "utf8")).url).toBe(url);
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
    expect(readFileSync(serverConfig, "utf8")).toBe(serverSettings);
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

test("CLI administrative access requires browser-selected scopes and re-pairing replaces local credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "allgather-cli-scopes-"));
  const running = await startServer({
    dataDir: join(dir, "state"),
    port: 0,
    ownerUrl: "http://localhost:0",
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
    expect(requested).not.toContain("repositories:write");
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
    const saved = () => JSON.parse(readFileSync(credentialPath, "utf8"))[running.settings.ownerUrl];
    expect(
      (
        await fetch(running.settings.ownerUrl + "/api/tower/credentials", {
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

    expect(
      await authorizeCli(running, env, "repositories:read repositories:write offline_access"),
    ).toEqual(["repositories:read", "repositories:write", "offline_access"]);
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

test("legacy master keys retire on upgrade and local recovery resets credentials without deleting work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "allgather-recovery-"));
  const legacy = secret();
  const db = openDatabase(join(dir, "allgather.sqlite"));
  const priorAuth = new Auth(db, "http://localhost:4390");
  const oldCookie = `allgather_session=${secret()}`;
  const oldLink = priorAuth.browser.createLink("Old browser");
  db.query("INSERT INTO settings VALUES('owner_key_hash',?)").run(hash(legacy));
  restoreSessionSchema31(db);
  restoreTaskSchema36(db);
  db.exec(
    "DROP TABLE cli_pairings; DROP TABLE oauth_requests; ALTER TABLE oauth_clients DROP COLUMN pairing_id; DROP TABLE mcp_pairings; DROP TRIGGER session_events_immutable; UPDATE session_events SET payload_hash=(SELECT payload FROM session_event_content WHERE id=session_events.id); ALTER TABLE session_events RENAME COLUMN payload_hash TO payload; CREATE TRIGGER session_events_immutable BEFORE UPDATE ON session_events BEGIN SELECT RAISE(ABORT,'Session events are append-only'); END; DROP TABLE session_event_content; DROP TRIGGER session_asset_retired; DROP TRIGGER session_asset_no_revival; DROP TABLE session_asset_identity; DROP TABLE transcript_deletions; DROP TRIGGER artifact_context_cleanup; DROP TRIGGER artifact_thread_context_cleanup; CREATE TRIGGER artifact_context_cleanup BEFORE DELETE ON artifacts BEGIN SELECT 1; END; CREATE TRIGGER artifact_thread_context_cleanup BEFORE DELETE ON threads BEGIN SELECT 1; END; DROP TRIGGER entity_tombstone_immutable; DROP TRIGGER artifact_comment_context_cleanup; DROP TRIGGER artifact_lifecycle_comment_context_cleanup; DROP TRIGGER artifact_version_context_cleanup; ALTER TABLE entities DROP COLUMN deleted_at; ALTER TABLE entities DROP COLUMN label; ALTER TABLE task_blockers DROP COLUMN resolved_comment_id; DROP TABLE tower_invitations; DROP TABLE approval_requests; ALTER TABLE oauth_tokens DROP COLUMN grant_id; DROP TABLE oauth_grants; ALTER TABLE agent_sessions DROP COLUMN project_id; ALTER TABLE oauth_clients DROP COLUMN audience; ALTER TABLE login_tokens DROP COLUMN expires_at; ALTER TABLE login_tokens DROP COLUMN consumed_at; PRAGMA user_version=20;",
  );
  db.query("INSERT INTO sessions(hash,expires,token_id) VALUES(?,?,?)").run(
    hash(oldCookie.split("=")[1]),
    "2099-01-01",
    oldLink.id,
  );
  db.close();
  writeFileSync(join(dir, "owner-key"), legacy, { mode: 0o600 });
  writeFileSync(join(dir, "login-token"), "old-bootstrap-token", { mode: 0o600 });
  const running = await startServer({
    dataDir: dir,
    port: 0,
    ownerUrl: "http://localhost:0",
    gitSyncSeconds: 0,
  });
  const origin = running.settings.ownerUrl;
  const request = (path: string, body: unknown, headers: Record<string, string>) =>
    fetch(origin + path, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    expect(existsSync(join(dir, "owner-key"))).toBe(false);
    expect(existsSync(join(dir, "login-token"))).toBe(false);
    expect(running.workspace.one("SELECT 1 FROM settings WHERE key='owner_key_hash'")).toBeNull();
    expect(
      (await request("/api/operations/projects_list", {}, { authorization: `Bearer ${legacy}` }))
        .status,
    ).toBe(401);
    expect((await request("/api/operations/projects_list", {}, { cookie: oldCookie })).status).toBe(
      401,
    );
    const cookie = await fixtureLogin(dir, origin);
    const token = await fixtureApiToken(origin, cookie);
    expect(
      (
        await request(
          "/api/passkeys/test/revoke",
          { label: "Privilege escalation" },
          { authorization: `Bearer ${token}` },
        )
      ).status,
    ).toBe(403);
    const created = await (
      await request(
        "/api/operations/projects_create",
        { name: "Retained work", operation_key: "create-project" },
        { cookie },
      )
    ).json();
    const machine = await (
      await request(
        "/api/operations/machines_create",
        { name: "Retained machine", operation_key: "create-machine" },
        { cookie },
      )
    ).json();
    const key = running.workspace.executions.issueCredential(machine.result.id, "Recovery fixture");
    expect(running.workspace.executions.authenticate(key.access_key)).not.toBeNull();
    expect(await (await controlRequest(dir, "auth/reset", {})).json()).toEqual({ reset: true });
    expect((await request("/api/operations/projects_list", {}, { cookie })).status).toBe(401);
    expect(
      (await request("/api/operations/projects_list", {}, { authorization: `Bearer ${token}` }))
        .status,
    ).toBe(401);
    expect(running.workspace.executions.authenticate(key.access_key)).toBeNull();
    expect(running.workspace.project(created.result.id).name).toBe("Retained work");
    expect(running.workspace.executions.machine(machine.result.id).name).toBe("Retained machine");
    const fresh = await fixtureLogin(dir, origin);
    expect((await request("/api/operations/projects_list", {}, { cookie: fresh })).status).toBe(
      200,
    );
  } finally {
    await running.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI pairing prompt hides input before displaying the prompt and restores control on cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "allgather-pairing-prompt-"));
  try {
    for (const [input, expected, exitCode] of [
      ["a".repeat(42) + "A\r", "accepted:43", 0],
      ["invalid-pairing-code\r", "Enter the CLI pairing code", 1],
      ["\u0003", "Login cancelled.", 1],
    ] as const) {
      let output = "",
        sent = false;
      let closed!: () => void;
      const terminalClosed = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `import { readPairingCode } from './cli/pairing-code.ts'; try { console.log('accepted:' + (await readPairingCode(false)).length); } catch (error) { console.error(error.message); process.exitCode = 1; }`,
        ],
        {
          env: {
            ...process.env,
            HOME: root,
            XDG_CONFIG_HOME: root,
            XDG_STATE_HOME: root,
            ALLGATHER_CONFIG_DIR: root,
          },
          terminal: {
            data(terminal, data) {
              output += new TextDecoder().decode(data);
              if (!sent && output.includes("Pairing code (hidden): ")) {
                sent = true;
                terminal.write(input);
              }
            },
            exit: () => closed(),
          },
        },
      );
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        expect(await child.exited).toBe(exitCode);
        await terminalClosed;
        expect(output).toContain(expected);
        if (input.length > 1) expect(output).not.toContain(input.trim());
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill();
        child.terminal?.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
