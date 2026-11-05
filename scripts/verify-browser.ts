import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import { browserSession } from "./browser.ts";
import { fixtureLogin, fixtureLoginToken, fixtureTowerEnrollment } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to a Chromium executable");
const directory = mkdtempSync(join(tmpdir(), "allgather-ui-"));
const running = await startServer({ dataDir: directory, port: 0, ownerUrl: "http://127.0.0.1:0" });
let browser: Awaited<ReturnType<typeof browserSession>> | undefined;
let checkoutSocket: WebSocket | undefined;
try {
  browser = await browserSession(executable);
  const b = browser;
  await b.command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await b.command("Page.navigate", { url: running.settings.ownerUrl });
  await b.until(`!!document.querySelector('input[type="password"]')`);
  const fill = async (selector: string, text: string) => {
    await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await b.command("Input.insertText", { text });
  };
  const click = async (text: string) => {
    await b.evaluate(
      `(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!el)throw new Error('Button missing: '+${JSON.stringify(text)});el.click()})()`,
    );
  };
  const field = async (label: string, value: string, scope = "") => {
    const selector = `${scope} label`;
    await b.evaluate(
      `(()=>{const label=[...document.querySelectorAll(${JSON.stringify(selector)})].find(l=>l.childNodes[0]?.textContent.trim()===${JSON.stringify(label)});if(!label)throw new Error('Missing field '+${JSON.stringify(label)});const el=label.querySelector('input,textarea,select');const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`,
    );
  };
  await fill('input[type="password"]', await fixtureLoginToken(directory));
  await click("Sign in");
  await b.until(`!!document.querySelector('.app-header')`);
  await b.evaluate(`document.querySelector('[aria-label="New project"]').click()`);
  await b.until(`!!document.querySelector('dialog[open] input')`);
  await fill("dialog input", "Example project");
  await click("Create project");
  await b.until(
    `!document.querySelector('dialog')&&document.querySelector('h1')?.textContent==='Example project'`,
  );
  await click("New task");
  await b.until(`!!document.querySelector('dialog[open] input')`);
  await fill("dialog input", "Verify interrupted imports");
  await fill("dialog textarea", "Resume from the saved checkpoint.");
  await field("Labels", "Backend, Review, backend", "dialog");
  await click("Create task");
  await b.until(
    `!document.querySelector('dialog') && document.querySelector('.task-detail h2')?.textContent==='Verify interrupted imports'`,
  );
  const taskForContext = running.workspace.one<{ id: string }>(
    "SELECT id FROM tasks WHERE title='Verify interrupted imports'",
  )!;
  await b.evaluate(`(async()=>{
    const op=async(name,input)=>{const r=await fetch('/api/operations/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation_key:crypto.randomUUID(),...input})});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data.result;};
    const a=await op('artifacts_create',{kind:'html',title:'Deleted fixture review'});
    await op('links_add',{source_id:${JSON.stringify(taskForContext.id)},target_id:a.id,type:'produces'});
    await op('artifacts_delete',{artifact_id:a.id});
  })()`);
  await b.until(`!!document.querySelector('.context-row button')`);
  await b.evaluate(`document.querySelector('.context-row button').click()`);
  await b.until(
    `document.querySelector('dialog')?.textContent.includes('Deleted fixture review · Deleted')`,
  );
  await b.until(`document.querySelector('dialog')?.textContent.includes('content is unavailable')`);
  if (
    await b.evaluate<boolean>(
      `[...document.querySelectorAll('dialog a')].some(a=>a.textContent.includes('Open artifact'))`,
    )
  )
    throw new Error("Deleted graph node still has a live content link");
  await b.evaluate(`document.querySelector('dialog button[aria-label="Close dialog"]').click()`);
  await click("Claim");
  await b.until(
    `[...document.querySelectorAll('.task-actions button')].some(b=>b.textContent==='Release claim')`,
  );
  await field("Add a comment", "Restart check passed.", ".task-detail");
  await click("Add comment");
  await b.until(
    `document.querySelector('.comments')?.textContent.includes('Restart check passed.')`,
  );
  await click("Add a wait");
  await b.until(`!!document.querySelector('dialog')`);
  await field(
    "Context",
    'Review this decision.\n\n```questions\n[{"question":"Ship this change?","options":["Ship","Request changes"]},{"question":"Follow-up?","options":["None","Later"]}]\n```',
    "dialog",
  );
  await click("Save");
  await b.until(`document.querySelectorAll('.blocker-row input[type="radio"]').length===6`);
  await b.evaluate(`document.querySelectorAll('.blocker-row input[type="radio"]')[1].click()`);
  await b.evaluate(`document.querySelectorAll('.blocker-row input[type="radio"]')[5].click()`);
  await fill(".blocker-row textarea", "Use a smaller patch.");
  await click("Confirm answers");
  await b.until(
    `!!document.querySelector('.blocker-row.answered') && document.querySelector('.comments')?.textContent.includes('Use a smaller patch.')`,
  );
  await b.command("Page.reload");
  await b.until(`!!document.querySelector('.blocker-row.answered')`);
  if (await b.evaluate<boolean>(`!!document.querySelector('.blocker-row input[type="radio"]')`))
    throw new Error("Answered task form became actionable after reload");
  await click("Edit");
  await b.until(`!!document.querySelector('dialog')`);
  await field(
    "Task body",
    "Resume from the checkpoint. Acceptance: retry preserves the batch and checksum.",
    "dialog",
  );
  await b.evaluate(`document.querySelector('dialog details').open=true`);
  await field("Defer until", "2099-01-01T09:00:00Z", "dialog");
  await click("Save changes");
  await b.until(
    `!document.querySelector('dialog') && document.querySelector('.task-body')?.textContent.includes('checksum')`,
  );
  await b.until(
    `[...document.querySelectorAll('.task-actions button')].some(b=>b.textContent==='Release claim')`,
  );
  await click("Release claim");
  await b.until(
    `[...document.querySelectorAll('.task-actions button')].some(b=>b.textContent==='Claim')`,
  );
  await click("Available");
  await b.until(`document.querySelectorAll('.task-row').length===1`);
  await b.evaluate(`document.querySelector('.filter-details').open=true`);
  await field("All labels", "missing", ".filter-grid");
  await b.until(`!document.querySelector('.task-row')`);
  await field("All labels", "backend, review", ".filter-grid");
  await b.until(`document.querySelectorAll('.task-row').length===1`);
  await click("Mark done");
  await b.until(`document.querySelector('.detail-top span')?.textContent==='done'`);
  await click("Reopen");
  await b.until(`!!document.querySelector('dialog')`);
  await field("Context", "Check one more recovery case", "dialog");
  await click("Save");
  await b.until(
    `!document.querySelector('dialog') && document.querySelector('.detail-top span')?.textContent==='open'`,
  );
  await field("Add a comment", "Draft stays with this task.", ".task-detail");
  await click("Git history");
  await b.until(`document.querySelector('h1')?.textContent==='Git history'`);
  await click("Tasks");
  await b.until(
    `document.querySelector('.task-detail textarea')?.value==='Draft stays with this task.'`,
  );
  await click("Close task");
  await click("Add a plan");
  await b.until(`!!document.querySelector('dialog')`);
  await field("Plan title", "Release checks", "dialog");
  await field("Tasks, one per line", "Verify restore\nVerify optional integration", "dialog");
  await click("Create plan");
  await b.until(
    `!document.querySelector('dialog') && document.querySelector('.epic-progress')?.textContent.includes('2 open')`,
  );
  await click("Verify restore");
  await b.until(`document.querySelector('.task-detail h2')?.textContent==='Verify restore'`);
  await click("Mark done");
  await b.until(`document.querySelector('.detail-top span')?.textContent==='done'`);
  await click("Close task");
  await b.evaluate(
    `[...document.querySelectorAll('.task-row')].find(r=>r.textContent.includes('Verify optional integration')).click()`,
  );
  await b.until(
    `document.querySelector('.task-detail h2')?.textContent==='Verify optional integration'`,
  );
  await click("Cancel task");
  await b.until(`!!document.querySelector('dialog')`);
  await field("Context", "Outside this release", "dialog");
  await click("Save");
  await b.until(
    `!document.querySelector('dialog') && document.querySelector('.detail-top span')?.textContent==='cancelled'`,
  );
  await click("Close task");
  await b.evaluate(
    `[...document.querySelectorAll('.task-row')].find(r=>r.textContent.includes('Release checks')).click()`,
  );
  await b.until(
    `document.querySelector('.epic-progress')?.textContent.includes('1 done') && document.querySelector('.epic-progress')?.textContent.includes('1 cancelled')`,
  );
  for (const width of [1440, 1024, 390]) {
    await b.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 760,
    });
    if (await b.evaluate("document.documentElement.scrollWidth>innerWidth"))
      throw new Error(`Horizontal overflow at ${width}`);
  }
  let shot = await b.command("Page.captureScreenshot", { format: "png" });
  await Bun.write(
    join(tmpdir(), "allgather-app-mobile.png"),
    Buffer.from(shot.data as string, "base64"),
  );
  await b.command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await b.evaluate("scrollTo(0,0)");
  shot = await b.command("Page.captureScreenshot", { format: "png" });
  await Bun.write(
    join(tmpdir(), "allgather-app-desktop.png"),
    Buffer.from(shot.data as string, "base64"),
  );
  await click("Git history");
  await b.until(`document.querySelector('h1')?.textContent==='Git history'`);
  await click("Connect upstream");
  await b.until(`!!document.querySelector('dialog')`);
  await field("Name", "Example upstream", "dialog");
  await field("Upstream URL", "https://example.invalid/project.git", "dialog");
  await field("Project path prefixes", "apps/", "dialog");
  await b.evaluate(`document.querySelector('dialog input[type="checkbox"]').click()`);
  await click("Save connection");
  await b.until(
    `!document.querySelector('dialog') && document.querySelector('.repo-row')?.textContent.includes('paused')`,
  );
  await click("Settings");
  await b.until(`!!document.querySelector('dialog')`);
  await field("Initial commits", "100", "dialog");
  await click("Save connection");
  await b.until(`!document.querySelector('dialog')`);
  const connected = running.workspace.history.repositories()[0];
  if (connected.initial_fetch_limit !== 100 || connected.sync_enabled || connected.last_attempt_at)
    throw new Error("Paused repository configuration was not respected");
  await click("Project paths");
  await b.until(`document.querySelector('dialog textarea')?.value==='apps'`);
  await field("Path prefixes", "apps/web/\npackages/ui", "dialog");
  await b.evaluate(`(()=>{
    const original=window.fetch.bind(window), pending=[];
    window.fetch=(input,init)=>String(input).includes('/api/operations/repositories_list')
      ? new Promise((resolve,reject)=>pending.push(()=>original(input,init).then(resolve,reject)))
      : original(input,init);
    window.releaseRepositoryReads=()=>{window.fetch=original;for(const release of pending)release();delete window.releaseRepositoryReads;};
  })()`);
  await click("Save project paths");
  await b.until(`!document.querySelector('dialog')`);
  await click("Project paths");
  await b.evaluate(`window.releaseRepositoryReads()`);
  await b.until(`document.querySelector('dialog textarea')?.value==='apps/web\\npackages/ui'`);
  for (const width of [1440, 390]) {
    await b.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: width < 760,
    });
    if (await b.evaluate("document.documentElement.scrollWidth>innerWidth"))
      throw new Error(`Project paths overflow at ${width}`);
  }
  await field("Path prefixes", "", "dialog");
  await click("Save project paths");
  await b.until(`!document.querySelector('dialog')`);
  const pathSettings = running.workspace.history.repository(connected.id);
  if (
    pathSettings.project_links[0].path_prefixes.length ||
    pathSettings.project_links[0].revision !== 3 ||
    pathSettings.revision !== connected.revision ||
    pathSettings.last_attempt_at
  )
    throw new Error("Project path edits did not stay separate from Git collection settings");
  const createNode = await fixtureTowerEnrollment(
    running.settings.ownerUrl,
    await fixtureLogin(directory, running.settings.ownerUrl),
    ["read"],
    "Synthetic checkout source",
  );
  const NativeSocket = WebSocket as unknown as {
    new (url: string, options: { headers: Record<string, string> }): WebSocket;
  };
  checkoutSocket = new NativeSocket(running.settings.ownerUrl.replace(/^http/, "ws") + "/tower", {
    headers: { authorization: `Bearer ${createNode.access_key}` },
  });
  const checkout = {
    id: "local-web-worktree",
    repository_id: connected.id,
    path: "/work/example-feature",
    system: "git",
    branch: "feature/web",
    head: "a".repeat(40),
    dirty: true,
    conflicts: false,
    locked: true,
    prunable: false,
    available: true,
    tracking_ref: "origin/main",
    ahead: 2,
    behind: 1,
    observed_at: Date.now(),
    revision: 1,
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Checkout browser fixture sync timed out")),
      10000,
    );
    checkoutSocket!.onopen = () =>
      checkoutSocket!.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "hello",
          method: "hello",
          params: {
            protocol_version: { major: 1, minor: 4 },
            tower_version: "browser-fixture",
            host_id: createNode.host_id,
            capabilities: [
              "policy-sync.v1",
              "session-status.v1",
              "repository-catalog.v1",
              "checkout-sync.v1",
            ],
          },
        }),
      );
    checkoutSocket!.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.method === "catalog.push") {
        checkoutSocket!.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: { revision: frame.params.revision },
          }),
        );
        checkoutSocket!.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "checkout.snapshot",
            params: { seq: 0, full: true, records: [checkout] },
          }),
        );
      }
      if (frame.method === "checkout.ack") {
        clearTimeout(timer);
        resolve();
      }
    };
    checkoutSocket!.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Checkout fixture WebSocket failed"));
    };
  });
  await b.until(
    `document.querySelector('.checkout-list')?.textContent.includes('local-web-worktree') && document.querySelector('.checkout-list')?.textContent.includes('Locked')`,
  );
  checkoutSocket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "checkout.delta",
      params: {
        seq: 1,
        base_seq: 0,
        upserts: [
          { ...checkout, path: "/work/moved-feature", revision: 2, dirty: false, locked: false },
        ],
        removed: [],
      },
    }),
  );
  await b.until(
    `document.querySelector('.checkout-list')?.textContent.includes('/work/moved-feature') && !document.querySelector('.checkout-list')?.textContent.includes('/work/example-feature')`,
  );
  checkoutSocket.close();
  await b.until(
    `document.querySelector('.checkout-list')?.textContent.includes('Observation stale')`,
  );
  for (const width of [1440, 1024, 390]) {
    await b.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: width < 760,
    });
    if (await b.evaluate("document.documentElement.scrollWidth>innerWidth"))
      throw new Error(`History overflow at ${width}`);
  }
  shot = await b.command("Page.captureScreenshot", { format: "png" });
  await Bun.write(
    join(tmpdir(), "allgather-history-mobile.png"),
    Buffer.from(shot.data as string, "base64"),
  );
  await b.command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click("Activity");
  await b.until(
    `document.querySelector('h1')?.textContent==='Activity' && document.querySelector('.audit-list')?.textContent.includes('Owner')`,
  );
  await click("Connections");
  await b.until(`document.querySelector('.connections h1')?.textContent==='Agent connections'`);
  const client = (await (
    await fetch(`${running.settings.ownerUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Browser verification",
        redirect_uris: [`${running.settings.ownerUrl}/callback`],
        token_endpoint_auth_method: "none",
      }),
    })
  ).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const authorization = new URL(`${running.settings.ownerUrl}/oauth/authorize`);
  authorization.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: `${running.settings.ownerUrl}/callback`,
    response_type: "code",
    scope:
      "tasks:read tasks:write sessions:read sessions:launch sessions:prompt transcripts:read artifacts:read commits:read",
    resource: `${running.settings.ownerUrl}/mcp`,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  await b.command("Page.navigate", { url: authorization.toString() });
  await b.until(
    `document.querySelector('h1')?.textContent==='Connect an agent' && document.body.textContent.includes('Browser verification')`,
  );
  await field("Agent name", "Approved browser agent");
  const defaults = await b.evaluate(`(() => {
    const selected = text => Array.from(document.querySelectorAll('.permission-choice')).find(e => e.textContent.includes(text))?.querySelector('input')?.checked;
    return selected('Read machines') && selected('Read retained') && selected('Read artifacts') && document.querySelector('[aria-label="Launch a coding agent on a machine"]')?.value==='approval' && document.querySelector('[aria-label="Send work to a running coding agent"]')?.value==='approval';
  })()`);
  if (!defaults) throw new Error("Consent defaults grant unexpected permissions");
  await b.evaluate(`(() => {
    const choices = Array.from(document.querySelectorAll('.permission-choice'));
    if (choices.find(e=>e.textContent.includes('Unassigned —'))?.querySelector('input')?.checked) throw new Error('Unassigned must default off');
    const projects = choices.find(e=>e.textContent.includes('All projects, including new ones'))?.querySelector('input');
    if (!projects || projects.checked) throw new Error('Projects must be chosen explicitly');
    projects.click();
  })()`);
  await b.evaluate(`(() => {
    const group = document.querySelector('[aria-label="Sessions access"]');
    if(group.value!=='approval')throw new Error('Session controls should default to approval');
    group.value='allow';group.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await b.until(
    `document.querySelector('[aria-label="Launch a coding agent on a machine"]').value==='allow'`,
  );
  await b.evaluate(
    `(() => {const group=document.querySelector('[aria-label="Sessions access"]');group.value='deny';group.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await b.until(
    `document.querySelector('[aria-label="Launch a coding agent on a machine"]').value==='deny'`,
  );
  await b.evaluate(`(() => {
    for (const item of document.querySelectorAll('.permission-choice')) {
      if (item.textContent.includes('Read machines') || item.textContent.includes('Create and update tasks')) item.querySelector('input').click();
    }
  })()`);
  await click("Allow access");
  await b.until(
    `location.pathname==='/callback' && new URLSearchParams(location.search).has('code')`,
  );
  const code = (await b.evaluate(`new URLSearchParams(location.search).get('code')`)) as string;
  const tokenResponse = await fetch(`${running.settings.ownerUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: `${running.settings.ownerUrl}/callback`,
      code_verifier: verifier,
      resource: `${running.settings.ownerUrl}/mcp`,
    }),
  });
  const consentToken = (await tokenResponse.json()) as { scope: string; refresh_token?: string };
  if (
    !consentToken.refresh_token ||
    consentToken.scope.includes("sessions:launch") ||
    consentToken.scope.includes("sessions:prompt") ||
    consentToken.scope.includes("tasks:write")
  )
    throw new Error("Consent did not narrow scopes or persist access by default");
  if (
    !tokenResponse.ok ||
    running.workspace.one<{ operator_name: string }>(
      "SELECT operator_name FROM oauth_tokens WHERE revoked=0",
    )?.operator_name !== "Approved browser agent"
  )
    throw new Error("Consent name was not preserved");
  const resources = running.workspace.one<{ resources: string }>(
    "SELECT resources FROM oauth_grants WHERE client_id=?",
    client.client_id,
  );
  if (
    !resources ||
    JSON.stringify(JSON.parse(resources.resources)) !==
      JSON.stringify({ project_ids: "*", machine_ids: [], unassigned: false })
  )
    throw new Error("Consent resource choices were not preserved");
  await b.command("Page.navigate", { url: running.settings.ownerUrl });
  await b.until(`!!document.querySelector('.app-header')`);
  const owner = { id: "owner", kind: "owner", inlet: "browser", scopes: ["admin"] } as const;
  const task = running.workspace.one<{ id: string }>(
    "SELECT id FROM tasks ORDER BY created_at LIMIT 1",
  )!;
  running.workspace.execute(
    "sessions_declare",
    {
      target_session_id: "browser-stored-session",
      label: "Stored browser verification",
      operation_key: "browser-session",
    },
    owner,
  );
  running.workspace.execute(
    "links_add",
    {
      source_id: "browser-stored-session",
      target_id: task.id,
      type: "contributed_to",
      operation_key: "browser-session-link",
    },
    owner,
  );
  running.workspace.execute(
    "session_transcript_import",
    {
      target_session_id: "browser-stored-session",
      source_key: "browser-fixture",
      coverage: "partial",
      events: [
        { key: "message-1", kind: "agent_message", payload: { text: "Hello from stored history" } },
      ],
      operation_key: "browser-session-history",
    },
    owner,
  );
  await click("Sessions");
  await b.until(
    `!![...document.querySelectorAll('.session-list button')].find(b=>b.textContent.includes('Stored browser verification'))`,
  );
  await b.evaluate(
    `[...document.querySelectorAll('.session-list button')].find(b=>b.textContent.includes('Stored browser verification')).click()`,
  );
  await b.until(
    `document.querySelector('.transcript')?.textContent.includes('Hello from stored history')`,
  );
  if (await b.evaluate(`!!document.querySelector('.session-composer')`))
    throw new Error("Historical reading must not enable execution");
  await click("Tasks");
  await click("Sessions");
  await b.until(
    `document.querySelector('.transcript')?.textContent.includes('Hello from stored history')`,
  );
  await b.evaluate(
    `[...document.querySelectorAll('button')].filter(b=>b.textContent==='Transcript storage').at(-1).click()`,
  );
  await b.until(
    `document.querySelector('dialog')?.textContent.includes("Delete this session's captured history")`,
  );
  if (
    await b.evaluate<boolean>(`document.querySelector('[aria-label="Retention days"]').value!==''`)
  )
    throw new Error("Retention must default to forever");
  await b.evaluate(`document.querySelector('dialog section input[type="checkbox"]').click()`);
  await click("Delete captured history");
  await b.until(
    `!document.querySelector('dialog') && document.querySelector('.transcript')?.textContent.includes('Captured content deleted')`,
  );
  if (
    await b.evaluate<boolean>(
      `document.querySelector('.transcript')?.textContent.includes('Hello from stored history')`,
    )
  )
    throw new Error("Deleted transcript remained cached in the open view");
  await b.command("Page.reload");
  await b.until(
    `document.querySelector('.transcript')?.textContent.includes('Captured content deleted')`,
  );
  await click("Sign out");
  await b.until(`!!document.querySelector('input[type="password"]')`);
  console.log(
    "Browser verification passed: task workflow, comments and drafts, labels and filters, plain deferral, atomic plans and epic progress, three screen widths, upstream connection and project path configuration, checkout identity/move/offline observations, connections, OAuth consent and callback, session history and selection persistence, sign out.",
  );
} finally {
  checkoutSocket?.close();
  await browser?.close();
  await running.stop();
  rmSync(directory, { recursive: true, force: true });
}
