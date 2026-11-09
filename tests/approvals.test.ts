import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureApiToken, fixtureResources } from "../scripts/fixture-auth.ts";
import { fixtureBrowserCookie } from "../scripts/fixture-passkey.ts";
import { createApp, Updates } from "../server/app.ts";
import { approvalWait } from "../server/approvals.ts";
import { Auth } from "../server/auth.ts";
import { openDatabase } from "../server/storage.ts";
import { Workspace } from "../server/workspace.ts";
import { fullControls } from "./fixtures/tower-controls.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "allgather-approvals-")),
    path = join(root, "data.sqlite");
  let db = openDatabase(path),
    w = new Workspace(db, undefined, undefined, { dataDir: root }),
    auth = new Auth(db, "https://owner.example");
  let app = createApp(w, auth, new Updates());
  const cookie = fixtureBrowserCookie(db);
  const owner = () => auth.principal(new Request(auth.baseUrl, { headers: { cookie } }))!;
  const project = w.execute(
    "projects_create",
    { name: "Work", operation_key: "project" },
    owner(),
  ) as any;
  const machine = w.execute(
    "machines_create",
    { name: "Machine", operation_key: "machine" },
    owner(),
  ) as any;
  w.run(
    "UPDATE machines SET connected=1,capabilities=?,harnesses=?,harness_controls=? WHERE id=?",
    JSON.stringify(["managed-acp.v1", "command-receipts.v1", "session-stream.v1"]),
    '["fixture"]',
    JSON.stringify({ fixture: fullControls() }),
    machine.id,
  );
  const token = await fixtureApiToken(
    auth.baseUrl,
    cookie,
    [
      "tasks:read",
      "tasks:write",
      "sessions:read",
      "sessions:launch",
      "sessions:prompt",
      "sessions:stop",
      "sessions:resume",
    ],
    (r) => app.fetch(r),
    fixtureResources,
    {
      "sessions:launch": "approval",
      "sessions:prompt": "approval",
      "sessions:stop": "approval",
      "sessions:resume": "approval",
    },
  );
  const principal = () =>
    auth.principal(new Request(auth.baseUrl, { headers: { authorization: `Bearer ${token}` } }))!;
  const send = (path: string, body: unknown, asOwner = false, prefer = "wait=0") =>
    app.fetch(
      new Request(auth.baseUrl + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          prefer,
          ...(asOwner ? { cookie, origin: auth.baseUrl } : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      }),
    );
  const launch = {
    machine_id: machine.id,
    project_id: project.id,
    harness: "fixture",
    cwd: "/work/project",
    operation_key: "launch",
  };
  return {
    get w() {
      return w;
    },
    get auth() {
      return auth;
    },
    get app() {
      return app;
    },
    project,
    machine,
    token,
    cookie,
    owner,
    principal,
    send,
    launch,
    restart(beforeOpen?: (db: Workspace["db"]) => void) {
      w.approvals.close();
      db.close();
      db = openDatabase(path);
      beforeOpen?.(db);
      w = new Workspace(db, undefined, undefined, { dataDir: root });
      auth = new Auth(db, "https://owner.example");
      app = createApp(w, auth, new Updates());
      w.approvals.recover();
    },
    close() {
      w.approvals.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function pending(
  f: Awaited<ReturnType<typeof fixture>>,
  name = "session_launch",
  input = f.launch,
) {
  const response = await f.send(`/api/operations/${name}`, input);
  expect(response.status).toBe(403);
  const body = (await response.json()) as any;
  expect(body.error.code).toBe("needs_approval");
  expect(body.error.details.status).toBe("needs_approval");
  return body.error.details.request_id as string;
}

test("approval holds one exact request, survives timeout/restart and admits it once as the original client", async () => {
  const f = await fixture();
  try {
    const id = await pending(f);
    expect(f.w.all("SELECT * FROM session_commands")).toHaveLength(0);
    expect(f.w.all("SELECT * FROM session_runtimes")).toHaveLength(0);
    expect(await pending(f)).toBe(id);
    expect(
      (await f.send("/api/operations/session_launch", { ...f.launch, cwd: "/work/changed" }))
        .status,
    ).toBe(409);
    expect(() => f.w.execute("session_launch", f.launch, f.principal())).toThrow(
      "needs owner approval",
    );
    f.restart();
    const approved = await f.send(
      `/api/approvals/${id}/decision`,
      { decision: "approve", expected_revision: 1 },
      true,
    );
    expect(approved.status).toBe(200);
    const state = (await approved.json()) as any;
    expect(state.state).toBe("succeeded");
    expect(f.w.all("SELECT * FROM session_commands")).toHaveLength(1);
    expect(f.w.executions.managed.authority(state.result.command.id)).not.toBeNull();
    expect(
      f.w.one<{ connection_id: string }>(
        "SELECT connection_id FROM audit_operations WHERE id=?",
        state.result.command.operation_id,
      )?.connection_id,
    ).toBe(f.principal().id);
    const retry = await f.send("/api/operations/session_launch", f.launch);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as any).result.command.id).toBe(state.result.command.id);
    expect(
      (
        await f.send(
          `/api/approvals/${id}/decision`,
          { decision: "approve", expected_revision: 1 },
          true,
        )
      ).status,
    ).toBe(200);
    expect(f.w.all("SELECT * FROM session_commands")).toHaveLength(1);
    expect((await f.send("/api/operations/requests_get", { request_id: id })).status).toBe(200);
    f.w.run("UPDATE approval_requests SET state='executing',result=NULL WHERE id=?", id);
    f.restart();
    const recovered = await f.send("/api/operations/requests_get", { request_id: id });
    expect(((await recovered.json()) as any).result.state).toBe("succeeded");
    expect(f.w.all("SELECT * FROM session_commands")).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("approval can complete an outstanding call, wait is bounded, and tasks never enter the approval queue", async () => {
  const f = await fixture();
  try {
    expect(approvalWait(new Request(f.auth.baseUrl))).toBe(30000);
    expect(approvalWait(new Request(f.auth.baseUrl, { headers: { prefer: "wait=999" } }))).toBe(
      30000,
    );
    const response = f.send("/api/operations/session_launch", f.launch, false, "wait=1");
    for (let i = 0; i < 100 && !f.w.one("SELECT id FROM approval_requests"); i++)
      await Bun.sleep(5);
    const row = f.w.one<{ id: string }>("SELECT id FROM approval_requests")!;
    await f.send(
      `/api/approvals/${row.id}/decision`,
      { decision: "approve", expected_revision: 1 },
      true,
    );
    expect((await response).status).toBe(200);
    const start = Date.now();
    const timeout = await f.send(
      "/api/operations/session_launch",
      { ...f.launch, operation_key: "next" },
      false,
      "wait=1",
    );
    expect(timeout.status).toBe(403);
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    expect(Date.now() - start).toBeLessThan(3000);
    const task = await f.send("/api/operations/tasks_create", {
      project_id: f.project.id,
      title: "Ordinary task",
      operation_key: "task",
    });
    expect(task.status).toBe(200);
    expect(f.w.all("SELECT * FROM approval_requests")).toHaveLength(2);
  } finally {
    f.close();
  }
});

test("owner denial, expiry, revocation and target changes cannot produce an execution", async () => {
  const f = await fixture();
  try {
    const denied = await pending(f);
    expect(
      (
        await f.send(
          `/api/approvals/${denied}/decision`,
          { decision: "deny", expected_revision: 1 },
          true,
        )
      ).status,
    ).toBe(200);
    expect((await f.send("/api/operations/session_launch", f.launch)).status).toBe(403);
    const expired = await pending(f, "session_launch", { ...f.launch, operation_key: "expire" });
    f.w.run("UPDATE approval_requests SET expires_at='2000-01-01' WHERE id=?", expired);
    expect(
      (
        await f.send(
          `/api/approvals/${expired}/decision`,
          { decision: "approve", expected_revision: 1 },
          true,
        )
      ).status,
    ).toBe(409);
    const revoked = await pending(f, "session_launch", { ...f.launch, operation_key: "revoked" });
    f.auth.revokeToken(f.token);
    const settled = await f.send(
      `/api/approvals/${revoked}/decision`,
      { decision: "approve", expected_revision: 1 },
      true,
    );
    expect(settled.status).toBe(409);
    expect(f.w.approvals.ownerGet(revoked).error?.code).toBe("grant_revoked");
    expect(f.w.all("SELECT * FROM session_commands")).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("API clients cannot act as the owner or read another grant's approval requests", async () => {
  const f = await fixture();
  try {
    const id = await pending(f);
    expect(
      (await f.send(`/api/approvals/${id}/decision`, { decision: "approve", expected_revision: 1 }))
        .status,
    ).toBe(403);
    expect(() =>
      f.w.approvals.decide(id, "approve", 1, {
        id: "owner",
        kind: "owner",
        inlet: "browser",
        scopes: ["admin"],
      }),
    ).toThrow("Owner browser");
    const other = await fixtureApiToken(f.auth.baseUrl, f.cookie, ["admin"], (r) => f.app.fetch(r));
    const response = await f.app.fetch(
      new Request(f.auth.baseUrl + "/api/operations/requests_get", {
        method: "POST",
        headers: { authorization: `Bearer ${other}`, "content-type": "application/json" },
        body: JSON.stringify({ request_id: id }),
      }),
    );
    expect(response.status).toBe(404);
    const illegal = fixtureApiToken(
      f.auth.baseUrl,
      f.cookie,
      ["sessions:reply"],
      (r) => f.app.fetch(r),
      fixtureResources,
      { "sessions:reply": "approval" },
    );
    await expect(illegal).rejects.toThrow("Approval mode is only available");
    expect(f.w.all("SELECT * FROM approval_requests")).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("approval binds runtime generation and never applies a stale prompt to its replacement", async () => {
  const f = await fixture();
  try {
    const launch = f.w.execute(
      "session_launch",
      { ...f.launch, operation_key: "owner-launch" },
      f.owner(),
    ) as any;
    f.w.run(
      "UPDATE session_runtimes SET state='idle',connected=1,acp_session_id='native-acp' WHERE id=?",
      launch.runtime.id,
    );
    const input = {
      target_session_id: launch.session.id,
      operation_key: "prompt",
      content: [{ type: "text", text: "Do one thing" }],
    };
    const response = await f.send("/api/operations/session_prompt", input);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe("needs_approval");
    f.w.run(
      "UPDATE session_runtimes SET generation='replaced-generation' WHERE id=?",
      launch.runtime.id,
    );
    const approved = await f.send(
      `/api/approvals/${body.error.details.request_id}/decision`,
      { decision: "approve", expected_revision: 1 },
      true,
    );
    const result = (await approved.json()) as any;
    expect(result.state).toBe("failed");
    expect(result.error.code).toBe("request_changed");
    expect(f.w.all("SELECT id FROM session_commands WHERE kind='prompt'")).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("an interrupted approval result write recovers the committed admission rather than reporting no effect or replaying", async () => {
  const f = await fixture();
  try {
    const id = await pending(f);
    f.w.db.exec(
      "CREATE TRIGGER interrupt_approval_result BEFORE UPDATE ON approval_requests WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'injected result failure'); END",
    );
    const response = await f.send(
      `/api/approvals/${id}/decision`,
      { decision: "approve", expected_revision: 1 },
      true,
    );
    expect(response.status).toBe(500);
    expect(
      f.w.one<{ state: string }>("SELECT state FROM approval_requests WHERE id=?", id)?.state,
    ).toBe("executing");
    expect(f.w.all("SELECT * FROM session_commands")).toHaveLength(1);
    f.w.db.exec("DROP TRIGGER interrupt_approval_result");
    f.restart();
    expect(f.w.approvals.ownerGet(id).state).toBe("succeeded");
    expect(f.w.all("SELECT * FROM session_commands")).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("revocation during body upload is rechecked before ordinary mutations commit", async () => {
  const f = await fixture();
  try {
    let upload!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        upload = controller;
      },
    });
    const original = f.principal();
    const response = f.app.fetch(
      new Request(f.auth.baseUrl + "/api/operations/tasks_create", {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body,
      }),
    );
    await Bun.sleep(10);
    f.auth.revokeToken(f.token);
    upload.enqueue(
      new TextEncoder().encode(
        JSON.stringify({ project_id: f.project.id, title: "Late upload", operation_key: "late" }),
      ),
    );
    upload.close();
    expect([401, 403]).toContain((await response).status);
    await expect(
      f.w.dispatch(
        "tasks_create",
        { project_id: f.project.id, title: "Stale principal", operation_key: "stale" },
        original,
      ),
    ).rejects.toMatchObject({ code: "grant_revoked" });
    expect(f.w.all("SELECT id FROM tasks")).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("machine credential replacement invalidates review targets and undispatched approvals", async () => {
  const f = await fixture();
  try {
    const id = await pending(f);
    const credential = f.w.executions.issueCredential(f.machine.id, "Replacement");
    f.w.run("UPDATE machines SET active_credential_id=? WHERE id=?", credential.id, f.machine.id);
    const result = await f.send(
      `/api/approvals/${id}/decision`,
      { decision: "approve", expected_revision: 1 },
      true,
    );
    expect(((await result.json()) as any).error.code).toBe("request_changed");
    expect(f.w.all("SELECT * FROM session_commands")).toHaveLength(0);
    const fresh = await pending(f, "session_launch", { ...f.launch, operation_key: "fresh-peer" });
    const admitted = await f.send(
      `/api/approvals/${fresh}/decision`,
      { decision: "approve", expected_revision: 1 },
      true,
    );
    const command = ((await admitted.json()) as any).result.command;
    expect(f.w.executions.managed.authority(command.id)).not.toBeNull();
    const next = f.w.executions.issueCredential(f.machine.id, "Next replacement");
    f.w.run("UPDATE machines SET active_credential_id=? WHERE id=?", next.id, f.machine.id);
    expect(f.w.executions.managed.authority(command.id)).toBeNull();
  } finally {
    f.close();
  }
});

test("approval prompts reject hidden fields and non-text input, including stored requests during decision and recovery", async () => {
  const f = await fixture();
  try {
    const launch = f.w.execute(
      "session_launch",
      { ...f.launch, operation_key: "owner-text-launch" },
      f.owner(),
    ) as any;
    f.w.run(
      "UPDATE session_runtimes SET state='idle',connected=1,acp_session_id='fixture' WHERE id=?",
      launch.runtime.id,
    );
    const base = { target_session_id: launch.session.id };
    for (const content of [
      ...[
        0xfe0f, 0xe0100, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0xe000, 0xf0000, 0x100000, 0x0378,
        0xd800, 0xdc00,
      ].map((point) => [{ type: "text", text: `Visible${String.fromCodePoint(point)}hidden` }]),
      [{ type: "text", text: "Looks safe\u202Ehidden" }],
      [{ type: "text", text: "Looks safe\u200Bhidden" }],
      [{ type: "text", text: "Looks safe\u{E0069}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}" }],
      [{ type: "resource_link", uri: "https://example.invalid/hidden" }],
      [{ type: "text", text: "Visible", uri: "https://example.invalid/hidden" }],
      [{ type: "text", text: "Visible", resource: { text: "Hidden" } }],
      [{ type: "image", data: "secret", mimeType: "image/png" }],
      [
        { type: "text", text: "Visible" },
        { type: "audio", data: "secret" },
      ],
    ]) {
      const response = await f.send("/api/operations/session_prompt", {
        ...base,
        operation_key: crypto.randomUUID(),
        content,
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error.code).toBe("unsupported_approval_content");
    }
    expect(f.w.all("SELECT id FROM approval_requests")).toHaveLength(0);
    const make = async (key: string) => {
      const input = {
        ...base,
        operation_key: key,
        content: [
          { type: "text", text: "Part one" },
          { type: "text", text: "Part two" },
        ],
      };
      const response = await f.send("/api/operations/session_prompt", input);
      const body = (await response.json()) as any;
      expect(body.error.code).toBe("needs_approval");
      return { id: body.error.details.request_id, input };
    };
    for (const [recover, content] of [
      [false, { type: "resource_link", uri: "https://example.invalid/hidden" }],
      [true, { type: "resource_link", uri: "https://example.invalid/hidden" }],
      [false, { type: "text", text: "Visible\u202Ehidden" }],
      [true, { type: "text", text: "Visible\u{E0061}" }],
      ...[0xfe0f, 0xe0100, 0x3164, 0x2800, 0xe000, 0xf0000, 0x0378, 0xd800].flatMap((point) =>
        [false, true].map(
          (recover) =>
            [
              recover,
              { type: "text", text: `Visible${String.fromCodePoint(point)}hidden` },
            ] as const,
        ),
      ),
    ] as const) {
      const pending = await make(`old-${recover}-${crypto.randomUUID()}`);
      pending.input.content[0] = content as any;
      f.w.run(
        "UPDATE approval_requests SET input=?,state=? WHERE id=?",
        JSON.stringify(pending.input),
        recover ? "approved" : "needs_approval",
        pending.id,
      );
      if (recover) f.restart();
      else
        await f.send(
          `/api/approvals/${pending.id}/decision`,
          { decision: "approve", expected_revision: 1 },
          true,
        );
      expect(
        f.w.one<{ state: string; error: string }>(
          "SELECT state,error FROM approval_requests WHERE id=?",
          pending.id,
        ),
      ).toMatchObject({
        state: "failed",
        error: expect.stringContaining("unsupported_approval_content"),
      });
      expect(f.w.all("SELECT id FROM session_commands WHERE kind='prompt'")).toHaveLength(0);
    }
    const valid = await make("valid-text");
    const accepted = await f.send(
      `/api/approvals/${valid.id}/decision`,
      { decision: "approve", expected_revision: 1 },
      true,
    );
    expect(((await accepted.json()) as any).state).toBe("succeeded");
    const command = f.w.one<{ id: string }>("SELECT id FROM session_commands WHERE kind='prompt'")!;
    expect(f.w.approvals.commandApproved(valid.id, command.id, f.principal().grant_id!)).toBe(true);
    for (const point of [
      0x200b, 0xfe0f, 0xe0100, 0x115f, 0x2800, 0xe000, 0xf0000, 0x0378, 0xd800,
    ]) {
      f.w.run(
        "UPDATE approval_requests SET input=? WHERE id=?",
        JSON.stringify({
          ...valid.input,
          content: [{ type: "text", text: `Visible${String.fromCodePoint(point)}hidden` }],
        }),
        valid.id,
      );
      expect(f.w.approvals.commandApproved(valid.id, command.id, f.principal().grant_id!)).toBe(
        false,
      );
    }
  } finally {
    f.close();
  }
});

test("launch and resume approval reject hidden request and identity strings before persistence", async () => {
  const f = await fixture();
  try {
    for (const field of ["cwd", "harness", "label", "operator_name", "operation_key"]) {
      for (const hidden of ["\u202E", "\u200B", "\uFE0F", "\uFEFF"]) {
        const response = await f.send("/api/operations/session_launch", {
          ...f.launch,
          operation_key: crypto.randomUUID(),
          [field]: hidden + "visible",
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as any).error.code).toBe("unsupported_approval_content");
      }
    }
    const badPrincipal = { ...f.principal(), operator_name: "Trusted\u202Eclient" };
    await expect(
      f.w.approvals.request(
        "session_launch",
        { ...f.launch, operation_key: "bad-principal" },
        badPrincipal,
        { waitMs: 0 },
      ),
    ).rejects.toThrow("identity/target");
    const launch = f.w.execute(
      "session_launch",
      { ...f.launch, operation_key: "owner-runtime" },
      f.owner(),
    ) as any;
    const response = await f.send("/api/operations/session_resume", {
      target_session_id: launch.session.id,
      machine_id: f.machine.id,
      cwd: "/work/safe\u200Bhidden",
      operation_key: "resume-hidden",
    });
    expect(response.status).toBe(400);
    expect(f.w.all("SELECT id FROM approval_requests")).toHaveLength(0);
    expect(f.w.all("SELECT id FROM session_commands")).toHaveLength(1);
    const valid = await f.send("/api/operations/session_launch", {
      ...f.launch,
      cwd: "/arbitrary/visible/path",
      label: "Visible label",
      operation_key: "arbitrary-directory",
    });
    expect(((await valid.json()) as any).error.code).toBe("needs_approval");
  } finally {
    f.close();
  }
});

test("stored launch inputs and changed target names cannot bypass review or queued dispatch", async () => {
  const f = await fixture();
  try {
    const held = async (key: string) => {
      const r = await f.send("/api/operations/session_launch", { ...f.launch, operation_key: key });
      return ((await r.json()) as any).error.details.request_id as string;
    };
    for (const recovery of [false, true]) {
      const id = await held(`legacy-launch-${recovery}`);
      const input = JSON.parse(
        f.w.one<{ input: string }>("SELECT input FROM approval_requests WHERE id=?", id)!.input,
      );
      f.w.run(
        "UPDATE approval_requests SET input=?,state=? WHERE id=?",
        JSON.stringify({ ...input, cwd: "/safe/\u202Eevil" }),
        recovery ? "approved" : "needs_approval",
        id,
      );
      if (recovery) f.restart();
      else
        await f.send(
          `/api/approvals/${id}/decision`,
          { decision: "approve", expected_revision: 1 },
          true,
        );
      expect(
        f.w.one<{ state: string }>("SELECT state FROM approval_requests WHERE id=?", id)!.state,
      ).toBe("failed");
    }
    const id = await held("renamed-target");
    const machine = f.w.executions.machine(f.machine.id);
    f.w.execute(
      "machines_update",
      {
        machine_id: machine.id,
        name: "Safe\u200Bmachine",
        expected_revision: machine.revision,
        operation_key: "rename-hidden",
      },
      f.owner(),
    );
    const denied = await f.send(
      `/api/approvals/${id}/decision`,
      { decision: "approve", expected_revision: 1 },
      true,
    );
    expect(((await denied.json()) as any).error.code).toBe("unsupported_approval_content");
    expect(f.w.all("SELECT id FROM session_commands")).toHaveLength(0);
    const invalid = await f.send("/api/operations/session_launch", {
      ...f.launch,
      operation_key: "bad-target-at-create",
    });
    expect(((await invalid.json()) as any).error.code).toBe("unsupported_approval_content");
    f.w.execute(
      "machines_update",
      {
        machine_id: machine.id,
        name: "Visible machine",
        expected_revision: machine.revision + 1,
        operation_key: "rename-safe",
      },
      f.owner(),
    );
    const queued = await held("queued-launch");
    await f.send(
      `/api/approvals/${queued}/decision`,
      { decision: "approve", expected_revision: 1 },
      true,
    );
    const command = f.w.one<{ id: string }>("SELECT id FROM session_commands")!;
    expect(f.w.approvals.commandApproved(queued, command.id, f.principal().grant_id!)).toBe(true);
    const principal = JSON.parse(
      f.w.one<{ principal: string }>("SELECT principal FROM approval_requests WHERE id=?", queued)!
        .principal,
    );
    f.w.run(
      "UPDATE approval_requests SET principal=? WHERE id=?",
      JSON.stringify({ ...principal, operator_name: "Trusted\u200Bclient" }),
      queued,
    );
    expect(f.w.approvals.commandApproved(queued, command.id, f.principal().grant_id!)).toBe(false);
    f.w.run(
      "UPDATE approval_requests SET principal=? WHERE id=?",
      JSON.stringify(principal),
      queued,
    );
    expect(f.w.approvals.commandApproved(queued, command.id, f.principal().grant_id!)).toBe(true);
    f.restart((db) => {
      const row = db.query("SELECT payload FROM session_commands WHERE id=?").get(command.id) as {
        payload: string;
      };
      db.query("UPDATE session_commands SET payload=? WHERE id=?").run(
        JSON.stringify({ ...JSON.parse(row.payload), cwd: "/hidden/\u202Epath" }),
        command.id,
      );
    });
    expect(f.w.approvals.commandApproved(queued, command.id, f.principal().grant_id!)).toBe(false);
  } finally {
    f.close();
  }
});
