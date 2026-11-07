import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import { fullControls } from "../tests/fixtures/tower-controls.ts";
import { browserSession } from "./browser.ts";
import { fixtureApiToken, fixtureLogin, fixtureLoginToken } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to Chromium");
const root = mkdtempSync(join(tmpdir(), "allgather-approval-ui-"));
const running = await startServer({
  dataDir: root,
  port: 0,
  ownerUrl: "http://127.0.0.1:0",
  mcpUrl: "http://127.0.0.1:0",
  mcpPort: 0,
  gitSyncSeconds: 0,
});
let browser: Awaited<ReturnType<typeof browserSession>> | undefined;
try {
  browser = await browserSession(executable);
  const b = browser,
    owner = running.settings.ownerUrl,
    publicUrl = running.settings.mcpUrl!;
  const click = async (text: string) =>
    b.evaluate(
      `(()=>{const button=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Button missing');button.click();})()`,
    );
  await b.command("Page.navigate", { url: owner });
  await b.until(`!!document.querySelector('input[type=password]')`);
  await b.evaluate(
    `(()=>{const input=document.querySelector('input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(await fixtureLoginToken(root))});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await click("Sign in");
  await b.until(`!!document.querySelector('.app-header')`);
  const { project, machine } = (await b.evaluate(
    `(async()=>{const call=async(name,args)=>{const response=await fetch('/api/operations/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...args,operation_key:crypto.randomUUID()})});const data=await response.json();if(!response.ok)throw new Error(JSON.stringify(data));return data.result;};return {project:await call('projects_create',{name:'Approval project'}),machine:await call('machines_create',{name:'Approval machine'})};})()`,
  )) as { project: { id: string }; machine: { id: string } };
  running.workspace.run(
    "UPDATE machines SET connected=1,capabilities=?,harnesses=?,harness_controls=? WHERE id=?",
    JSON.stringify(["managed-acp.v1", "command-receipts.v1", "session-stream.v1"]),
    '["fixture"]',
    JSON.stringify({ fixture: fullControls() }),
    machine.id,
  );
  const client = (await (
    await fetch(publicUrl + "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Remote approval fixture",
        redirect_uris: [owner + "/callback"],
      }),
    })
  ).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(owner + "/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: owner + "/callback",
    response_type: "code",
    resource: publicUrl + "/mcp",
    scope: "sessions:read sessions:launch sessions:prompt",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  await b.command("Page.navigate", { url: url.toString() });
  await b.until(`!!document.querySelector('[aria-label="Launch a coding agent on a machine"]')`);
  await b.evaluate(`(()=>{
    if(document.querySelector('[aria-label="Launch a coding agent on a machine"]').value!=='approval')throw new Error('Unsafe execution default');
    const labels=Array.from(document.querySelectorAll('.permission-choice'));
    for(const name of ['Approval project','Approval machine']){const label=labels.find(l=>l.textContent.trim()===name);if(!label)throw new Error('Missing resource');label.querySelector('input').click();}
    if(labels.find(l=>l.textContent.includes('Unassigned —')).querySelector('input').checked)throw new Error('Unassigned must remain off');
  })()`);
  await click("Allow access");
  await b.until(
    `location.pathname==='/callback' && new URLSearchParams(location.search).has('code')`,
  );
  const code = (await b.evaluate(`new URLSearchParams(location.search).get('code')`)) as string;
  const tokenResponse = await fetch(publicUrl + "/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: owner + "/callback",
      resource: publicUrl + "/mcp",
      code,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) throw new Error(await tokenResponse.text());
  const token = (await tokenResponse.json()) as { access_token: string };
  await b.command("Page.navigate", { url: owner });
  await b.until(`!!document.querySelector('.app-header')`);
  let sequence = 0;
  const mcp = async (method: string, params: unknown) => {
    const response = await fetch(publicUrl + "/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        prefer: "wait=0",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as any;
  };
  await mcp("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "approval-fixture", version: "1" },
  });
  const args = {
    operation_key: "approval-browser",
    project_id: project.id,
    machine_id: machine.id,
    harness: "fixture",
    cwd: "/work/project",
  };
  const pending = await mcp("tools/call", { name: "session_launch", arguments: args });
  const held = JSON.parse(pending.result.content[0].text);
  if (!pending.result.isError || held.error.code !== "needs_approval")
    throw new Error("MCP did not hold execution for approval");
  const requestId = held.error.details.request_id;
  if (running.workspace.one<{ n: number }>("SELECT count(*) n FROM session_commands")!.n !== 0)
    throw new Error("Approval created an early command");
  await b.until(`!!document.querySelector('.approval-notice')`);
  await click("Review requests");
  await b.until(
    `document.querySelector('h1')?.textContent==='Request approvals' && !!document.querySelector('.approval-detail')`,
  );
  await b.until(
    `document.querySelector('.approval-detail')?.textContent.includes('Approval machine') && document.querySelector('.approval-detail')?.textContent.includes('/work/project')`,
  );
  await click("Approve this request");
  await b.until(
    `document.querySelector('.approval-detail')?.textContent.includes('Request admitted')`,
  );
  const result = await mcp("tools/call", {
    name: "requests_get",
    arguments: { request_id: requestId },
  });
  const state = JSON.parse(result.result.content[0].text);
  if (state.state !== "succeeded" || !state.result.command?.id)
    throw new Error("MCP result retrieval failed");
  await mcp("tools/call", { name: "session_launch", arguments: args });
  if (running.workspace.one<{ n: number }>("SELECT count(*) n FROM session_commands")!.n !== 1)
    throw new Error("Approval replayed an admission");
  const other = await mcp("tools/call", {
    name: "session_launch",
    arguments: { ...args, operation_key: "denied" },
  });
  const deniedId = JSON.parse(other.result.content[0].text).error.details.request_id;
  await b.until(
    `Array.from(document.querySelectorAll('.approvals .task-row')).some(row=>row.textContent.includes('needs approval'))`,
  );
  if (
    !(await b.evaluate(
      `document.querySelector('.approval-detail').textContent.includes('Request admitted')`,
    ))
  )
    throw new Error("An arriving request replaced the owner's selection");
  await b.evaluate(
    `Array.from(document.querySelectorAll('.approvals .task-row')).find(row=>row.textContent.includes('needs approval')).click()`,
  );
  await click("Deny request");
  await b.until(`document.querySelector('.approval-detail').textContent.includes('denied')`);
  const denied = await mcp("tools/call", {
    name: "requests_get",
    arguments: { request_id: deniedId },
  });
  if (JSON.parse(denied.result.content[0].text).state !== "denied")
    throw new Error("Denial was not persisted");
  running.workspace.run(
    "UPDATE session_runtimes SET state='idle',connected=1,acp_session_id='approval-browser-fixture' WHERE id=?",
    state.result.runtime.id,
  );
  const parts = [
    { type: "text", text: "First part: <script>plain text only</script>" },
    { type: "text", text: "Second part:\n\t中文 café 😀\r\nhttps://example.invalid/resource" },
  ];
  const promptArgs = {
    target_session_id: state.result.session.id,
    operation_key: "multipart-prompt",
    content: parts,
  };
  const promptResponse = await mcp("tools/call", { name: "session_prompt", arguments: promptArgs });
  const promptId = JSON.parse(promptResponse.result.content[0].text).error.details.request_id;
  await b.command("Page.navigate", { url: owner + "/?view=approvals&request=" + promptId });
  await b.until(`!!document.querySelector('[aria-label="Complete prompt"]')`);
  const visible = await b.evaluate<string[]>(
    `[...document.querySelectorAll('[aria-label="Complete prompt"] pre')].map(el=>el.textContent)`,
  );
  if (JSON.stringify(visible) !== JSON.stringify(parts.map((p) => p.text)))
    throw new Error("Approval omitted or transformed a prompt part");
  if (
    await b.evaluate<boolean>(`!!document.querySelector('[aria-label="Complete prompt"] script')`)
  )
    throw new Error("Prompt text became executable markup");
  await click("Approve this request");
  await b.until(
    `document.querySelector('.approval-detail')?.textContent.includes('Request admitted')`,
  );
  const hidden = await mcp("tools/call", {
    name: "session_prompt",
    arguments: {
      ...promptArgs,
      operation_key: "hidden-resource",
      content: [{ type: "text", text: "Visible", uri: "https://example.invalid/hidden" }],
    },
  });
  if (JSON.parse(hidden.result.content[0].text).error.code !== "unsupported_approval_content")
    throw new Error("Hidden prompt fields entered the approval flow");
  const legacyResponse = await mcp("tools/call", {
    name: "session_prompt",
    arguments: { ...promptArgs, operation_key: "legacy-prompt" },
  });
  const legacyId = JSON.parse(legacyResponse.result.content[0].text).error.details.request_id;
  running.workspace.run(
    "UPDATE approval_requests SET input=? WHERE id=?",
    JSON.stringify({
      ...promptArgs,
      operation_key: "legacy-prompt",
      content: [{ type: "text", text: "Looks safe\uFE0F\u{E0160}\u3164\u2800" }],
    }),
    legacyId,
  );
  await b.command("Page.navigate", { url: owner + "/?view=approvals&request=" + legacyId });
  await b.until(
    `document.querySelector('.approval-detail')?.textContent.includes('cannot be approved')`,
  );
  if (
    !(await b.evaluate<boolean>(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='Approve this request').disabled`,
    ))
  )
    throw new Error("Legacy unsupported prompt remained approvable");
  await click("Deny request");
  await b.until(`document.querySelector('.approval-detail')?.textContent.includes('denied')`);
  const invalidLaunch = await mcp("tools/call", {
    name: "session_launch",
    arguments: { ...args, operation_key: "hidden-directory", cwd: "/work/\u202Eevil" },
  });
  if (
    JSON.parse(invalidLaunch.result.content[0].text).error.code !== "unsupported_approval_content"
  )
    throw new Error("Hidden directory entered the approval flow");
  const legacyLaunch = await mcp("tools/call", {
    name: "session_launch",
    arguments: { ...args, operation_key: "legacy-launch" },
  });
  const legacyLaunchId = JSON.parse(legacyLaunch.result.content[0].text).error.details.request_id;
  const saved = running.workspace.one<{ input: string; principal: string }>(
    "SELECT input,principal FROM approval_requests WHERE id=?",
    legacyLaunchId,
  )!;
  running.workspace.run(
    "UPDATE approval_requests SET input=?,principal=? WHERE id=?",
    JSON.stringify({
      ...JSON.parse(saved.input),
      cwd: "/work/\u202Eevil",
      label: "task\u200Blabel",
    }),
    JSON.stringify({ ...JSON.parse(saved.principal), operator_name: "Trusted\u200Bclient" }),
    legacyLaunchId,
  );
  await b.command("Page.navigate", { url: owner + "/?view=approvals&request=" + legacyLaunchId });
  await b.until(
    `document.querySelector('.approval-detail')?.textContent.includes('cannot be approved')`,
  );
  const displayed = await b.evaluate<string>(
    `document.querySelector('.approval-detail').textContent`,
  );
  if (
    !displayed.includes("/work/\\u{202E}evil") ||
    !displayed.includes("Trusted\\u{200B}client") ||
    displayed.includes("\u202E") ||
    displayed.includes("\u200B")
  )
    throw new Error("Unsafe legacy metadata was not visibly escaped");
  if (
    !(await b.evaluate<boolean>(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='Approve this request').disabled`,
    ))
  )
    throw new Error("Unsafe legacy launch remained approvable");
  await click("Deny request");
  await b.until(`document.querySelector('.approval-detail')?.textContent.includes('denied')`);
  const cliToken = await fixtureApiToken(
    owner,
    await fixtureLogin(root, owner),
    ["sessions:read", "sessions:launch"],
    fetch,
    { project_ids: [project.id], machine_ids: [machine.id], unassigned: false },
    { "sessions:launch": "approval" },
  );
  const cliPending = await fetch(owner + "/api/operations/session_launch", {
    method: "POST",
    headers: {
      authorization: `Bearer ${cliToken}`,
      "content-type": "application/json",
      prefer: "wait=0",
    },
    body: JSON.stringify({ ...args, operation_key: "cli-held" }),
  });
  const cliRequest = ((await cliPending.json()) as { error: { details: { request_id: string } } })
    .error.details.request_id;
  const cli = Bun.spawn(
    [process.execPath, "--no-env-file", "cli/index.ts", "request", "show", cliRequest, "--json"],
    {
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_STATE_HOME: root,
        ALLGATHER_CONFIG_DIR: join(root, "cli"),
        ALLGATHER_URL: owner,
        ALLGATHER_TOKEN: cliToken,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, errors, exit] = await Promise.all([
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
    cli.exited,
  ]);
  if (exit || JSON.parse(output).state !== "needs_approval")
    throw new Error(`CLI request lookup failed: ${errors}`);
  if ((await fetch(publicUrl + "/api/approvals")).status !== 404)
    throw new Error("Owner inbox is public");
  await b.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await b.until(`document.documentElement.scrollWidth<=innerWidth+1`);
  console.log(
    "Approval UI passed: public MCP with private owner consent, scoped resources, execution approval default, held request, owner review, durable MCP and CLI result lookup, duplicate suppression, pinned review selection, denial, and mobile layout. Machine capabilities were synthetic; no native agent was launched.",
  );
} finally {
  await browser?.close();
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}
