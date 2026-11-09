import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import { browserPasskeyLogin, browserSession } from "./browser.ts";
import { fixtureLoginLink } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to Chromium");
const directory = mkdtempSync(join(tmpdir(), "allgather-client-access-"));
const running = await startServer({
  dataDir: directory,
  port: 0,
  ownerUrl: "http://localhost:0",
  gitSyncSeconds: 0,
});
let browser: Awaited<ReturnType<typeof browserSession>> | undefined;
try {
  browser = await browserSession(executable);
  const b = browser;
  await b.command("Page.navigate", { url: running.settings.ownerUrl });
  await browserPasskeyLogin(b, await fixtureLoginLink(directory));
  await b.until(`!!document.querySelector('.app-header')`);
  const fixture = await b.evaluate<{
    token: string;
    client: string;
    project: string;
    task: string;
  }>(`(async()=>{
    const post=async(path,body,headers={})=>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(JSON.stringify(d));return d;};
    const project=await post('/api/operations/projects_create',{name:'Allowed project',operation_key:crypto.randomUUID()});
    await post('/api/operations/machines_create',{name:'Fixture machine',operation_key:crypto.randomUUID()});
    const p=await post('/api/cli/pairings',{name:'Client access fixture',scopes:['tasks:read','tasks:write','projects:read','sessions:launch'],permission_modes:{},resource_grants:{project_ids:'*',machine_ids:'*',unassigned:true}});
    const bytes=crypto.getRandomValues(new Uint8Array(32));const request_id=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const t=await post('/api/cli/pairings/claim',{pairing_code:p.pairing_code,request_id});
    await post('/api/cli/pairings/'+p.pairing_id+'/confirm',{}, {authorization:'Bearer '+t.access_token});
    const task=await post('/api/operations/tasks_create',{project_id:project.result.id,title:'Retained client task',operation_key:crypto.randomUUID()},{authorization:'Bearer '+t.access_token});
    await post('/api/operations/task_comments_add',{task_id:task.result.id,body:'Retained client comment',operator_kind:'agent',operator_name:'Reported author',agent_type:'codex',session_id:'codex:client-history',operation_key:crypto.randomUUID()},{authorization:'Bearer '+t.access_token});
    return {token:t.access_token,client:t.client_id,project:project.result.id,task:task.result.id};
  })()`);
  await b.command("Page.navigate", { url: running.settings.ownerUrl + "/?view=connections" });
  await b.until(`!!document.querySelector('.registered-clients time')`);
  const response = await fetch(running.settings.ownerUrl + "/api/operations/projects_list", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${fixture.token}` },
    body: "{}",
  });
  if (!response.ok) throw new Error("Fixture API use failed");
  await response.arrayBuffer();
  await b.command("Page.reload");
  await b.until(`!!document.querySelector('.registered-clients time')`);
  await b.evaluate(
    `[...document.querySelectorAll('.registered-clients button')].find(b=>b.textContent==='Manage access').click()`,
  );
  await b.until(
    `!!document.querySelector('.client-grant-editor select[aria-label="Tasks access"]')`,
  );
  await b.evaluate(
    `document.querySelectorAll('dialog .permission-category').forEach(e=>e.open=true)`,
  );
  await b.evaluate(`(()=>{
    const select=document.querySelector('dialog select[aria-label="Tasks access"]');select.value='deny';select.dispatchEvent(new Event('change',{bubbles:true}));
    const launch=document.querySelector('dialog select[aria-label="Launch a coding agent on a machine"]');launch.value='approval';launch.dispatchEvent(new Event('change',{bubbles:true}));
    [...document.querySelectorAll('dialog label')].find(l=>l.textContent.includes('All machines, including new ones')).querySelector('input').click();
    [...document.querySelectorAll('dialog label')].find(l=>l.textContent.includes('Unassigned')).querySelector('input').click();
  })()`);
  await b.evaluate(`document.querySelector('.client-grant-editor').requestSubmit()`);
  await b.until(`document.querySelector('dialog [role=status]')?.textContent==='Access saved'`);
  const actual = await b.evaluate<any>(
    `(async()=>{const clients=await (await fetch('/api/clients')).json();return clients.find(c=>c.id===${JSON.stringify(fixture.client)}).grants.find(g=>!g.revoked);})()`,
  );
  if (
    actual.scopes.includes("tasks:read") ||
    actual.scopes.includes("tasks:write") ||
    actual.permission_modes["sessions:launch"] !== "approval" ||
    actual.resource_grants.machine_ids.length !== 0 ||
    actual.resource_grants.unassigned
  )
    throw new Error("Browser edits did not persist exactly");
  await b.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await b.until(`document.documentElement.scrollWidth<=innerWidth+1`);
  await b.evaluate(`document.querySelector('[aria-label="Close dialog"]').click()`);
  await b.until(`!document.querySelector('dialog')`);
  await b.evaluate(
    `[...document.querySelectorAll('.registered-clients button')].find(b=>b.textContent==='Manage access').click()`,
  );
  await b.until(
    `document.querySelector('dialog select[aria-label="Launch a coding agent on a machine"]')?.value==='approval'`,
  );
  await b.evaluate(`document.querySelector('[aria-label="Close dialog"]').click()`);
  await b.until(`!document.querySelector('dialog')`);
  if (
    await b.evaluate(
      `document.querySelector('.registered-clients')?.textContent.includes('Delete connection')`,
    )
  )
    throw new Error("Active connection offered deletion");
  const confirmAction = async (label: string, accept: boolean) => {
    const clicked = b.evaluate(
      `[...document.querySelectorAll('.registered-clients button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`,
    );
    await Bun.sleep(100);
    await b.command("Page.handleJavaScriptDialog", { accept });
    await clicked;
  };
  await confirmAction("Revoke", true);
  await b.until(
    `document.querySelector('.registered-clients')?.textContent.includes('Delete connection')`,
  );
  await confirmAction("Delete connection", false);
  await b.until(
    `document.querySelector('.registered-clients')?.textContent.includes('Client access fixture')`,
  );
  await confirmAction("Delete connection", true);
  await b.until(`!document.querySelector('.registered-clients')`);
  await b.command("Page.reload");
  await b.until(`document.querySelector('.connections')?.textContent.includes('No clients yet')`);
  await b.until(
    `!document.querySelector('.connections').textContent.includes('Client access fixture')`,
  );
  await b.command("Page.navigate", {
    url: running.settings.ownerUrl + `/?view=tasks&project=${fixture.project}&task=${fixture.task}`,
  });
  await b.until(
    `document.querySelector('.comments')?.textContent.includes('Deleted account (previously known as Client access fixture)')`,
  );
  await b.until(
    `document.querySelector('.comments')?.textContent.includes('Retained client comment')`,
  );
  await b.command("Page.navigate", { url: running.settings.ownerUrl + "/?view=activity" });
  await b.until(
    `document.querySelector('.audit-list')?.textContent.includes('Deleted account (previously known as Client access fixture)')`,
  );
  console.log(
    "Client access browser passed: usage timestamp, identity, permissions tree, approval mode, machine/Unassigned grants, save/reopen, mobile layout, revoke-before-delete, deletion confirmation/cancel, absence after reload, and deleted-account attribution on task comments and audit history",
  );
} finally {
  await browser?.close();
  await running.stop();
  rmSync(directory, { recursive: true, force: true });
}
