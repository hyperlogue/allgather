import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startServer } from "../server/index.ts";
import type { Machine, SessionCommand, SessionRuntime } from "../shared/contracts.ts";
import { receiptSchema } from "../shared/tower-acp.ts";
import { fixtureApiToken, fixtureLoginToken, fixtureResources } from "./fixture-auth.ts";
import { stopFixturePool, towerFixture } from "./tower-fixture.ts";

// Real Tower/Allgather transport and runtime owner, with a synthetic shared Codex host.
// This runner does not establish interoperability with an installed provider or use its credentials.
const bundle = towerFixture("ag-managed-");
const { root } = bundle;
const binary = bundle.cli,
  fixtureBin = join(root, "bin"),
  config = join(root, "config", "tower"),
  fixtureHome = join(root, "home");
mkdirSync(fixtureBin, { recursive: true, mode: 0o700 });
mkdirSync(fixtureHome, { recursive: true, mode: 0o700 });
mkdirSync(config, { recursive: true, mode: 0o700 });
mkdirSync(join(root, "runtime"), { recursive: true, mode: 0o700 });
writeFileSync(
  join(fixtureBin, "codex"),
  `#!${process.execPath} --no-env-file\n${readFileSync(new URL("../tests/fixtures/app-server.mjs", import.meta.url), "utf8")}`,
  { mode: 0o700 },
);
writeFileSync(
  join(config, "config.toml"),
  '[scan]\nenabled=false\n[allgather]\nscopes=["read","send","acp:control"]\n',
  { mode: 0o600 },
);
const trace = join(fixtureHome, "dispatches");
const env = {
  PATH: `${fixtureBin}:${dirname(process.execPath)}:/run/current-system/sw/bin:/usr/bin:/bin`,
  HOME: fixtureHome,
  XDG_STATE_HOME: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  TOKIO_WORKER_THREADS: "2",
};
let running = await startServer({
  dataDir: join(root, "server"),
  port: 0,
  ownerUrl: "http://127.0.0.1:0",
  gitSyncSeconds: 0,
});
const origin = running.settings.ownerUrl;
let login: ReturnType<typeof Bun.spawn> | undefined,
  cookie = "";
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function waitFor(check: () => boolean | Promise<boolean>, what: string) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${what}`);
}
async function command(executable: string, args: string[], tolerate = false) {
  const p = Bun.spawn([executable, ...args], {
    env,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), 15000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code && !tolerate)
      throw new Error(`Tower ${args[0]} failed: ${(err || out).slice(0, 500)}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
async function cli(args: string[], tolerate = false) {
  const out = await command(binary, ["--json", ...args], tolerate);
  return out ? JSON.parse(out) : null;
}
async function stopFixtureSessions() {
  const records = await cli(["ls", "--ownership", "owned"]);
  for (const record of records ?? []) await cli(["kill", record.id], true);
}
const stopHost = () => command(join(fixtureBin, "codex"), ["app-server", "daemon", "stop"]);
async function request(path: string, body?: unknown, bearer?: string) {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie }),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${data.error?.code ?? response.status}`);
  return data;
}
const operation = <T>(name: string, body: unknown, bearer?: string): Promise<T> =>
  request(
    `/api/operations/${name}`,
    { operation_key: randomUUID(), ...(body as object) },
    bearer,
  ).then((data) => data.result as T);
async function* objects(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "",
    start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for await (const chunk of stream) {
    for (const char of decoder.decode(chunk, { stream: true })) {
      buffer += char;
      if (start < 0) {
        if (/\s/.test(char)) {
          buffer = "";
          continue;
        }
        if (char !== "{") throw new Error("Tower login did not return JSON");
        start = 0;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        yield JSON.parse(buffer);
        buffer = "";
        start = -1;
      }
    }
  }
  if (buffer.trim()) throw new Error("Incomplete login result");
}
try {
  assert(
    running.settings.managedSessions,
    "Managed sessions are disabled; this runner verifies the normal enabled path",
  );
  login = Bun.spawn([binary, "--json", "login", origin], {
    env,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => login?.kill(), 30000);
  let complete = false;
  try {
    for await (const message of objects(login.stdout as ReadableStream<Uint8Array>)) {
      assert(
        !("polling_token" in message) && !("access_key" in message),
        "Private enrollment credential was printed",
      );
      if (message.authorization_url) {
        assert(
          message.authorization_url.startsWith(origin + "/tower/enroll/"),
          "Wrong consent origin",
        );
        const signIn = await fetch(origin + "/api/login", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ key: await fixtureLoginToken(join(root, "server")) }),
        });
        assert(signIn.ok, "Synthetic owner login failed");
        await signIn.arrayBuffer();
        cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
        const info = await request(`/api/tower/enrollments/${message.id}`);
        assert(info.requested_scopes.includes("acp:control"), "Control consent was not requested");
        await request(`/api/tower/enrollments/${message.id}/decision`, {
          decision: "authorize",
          node_label: "Managed fixture",
          scopes: ["read", "send", "acp:control"],
        });
      }
      if (message.state === "complete") complete = true;
    }
    assert((await login.exited) === 0 && complete, "Browser enrollment did not complete");
  } finally {
    clearTimeout(deadline);
  }
  await cli([
    "rpc",
    "rules.put",
    JSON.stringify({
      rule: {
        id: "allow.fixture",
        from: "allgather",
        kind: "session",
        to: "harness:codex",
        action: "allow",
        created_by: "fixture",
        created_at: Date.now(),
      },
    }),
  ]);
  let machine!: Machine;
  await waitFor(() => {
    const row = running.workspace.one<{ id: string }>("SELECT id FROM machines LIMIT 1");
    if (!row) return false;
    machine = running.workspace.executions.machine(row.id);
    return machine.connected && machine.policy_status === "applied";
  }, "handshake and applied policy");
  assert(!!machine.harness_controls.codex, "Tower did not advertise Codex managed controls.");
  const approvalToken = await fixtureApiToken(
    origin,
    cookie,
    ["sessions:read", "sessions:launch"],
    fetch,
    fixtureResources,
    { "sessions:launch": "approval" },
  );
  const launchInput = {
    operation_key: randomUUID(),
    machine_id: machine.id,
    harness: "codex",
    cwd: root,
    label: "Native protocol fixture",
  };
  const held = await fetch(origin + "/api/operations/session_launch", {
    method: "POST",
    headers: {
      authorization: `Bearer ${approvalToken}`,
      "content-type": "application/json",
      prefer: "wait=0",
    },
    body: JSON.stringify(launchInput),
  });
  const heldBody = await held.json();
  assert(heldBody.error?.code === "needs_approval", "Connector launch bypassed approval");
  assert(
    running.workspace.all("SELECT id FROM session_commands").length === 0,
    "An unapproved request queued native work",
  );
  const approved = await request(`/api/approvals/${heldBody.error.details.request_id}/decision`, {
    decision: "approve",
    expected_revision: 1,
  });
  assert(approved.state === "succeeded", "Owner approval did not admit the request");
  const launch = approved.result as { runtime: SessionRuntime; command: SessionCommand };
  const retrieved = await request(
    "/api/operations/requests_get",
    { request_id: heldBody.error.details.request_id },
    approvalToken,
  );
  assert(
    retrieved.result.result.command.id === launch.command.id,
    "Request result did not preserve command identity",
  );
  const repeated = await request("/api/operations/session_launch", launchInput, approvalToken);
  assert(
    repeated.result.command.id === launch.command.id,
    "Approval retry created another command",
  );
  const runtime = () => running.workspace.executions.runtime(launch.runtime.session_id)!;
  await waitFor(
    () => runtime().state === "idle" && !!runtime().native_session_id,
    "native app-server readiness",
  );
  assert(
    runtime().protocol === "codex-app-server" && runtime().acp_session_id === null,
    "Native IDs were conflated",
  );
  const ownerId = runtime().owner_id,
    nativeId = runtime().native_session_id;
  const second = await operation<{ runtime: SessionRuntime }>("session_launch", {
    machine_id: machine.id,
    harness: "codex",
    cwd: root,
    label: "Isolated second thread",
  });
  const secondRuntime = () => running.workspace.executions.runtime(second.runtime.session_id)!;
  await waitFor(
    () => secondRuntime().state === "idle" && !!secondRuntime().native_session_id,
    "second native thread readiness",
  );
  assert(secondRuntime().native_session_id !== nativeId, "Sessions shared a native thread");
  assert(
    readFileSync(join(fixtureHome, "hosts.jsonl"), "utf8").trim().split("\n").length === 1,
    "Managed sessions started separate Codex hosts",
  );
  const first = await operation<SessionCommand>("session_prompt", {
    target_session_id: runtime().session_id,
    content: [{ type: "text", text: "permission first" }],
  });
  const pending = () =>
    running.workspace.one<{ id: string; revision: number; source_request_id: string }>(
      "SELECT id,revision,source_request_id FROM session_requests WHERE runtime_id=? AND state='pending' ORDER BY rowid DESC LIMIT 1",
      runtime().id,
    );
  await waitFor(() => !!pending(), "live private approval");
  const firstRequest = pending()!;
  await operation("session_reply", {
    request_id: firstRequest.id,
    expected_revision: firstRequest.revision,
    response: { outcome: { outcome: "selected", optionId: "reject_once" } },
  });
  await waitFor(
    () => !runtime().active_prompt_id && runtime().state === "idle",
    "first turn completion",
  );
  assert(
    running.workspace.executions.command(first.id).state === "acknowledged",
    "Receipt did not preserve acceptance",
  );
  const hold = await operation<SessionCommand>("session_prompt", {
    target_session_id: runtime().session_id,
    content: [{ type: "text", text: "permission hold across restart" }],
  });
  await waitFor(() => !!pending(), "second private approval");
  const occurrence = pending()!.source_request_id;
  const settings = {
    dataDir: running.settings.dataDir,
    port: running.settings.port,
    ownerUrl: origin,
    gitSyncSeconds: 0,
  };
  await running.stop();
  running = await startServer(settings);
  await waitFor(
    () => runtime().connected && pending()?.source_request_id === occurrence,
    "private reannouncement after Allgather server restart",
  );
  assert(
    runtime().owner_id === ownerId && runtime().native_session_id === nativeId,
    "Restart replaced the execution owner",
  );
  await operation("session_cancel", { target_session_id: runtime().session_id });
  await waitFor(
    () => !runtime().active_prompt_id && runtime().state === "idle",
    "cancel while a native approval is pending",
  );
  assert(!pending(), "Cancellation left a live approval");
  assert(
    readFileSync(trace, "utf8").trim().split("\n").length === 2,
    "A prompt was replayed across reconnect",
  );
  const continuing = await operation<SessionCommand>("session_prompt", {
    target_session_id: runtime().session_id,
    content: [{ type: "text", text: "hold an active turn across daemon restart" }],
  });
  await waitFor(
    () =>
      runtime().active_prompt_id === continuing.id &&
      readFileSync(trace, "utf8").trim().split("\n").length === 3,
    "active native turn before daemon restart",
  );
  await cli(["daemon", "stop"]);
  await cli(["rpc", "daemon.info"]);
  await waitFor(
    () =>
      runtime().connected &&
      runtime().active_prompt_id === continuing.id &&
      runtime().state === "running",
    "continued native turn after daemon restart",
  );
  assert(
    runtime().owner_id === ownerId && runtime().native_session_id === nativeId,
    "Daemon restart changed execution identity",
  );
  assert(
    readFileSync(trace, "utf8").trim().split("\n").length === 3,
    "Daemon restart replayed native prompt input",
  );
  await operation("session_cancel", { target_session_id: runtime().session_id });
  await waitFor(
    () => runtime().state === "idle" && !runtime().active_prompt_id,
    "cancel continued native turn",
  );
  const history =
    JSON.stringify(running.workspace.all("SELECT * FROM session_events")) +
    JSON.stringify(running.workspace.all("SELECT * FROM session_requests")) +
    JSON.stringify(running.workspace.all("SELECT * FROM session_commands"));
  assert(!history.includes("synthetic-private-request"), "Private request leaked to durable state");
  assert(
    running.workspace.executions.command(hold.id).state === "acknowledged",
    "Cancelled turn erased command acceptance",
  );
  const artifact = await operation<{ id: string }>("artifacts_create", {
    kind: "html",
    title: "Managed review fixture",
  });
  const agentToken = await fixtureApiToken(origin, cookie, [
    "artifacts:read",
    "artifacts:notify",
    "sessions:prompt",
  ]);
  await operation(
    "artifacts_listen",
    { artifact_id: artifact.id, session_id: runtime().session_id, operator_kind: "agent" },
    agentToken,
  );
  await operation("artifact_threads_add", {
    artifact_id: artifact.id,
    input: { body: "Inspect this review result", target: { kind: "artifact" } },
  });
  const busy = await operation<SessionCommand>("session_prompt", {
    target_session_id: runtime().session_id,
    content: [{ type: "text", text: "permission before the queued review" }],
  });
  await waitFor(
    () =>
      runtime().active_prompt_id === busy.id &&
      !!pending() &&
      readFileSync(trace, "utf8").trim().split("\n").length === 4,
    "fourth native turn",
  );
  const notification = await operation<{ notification: { command_id: string; route: string } }>(
    "artifacts_submit",
    { artifact_id: artifact.id },
  );
  const notificationId = notification.notification.command_id;
  assert(
    notification.notification.route === "managed" &&
      running.workspace.executions.command(notificationId).state === "queued",
    "Notification bypassed the tracked turn queue",
  );
  const beforeReview = pending()!;
  await operation("session_reply", {
    request_id: beforeReview.id,
    expected_revision: beforeReview.revision,
    response: { outcome: { outcome: "selected", optionId: "reject_once" } },
  });
  await waitFor(
    () =>
      !!running.workspace.one(
        "SELECT 1 FROM session_events WHERE command_id=? AND kind='turn_end'",
        notificationId,
      ),
    "correlated review notification turn",
  );
  assert(
    running.workspace.artifacts!.notifications.latest(artifact.id)?.acknowledgement === "adapter",
    "Notification lost admission evidence",
  );
  assert(
    running.workspace.artifacts!.conversations.hasPending(artifact.id),
    "Prompt delivery incorrectly acknowledged the review",
  );
  await operation("artifacts_submit", { artifact_id: artifact.id });
  assert(
    readFileSync(trace, "utf8").trim().split("\n").length === 5,
    "Identical review notification was repeated",
  );
  const archived = await operation<{ notification: { acknowledgement: string } }>(
    "artifacts_archive",
    { artifact_id: artifact.id, comment: "Synthetic archive acknowledgement" },
  );
  assert(
    archived.notification.acknowledgement === "adapter",
    "Archive did not retain managed admission evidence",
  );
  const archiveCommand = running.workspace.artifacts!.notifications.latest(artifact.id)?.command_id;
  await waitFor(
    () =>
      !!running.workspace.one(
        "SELECT 1 FROM session_events WHERE command_id=? AND kind='turn_end'",
        archiveCommand!,
      ),
    "correlated archive notification turn",
  );
  assert(
    running.workspace.artifacts!.store.get(artifact.id).state === "archived",
    "Archive did not commit after admission",
  );
  assert(
    readFileSync(trace, "utf8").trim().split("\n").length === 6,
    "Unexpected native prompt dispatch count",
  );
  assert(
    readFileSync(join(fixtureHome, "hosts.jsonl"), "utf8").trim().split("\n").length === 1,
    "Reconnect replaced the shared Codex host",
  );
  assert(
    secondRuntime().state === "idle" &&
      !running.workspace.one(
        "SELECT 1 FROM session_events WHERE runtime_id=? AND kind='turn_end'",
        second.runtime.id,
      ),
    "A turn leaked into the second session",
  );
  if (process.env.ALLGATHER_TEST_FORCE_RESUME === "1") {
    assert(
      machine.capabilities.includes("session-force-resume.v1"),
      "Tower does not advertise force resume",
    );
    const previous = runtime();
    const resume = {
      target_session_id: previous.session_id,
      machine_id: machine.id,
      cwd: root,
      operation_key: randomUUID(),
      force: true,
    };
    const replacement = await operation<{ runtime: SessionRuntime; command: SessionCommand }>(
      "session_resume",
      resume,
    );
    assert(replacement.command.payload.force === true, "Force cleanup was omitted");
    assert(
      JSON.stringify(replacement.command.payload.cleanup) ===
        JSON.stringify([{ runtime_id: previous.id, generation: previous.generation }]),
      "Cleanup targeted a different execution",
    );
    await waitFor(
      () =>
        runtime().id === replacement.runtime.id &&
        runtime().state === "idle" &&
        runtime().connected,
      "force cleanup and replacement readiness",
    );
    const old = running.workspace.one<{ fenced: number; termination: string }>(
      "SELECT fenced,termination FROM session_runtimes WHERE id=?",
      previous.id,
    );
    assert(
      old?.fenced === 1 && old.termination === "confirmed",
      "Replacement preceded confirmed cleanup",
    );
    assert(
      runtime().generation !== previous.generation && runtime().owner_id !== previous.owner_id,
      "Force resume reused the old execution",
    );
    assert(
      runtime().native_session_id === previous.native_session_id &&
        runtime().tower_session_id === previous.tower_session_id,
      "Force resume discarded conversation identity",
    );
    assert(
      secondRuntime().state === "idle" && !secondRuntime().fenced,
      "Cleanup affected the other execution in the same directory",
    );
    const retried = await operation<{ command: SessionCommand }>("session_resume", resume);
    assert(retried.command.id === replacement.command.id, "Resume retry allocated another command");
    assert(
      readFileSync(trace, "utf8").trim().split("\n").length === 6,
      "Force resume replayed a prompt",
    );
    const continued = await operation<SessionCommand>("session_prompt", {
      target_session_id: runtime().session_id,
      content: [{ type: "text", text: "Continue after targeted cleanup" }],
    });
    await waitFor(
      () =>
        !!running.workspace.one(
          "SELECT 1 FROM session_events WHERE command_id=? AND kind='turn_end'",
          continued.id,
        ),
      "post-cleanup turn completion",
    );
    assert(
      readFileSync(trace, "utf8").trim().split("\n").length === 7,
      "Post-cleanup prompt did not dispatch exactly once",
    );
    assert(
      readFileSync(join(fixtureHome, "hosts.jsonl"), "utf8").trim().split("\n").length === 1,
      "Cleanup restarted the shared host",
    );
    console.log(
      "Force resume passed: targeted confirmed cleanup, new owner/generation, stable conversation, isolated sibling session, retry/no replay and continued turn.",
    );
  }
  if (process.env.ALLGATHER_TEST_FORCE_FAILURE === "1") {
    assert(
      machine.capabilities.includes("session-force-resume.v1"),
      "Tower does not advertise force resume",
    );
    const failureLaunch = await operation<{ runtime: SessionRuntime }>("session_launch", {
      machine_id: machine.id,
      harness: "codex",
      cwd: root,
      label: "Cleanup fault fixture",
    });
    const failureRuntime = () =>
      running.workspace.executions.runtime(failureLaunch.runtime.session_id)!;
    await waitFor(
      () => failureRuntime().state === "idle" && !!failureRuntime().native_session_id,
      "cleanup fault fixture readiness",
    );
    const materialize = await operation<SessionCommand>("session_prompt", {
      target_session_id: failureRuntime().session_id,
      content: [{ type: "text", text: "Materialize fault fixture history" }],
    });
    await waitFor(
      () =>
        !!running.workspace.one(
          "SELECT 1 FROM session_events WHERE command_id=? AND kind='turn_end'",
          materialize.id,
        ),
      "fault fixture native history",
    );
    const original = failureRuntime();
    const opensBefore = readFileSync(join(fixtureHome, "native-opens.jsonl"), "utf8");
    const promptsBefore = readFileSync(trace, "utf8");
    const marker = join(fixtureHome, "held-native-thread");
    writeFileSync(marker, String(original.native_session_id), { mode: 0o600 });
    try {
      const input = {
        target_session_id: original.session_id,
        machine_id: machine.id,
        cwd: root,
        force: true,
        operation_key: randomUUID(),
      };
      const attempted = await operation<{ command: SessionCommand; runtime: SessionRuntime }>(
        "session_resume",
        input,
      );
      await waitFor(
        () =>
          !!running.workspace.one(
            "SELECT 1 FROM session_commands WHERE id=? AND json_extract(result,'$.acceptance.level')='adapter'",
            attempted.command.id,
          ),
        "durable cleanup admission",
      );
      const admittedReceipt = receiptSchema.parse(
        running.workspace.executions.command(attempted.command.id).result,
      );
      const acceptance = admittedReceipt.acceptance;
      assert(
        admittedReceipt.dispatch.state === "not_started" && failureRuntime().state === "starting",
        "Cleanup fault completed before recovery cut point",
      );
      await cli(["daemon", "stop"]);
      await cli(["rpc", "daemon.info"]);
      await waitFor(() => {
        const receipt = receiptSchema.safeParse(
          running.workspace.executions.command(attempted.command.id).result,
        );
        return (
          receipt.success &&
          receipt.data.error?.code === "cleanup_unconfirmed" &&
          failureRuntime().termination === "confirmed"
        );
      }, "recovered cleanup failure and reserved-runtime settlement");
      const receipt = receiptSchema.parse(
        running.workspace.executions.command(attempted.command.id).result,
      );
      assert(
        receipt.state === "accepted" &&
          JSON.stringify(receipt.acceptance) === JSON.stringify(acceptance),
        "Cleanup failure erased original admission",
      );
      assert(
        receipt.dispatch.state === "finished" &&
          receipt.dispatch.transport_written === false &&
          !receipt.result &&
          receipt.error?.stage === "execution" &&
          receipt.error.may_have_effect,
        "Cleanup effects or replacement dispatch evidence changed",
      );
      const reserved = failureRuntime();
      assert(
        reserved.fenced === 1 &&
          reserved.state === "error" &&
          reserved.owner_id &&
          !reserved.native_session_id &&
          !reserved.acp_session_id,
        "Reserved replacement was not explicitly retired without native identity",
      );
      const old = running.workspace.one<{ termination: string; fenced: number }>(
        "SELECT termination,fenced FROM session_runtimes WHERE id=?",
        original.id,
      );
      assert(
        old?.fenced === 1 && old.termination === "unknown",
        "Reserved loss incorrectly confirmed the old target",
      );
      assert(
        !running.workspace.one("SELECT 1 FROM session_events WHERE runtime_id=?", reserved.id),
        "Failure synthesized replacement execution events",
      );
      const retried = await operation<{ command: SessionCommand }>("session_resume", input);
      assert(
        retried.command.id === attempted.command.id,
        "Cleanup failure retry allocated a new command",
      );
      await waitFor(
        () => runtime().connected && secondRuntime().connected,
        "unaffected sibling reconnect after fault recovery",
      );
      const opensAfter = readFileSync(join(fixtureHome, "native-opens.jsonl"), "utf8");
      assert(opensAfter.startsWith(opensBefore), "Native fixture history was rewritten");
      const recoveredOpens = opensAfter
        .slice(opensBefore.length)
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; thread_id: string });
      const siblingIds = new Set([runtime().native_session_id, secondRuntime().native_session_id]);
      assert(
        recoveredOpens.every(
          (opened) => opened.method === "thread/resume" && siblingIds.has(opened.thread_id),
        ),
        `Failed cleanup dispatched native replacement: ${JSON.stringify(recoveredOpens)}`,
      );
      assert(readFileSync(trace, "utf8") === promptsBefore, "Cleanup recovery replayed a prompt");
      assert(
        runtime().state === "idle" &&
          secondRuntime().state === "idle" &&
          !runtime().fenced &&
          !secondRuntime().fenced,
        "Failed cleanup affected a sibling",
      );
      assert(
        readFileSync(join(fixtureHome, "hosts.jsonl"), "utf8").trim().split("\n").length === 1,
        "Failed cleanup killed the shared host",
      );
      const priorLoss = running.workspace.one<{ loss_id: string; revision: number }>(
        "SELECT loss_id,revision FROM runtime_losses WHERE runtime_id=? ORDER BY revision DESC LIMIT 1",
        original.id,
      );
      assert(priorLoss, "Unresolved old target has no durable loss report");
      rmSync(marker, { force: true });
      const recoveryInput = { ...input, operation_key: randomUUID() };
      const recovery = await operation<{ command: SessionCommand; runtime: SessionRuntime }>(
        "session_resume",
        recoveryInput,
      );
      assert(
        recovery.command.id !== attempted.command.id,
        "Fresh recovery reused the failed command",
      );
      assert(
        JSON.stringify(recovery.command.payload.cleanup) ===
          JSON.stringify([{ runtime_id: original.id, generation: original.generation }]),
        "Fresh recovery included the settled reservation or missed the old execution",
      );
      await waitFor(
        () =>
          failureRuntime().id === recovery.runtime.id &&
          failureRuntime().state === "idle" &&
          failureRuntime().connected,
        "fresh force recovery after clearing the native fault",
      );
      const recovered = failureRuntime();
      assert(
        recovered.native_session_id === original.native_session_id &&
          recovered.tower_session_id === original.tower_session_id,
        "Recovery replaced conversation identity",
      );
      assert(
        recovered.owner_id !== original.owner_id &&
          recovered.owner_id !== reserved.owner_id &&
          recovered.generation !== original.generation &&
          recovered.generation !== reserved.generation,
        "Recovery reused a fenced owner or generation",
      );
      const confirmed = running.workspace.one<{
        loss_id: string;
        revision: number;
        termination: string;
      }>(
        "SELECT l.loss_id,l.revision,r.termination FROM runtime_losses l JOIN session_runtimes r ON r.id=l.runtime_id WHERE l.runtime_id=? ORDER BY l.revision DESC LIMIT 1",
        original.id,
      );
      assert(
        confirmed?.termination === "confirmed" &&
          confirmed.loss_id === priorLoss.loss_id &&
          confirmed.revision > priorLoss.revision,
        "Old cleanup lost its identity or became ready before confirmation",
      );
      const settled = running.workspace.one<{
        fenced: number;
        termination: string;
        native_session_id: string | null;
        acp_session_id: string | null;
      }>(
        "SELECT fenced,termination,native_session_id,acp_session_id FROM session_runtimes WHERE id=?",
        reserved.id,
      );
      assert(
        settled?.fenced === 1 &&
          settled.termination === "confirmed" &&
          settled.native_session_id === null &&
          settled.acp_session_id === null,
        "Recovery revived the settled reservation",
      );
      const opensRecovered = readFileSync(join(fixtureHome, "native-opens.jsonl"), "utf8");
      assert(opensRecovered.startsWith(opensAfter), "Recovery rewrote native-open history");
      const newOpens = opensRecovered
        .slice(opensAfter.length)
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert(
        newOpens.length === 1 &&
          newOpens[0].method === "thread/resume" &&
          newOpens[0].thread_id === original.native_session_id,
        "Fresh recovery did not resume the original native thread exactly once",
      );
      const recoveryRetry = await operation<{ command: SessionCommand }>(
        "session_resume",
        recoveryInput,
      );
      assert(
        recoveryRetry.command.id === recovery.command.id &&
          readFileSync(join(fixtureHome, "native-opens.jsonl"), "utf8") === opensRecovered,
        "Fresh recovery retry reopened native execution",
      );
      assert(readFileSync(trace, "utf8") === promptsBefore, "Fresh recovery replayed prompt input");
      const continued = await operation<SessionCommand>("session_prompt", {
        target_session_id: recovered.session_id,
        content: [{ type: "text", text: "Continue after cleanup recovery" }],
      });
      await waitFor(
        () =>
          !!running.workspace.one(
            "SELECT 1 FROM session_events WHERE command_id=? AND kind='turn_end'",
            continued.id,
          ),
        "continued work after recovered cleanup",
      );
      assert(
        readFileSync(trace, "utf8").trim().split("\n").length ===
          promptsBefore.trim().split("\n").length + 1,
        "Post-recovery prompt did not dispatch exactly once",
      );
      assert(
        runtime().state === "idle" &&
          secondRuntime().state === "idle" &&
          !runtime().fenced &&
          !secondRuntime().fenced,
        "Fresh recovery affected a sibling",
      );
      assert(
        readFileSync(join(fixtureHome, "hosts.jsonl"), "utf8").trim().split("\n").length === 1,
        "Fresh recovery restarted the shared host",
      );
      assert(recovered.tower_session_id, "Recovered execution has no Tower identity");
      await cli(["kill", recovered.tower_session_id]);
      await waitFor(
        () => failureRuntime().termination === "confirmed",
        "recovered fixture runtime stop",
      );
      console.log(
        "Recovered cleanup failure and fresh retry passed with synthetic retained-thread fault injection: permanent acceptance, confirmed reserved loss, old target initially unknown, settled reservation excluded from fresh cleanup, stable conversation, advancing loss revision, exact native resume/retry/no replay, continued prompt and sibling/shared-host isolation.",
      );
    } finally {
      rmSync(marker, { force: true });
    }
  }
  const primaryTowerId = runtime().tower_session_id;
  const secondTowerId = secondRuntime().tower_session_id;
  assert(primaryTowerId && secondTowerId, "Missing Tower session identity for stop");
  await cli(["kill", primaryTowerId]);
  await waitFor(() => runtime().termination === "confirmed", "first targeted runtime stop");
  assert(
    secondRuntime().state === "idle" && !secondRuntime().fenced,
    "Stopping one runtime stopped its sibling",
  );
  await cli(["kill", secondTowerId]);
  await waitFor(
    () =>
      runtime().fenced === 1 &&
      runtime().termination === "confirmed" &&
      secondRuntime().fenced === 1 &&
      secondRuntime().termination === "confirmed",
    "confirmed runtime stops",
  );
  const hostStatus = JSON.parse(
    await command(join(fixtureBin, "codex"), ["app-server", "daemon", "status"]),
  );
  assert(hostStatus.status === "running", "Runtime stop terminated the shared native host");
  await stopHost();
  const host = JSON.parse(readFileSync(join(fixtureHome, "hosts.jsonl"), "utf8").trim()) as {
    pid: number;
  };
  await waitFor(() => {
    try {
      process.kill(host.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  }, "shared fixture host exit");
  console.log(
    "Managed transport passed with a synthetic shared Unix WebSocket app-server: two isolated native threads, browser consent, scopes/policy, launch, receipts, private approval, source events, private approval across server reconnect and native turn continuation across daemon restart, cancel, no replay, redaction, tracked review notifications, archive admission, and runtime/host stop. Base flow used six native prompts. Installed provider behavior is not tested.",
  );
} catch (error) {
  console.error(
    "Synthetic managed integration state",
    JSON.stringify({
      runtimes: running.workspace.all(
        "SELECT id,state,connected,fenced,active_prompt_id FROM session_runtimes",
      ),
      commands: running.workspace.all(
        "SELECT id,kind,state,json_extract(result,'$.state') receipt_state,json_extract(result,'$.error.code') receipt_error,json_extract(result,'$.code') local_error,json_extract(payload,'$.source.kind') source FROM session_commands",
      ),
      notifications: running.workspace.all(
        "SELECT command_id,state,error FROM artifact_notifications",
      ),
      events: running.workspace.all(
        "SELECT kind,command_id,source_sequence,json_extract(payload,'$.stop_reason') stop_reason FROM session_events ORDER BY sequence DESC LIMIT 12",
      ),
    }),
  );
  throw error;
} finally {
  if (login?.exitCode === null) login.kill();
  try {
    await stopFixtureSessions();
  } catch {}
  try {
    await stopHost();
  } finally {
    try {
      await cli(["--no-start", "daemon", "stop"], true);
    } catch {}
    await stopFixturePool(bundle, env);
    await running.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
