import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import type { Machine, SessionRuntime } from "../shared/contracts.ts";
import { fixtureOwner } from "../tests/fixtures/tower-controls.ts";
import { browserSession } from "./browser.ts";
import { fixtureLoginToken } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to Chromium");
const root = mkdtempSync(join(tmpdir(), "allgather-controls-ui-"));
const running = await startServer({
  dataDir: root,
  port: 0,
  ownerUrl: "http://127.0.0.1:0",
  gitSyncSeconds: 0,
});
let browser: Awaited<ReturnType<typeof browserSession>> | undefined;
try {
  const w = running.workspace,
    owner = fixtureOwner(w);
  const machine = w.execute(
    "machines_create",
    { name: "Synthetic bridge", operation_key: randomUUID() },
    owner,
  ) as Machine;
  const controls = { protocol: "acp", capabilities: ["prompt", "resume"], cancel_mode: "runtime" };
  w.run(
    "UPDATE machines SET connected=1,harnesses=?,harness_controls=?,capabilities=? WHERE id=?",
    JSON.stringify(["restricted-fixture"]),
    JSON.stringify({ "restricted-fixture": controls }),
    JSON.stringify([
      "managed-acp.v1",
      "command-receipts.v1",
      "session-stream.v1",
      "session-resume.v1",
      "session-force-resume.v1",
    ]),
    machine.id,
  );
  const runtime = (
    w.execute(
      "session_launch",
      {
        machine_id: machine.id,
        harness: "restricted-fixture",
        cwd: "/work/project",
        label: "Text-only fixture",
        operation_key: randomUUID(),
      },
      owner,
    ) as { runtime: SessionRuntime }
  ).runtime;
  w.run(
    "UPDATE session_runtimes SET state='idle',acp_session_id='bridge-session',native_session_id='native-session',tower_session_id='tower-ui-session',owner_id='fixture-owner' WHERE id=?",
    runtime.id,
  );
  w.run(
    "INSERT INTO tower_records VALUES(?,?,?,?)",
    machine.id,
    "tower-ui-session",
    JSON.stringify({ id: "tower-ui-session", checkout_id: "local-ui-worktree" }),
    w.now(),
  );
  w.run("UPDATE session_commands SET state='acknowledged' WHERE runtime_id=?", runtime.id);
  browser = await browserSession(executable);
  const b = browser;
  await b.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await b.command("Page.navigate", {
    url: `${running.settings.ownerUrl}/?view=sessions&session=${runtime.session_id}`,
  });
  await b.until(`!!document.querySelector('input[type="password"]')`);
  await b.evaluate(`document.querySelector('input[type="password"]').focus()`);
  await b.command("Input.insertText", { text: await fixtureLoginToken(root) });
  await b.evaluate(`document.querySelector('button[type="submit"]').click()`);
  await b.until(`document.body.textContent.includes('Stop runtime and queued work')`);
  await b.until(
    `document.querySelector('.session-checkout')?.textContent.includes('Awaiting checkout observation')`,
  );
  w.run(
    "INSERT INTO tower_checkouts(machine_id,checkout_id,repository_id,record,received_at,present) VALUES(?,?,NULL,?,?,1)",
    machine.id,
    "local-ui-worktree",
    JSON.stringify({
      id: "local-ui-worktree",
      repository_id: null,
      path: "/work/observed-worktree",
      system: "git",
      branch: "feature/ui",
      head: null,
      dirty: false,
      conflicts: false,
      locked: false,
      prunable: false,
      available: true,
      tracking_ref: null,
      ahead: null,
      behind: null,
      observed_at: Date.now(),
      revision: 1,
    }),
    w.now(),
  );
  w.onChange();
  await b.until(
    `document.querySelector('.session-checkout')?.textContent.includes('/work/observed-worktree') && document.querySelector('.session-checkout')?.textContent.includes('local-ui-worktree')`,
  );
  if (w.executions.runtime(runtime.session_id)?.cwd !== "/work/project")
    throw new Error("Observation changed the execution directory");
  if (
    !(await b.evaluate(
      `document.body.textContent.includes('Live permission replies are unavailable') && document.body.textContent.includes('Live configuration changes are unavailable') && document.querySelector('.session-composer input[type="file"]').disabled`,
    ))
  )
    throw new Error("Restricted controls were exposed");
  await b.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent==='Stop runtime and queued work').click()`,
  );
  await b.until(
    `document.body.textContent.includes('Stopping this runtime') && !document.querySelector('.session-composer')`,
  );
  if (w.all("SELECT * FROM session_runtimes").length !== 1)
    throw new Error("Stop automatically created another runtime");
  w.run(
    "UPDATE session_runtimes SET state='ended',connected=0,termination='confirmed',fenced=1 WHERE id=?",
    runtime.id,
  );
  w.onChange();
  await b.until(
    `[...document.querySelectorAll('button')].some(b=>b.textContent==='Resume session')`,
  );
  await b.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent==='Resume session').click()`,
  );
  await b.until(`document.querySelector('.session-detail')?.textContent.includes('starting')`);
  if (w.all("SELECT * FROM session_runtimes").length !== 2)
    throw new Error("Explicit resume did not allocate a fresh runtime");
  if (await b.evaluate(`document.documentElement.scrollWidth>innerWidth`))
    throw new Error("Controls overflow mobile viewport");
  const resumed = w.executions.runtime(runtime.session_id);
  if (!resumed) throw new Error("Resumed execution is missing");
  w.run(
    "UPDATE session_runtimes SET state='error',termination='unknown',fenced=1 WHERE id=?",
    resumed.id,
  );
  w.onChange();
  await b.until(
    `document.querySelector('.session-detail')?.textContent.includes('error') && [...document.querySelectorAll('button')].some(b=>b.textContent==='Clean up and resume' && !b.disabled)`,
  );
  await b.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent==='Clean up and resume').click()`,
  );
  await b.until(`document.querySelector('.session-detail')?.textContent.includes('starting')`);
  await b.until(
    `fetch('/api/operations/session_runtime_get', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target_session_id:${JSON.stringify(runtime.session_id)}})}).then(r=>r.json()).then(r=>r.result.runtime.id!==${JSON.stringify(resumed.id)})`,
  );
  const forced = w.executions.runtime(runtime.session_id);
  if (!forced) throw new Error("Force resume did not create a replacement");
  const forcedCommand = w.one<{ payload: string }>(
    "SELECT payload FROM session_commands WHERE runtime_id=? AND kind='resume'",
    forced.id,
  );
  const forcedPayload = forcedCommand && JSON.parse(forcedCommand.payload);
  if (
    forced.id === resumed.id ||
    !forcedPayload?.force ||
    forcedPayload.cleanup?.[0]?.runtime_id !== resumed.id
  )
    throw new Error("Force resume did not capture the old execution for cleanup");
  w.run(
    "UPDATE session_runtimes SET state='error',termination='confirmed',fenced=1 WHERE id=?",
    forced.id,
  );
  w.onChange();
  await b.until(
    `document.querySelector('.session-detail')?.textContent.includes('error') && [...document.querySelectorAll('button')].some(b=>b.textContent==='Clean up and resume' && !b.disabled)`,
  );
  if (
    await b.evaluate(
      `[...document.querySelectorAll('button')].some(b=>b.textContent==='Resume session')`,
    )
  )
    throw new Error("Settled replacement hid an older unresolved execution");
  await b.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent==='Clean up and resume').click()`,
  );
  await b.until(
    `fetch('/api/operations/session_runtime_get', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target_session_id:${JSON.stringify(runtime.session_id)}})}).then(r=>r.json()).then(r=>r.result.runtime.id!==${JSON.stringify(forced.id)})`,
  );
  const retried = w.executions.runtime(runtime.session_id);
  if (!retried) throw new Error("Force recovery did not create a replacement");
  const retriedCommand = w.one<{ payload: string }>(
    "SELECT payload FROM session_commands WHERE runtime_id=? AND kind='resume'",
    retried.id,
  );
  const retriedPayload = retriedCommand && JSON.parse(retriedCommand.payload);
  if (
    !retriedPayload?.force ||
    retriedPayload.cleanup?.length !== 1 ||
    retriedPayload.cleanup[0].runtime_id !== resumed.id
  )
    throw new Error("Browser recovery did not target only the older unresolved execution");
  const questionControls = {
    protocol: "acp",
    capabilities: ["prompt", "elicitation_reply"],
    cancel_mode: "turn",
  };
  w.run(
    "UPDATE machines SET harnesses=?,harness_controls=? WHERE id=?",
    JSON.stringify(["restricted-fixture", "question-fixture"]),
    JSON.stringify({ "restricted-fixture": controls, "question-fixture": questionControls }),
    machine.id,
  );
  const questionRuntime = (
    w.execute(
      "session_launch",
      {
        machine_id: machine.id,
        harness: "question-fixture",
        cwd: "/work/project",
        label: "Form fixture",
        operation_key: randomUUID(),
      },
      owner,
    ) as { runtime: SessionRuntime }
  ).runtime;
  w.run(
    "UPDATE session_runtimes SET state='idle',acp_session_id='question-acp',tower_session_id='question-tower',owner_id='question-owner' WHERE id=?",
    questionRuntime.id,
  );
  const prompt = w.execute(
    "session_prompt",
    {
      target_session_id: questionRuntime.session_id,
      content: [{ type: "text", text: "Ask a question" }],
      operation_key: randomUUID(),
    },
    owner,
  ) as { id: string };
  w.run("UPDATE session_runtimes SET active_prompt_id=? WHERE id=?", prompt.id, questionRuntime.id);
  const question = w.executions.managed.receiveRequest(machine.id, {
    runtime_id: questionRuntime.id,
    generation: questionRuntime.generation,
    owner_id: "question-owner",
    source_request_id: "multi-select",
    request_revision: 1,
    native_request_id: 1,
    kind: "elicitation",
    state: "pending",
    payload: {
      mode: "form",
      message: "Choose both fixture values",
      requestedSchema: {
        type: "object",
        properties: {
          colors: {
            type: "array",
            title: "Colors",
            items: { type: "string", enum: ["form-private-blue", "form-private-red"] },
            minItems: 1,
            uniqueItems: true,
          },
        },
        required: ["colors"],
        additionalProperties: false,
      },
    },
  });
  await b.command("Page.navigate", {
    url: `${running.settings.ownerUrl}/?view=sessions&session=${questionRuntime.session_id}`,
  });
  await b.until(`document.querySelectorAll('.session-request input[type="checkbox"]').length===2`);
  await b.evaluate(
    `document.querySelectorAll('.session-request input[type="checkbox"]')[0].click()`,
  );
  await b.until(`document.querySelectorAll('.session-request input:checked').length===1`);
  await b.evaluate(
    `document.querySelectorAll('.session-request input[type="checkbox"]')[1].click()`,
  );
  await b.until(`document.querySelectorAll('.session-request input:checked').length===2`);
  await b.evaluate(`document.querySelector('.session-request button[type="submit"]').click()`);
  await b.until(`!document.querySelector('.session-request')`);
  const answered = w.one<{ reply_command_id: string; state: string }>(
    "SELECT reply_command_id,state FROM session_requests WHERE id=?",
    question.request_id,
  )!;
  const response = w.executions.managed.reply(answered.reply_command_id)?.response as {
    content?: { colors?: string[] };
  };
  if (
    answered.state !== "answered" ||
    response.content?.colors?.join(",") !== "form-private-blue,form-private-red"
  )
    throw new Error("Multi-select reply did not preserve the selected array");
  if (JSON.stringify(w.all("SELECT * FROM session_commands")).includes("form-private-blue"))
    throw new Error("Private form response entered durable command payloads");
  if (await b.evaluate(`document.documentElement.scrollWidth>innerWidth`))
    throw new Error("Form controls overflow mobile viewport");
  const terminalKey = w.executions.issueCredential(machine.id, "Terminal UI", [
    "read",
    "send",
    "terminal:control",
  ]);
  w.run(
    "UPDATE machines SET terminal_controls=?,active_credential_id=?,capabilities=? WHERE id=?",
    JSON.stringify({
      "terminal-fixture": { protocol: "terminal", capabilities: [], cancel_mode: "runtime" },
    }),
    terminalKey.id,
    JSON.stringify([...w.executions.machine(machine.id).capabilities, "terminal-launch.v1"]),
    machine.id,
  );
  w.onChange();
  await b.evaluate(
    `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='New session').click()`,
  );
  await b.until(`!!document.querySelector('dialog select option[value="terminal"]')`);
  await b.evaluate(`(() => {
    const dialog=document.querySelector('dialog');
    const mode=dialog.querySelector('select option[value="terminal"]').parentElement;
    mode.value='terminal';mode.dispatchEvent(new Event('change',{bubbles:true}));
    const machine=[...dialog.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value===${JSON.stringify(machine.id)}));
    machine.value=${JSON.stringify(machine.id)};machine.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await b.until(`!!document.querySelector('dialog select option[value="terminal-fixture"]')`);
  await b.evaluate(
    `(() => { const agent=document.querySelector('dialog select option[value="terminal-fixture"]').parentElement;agent.value='terminal-fixture';agent.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('dialog input[placeholder="/work/project"]').focus(); })()`,
  );
  await b.command("Input.insertText", { text: "/work/terminal-ui" });
  await b.evaluate(`document.querySelector('dialog form button[type="submit"]').click()`);
  await b.until(
    `document.querySelector('.session-detail')?.textContent.includes('This is a terminal session')`,
  );
  const terminalRuntime = w.one<SessionRuntime>(
    "SELECT * FROM session_runtimes WHERE protocol='terminal'",
  );
  if (!terminalRuntime) throw new Error("Browser did not select terminal mode");
  w.run(
    "UPDATE session_runtimes SET state='running',tower_session_id='terminal-ui-session',owner_id='terminal-ui-owner' WHERE id=?",
    terminalRuntime.id,
  );
  w.run("UPDATE session_commands SET state='acknowledged' WHERE runtime_id=?", terminalRuntime.id);
  w.onChange();
  await b.until(
    `document.querySelector('.session-detail')?.textContent.includes('tower-cli attach terminal-ui-session')`,
  );
  if (
    await b.evaluate(
      `!!document.querySelector('.session-composer') || [...document.querySelectorAll('.session-detail button')].some(e=>e.textContent==='Resume session')`,
    )
  )
    throw new Error("Terminal mode exposed structured prompt or resume controls");
  await b.evaluate(
    `[...document.querySelectorAll('.session-detail button')].find(e=>e.textContent==='Stop runtime and queued work').click()`,
  );
  await b.until(
    `document.querySelector('.session-detail')?.textContent.includes('Stopping this runtime')`,
  );
  const stop = w.one<{ payload: string }>(
    "SELECT payload FROM session_commands WHERE runtime_id=? AND kind='cancel'",
    terminalRuntime.id,
  );
  if (stop?.payload !== "{}")
    throw new Error("Terminal stop did not use its empty payload contract");
  if (await b.evaluate(`document.documentElement.scrollWidth>innerWidth`))
    throw new Error("Terminal controls overflow mobile viewport");
  console.log(
    "Session controls UI passed: late checkout reference resolution, text-only attachments, unavailable permission/configuration notices, runtime stop, blocked continuation, explicit resume and session-wide force cleanup after a settled replacement, multi-select forms with private replies, explicit terminal launch mode, lifecycle-only display, unsupported controls hidden, terminal stop, mobile layout. Synthetic bridge only.",
  );
} finally {
  await browser?.close();
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}
