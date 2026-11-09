import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import { browserPasskeyLogin, browserSession } from "./browser.ts";
import { fixtureLoginLink } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to Chromium");
const directory = mkdtempSync(join(tmpdir(), "allgather-repo-mapping-"));
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
  await browserPasskeyLogin(b, await fixtureLoginLink(directory));
  await b.until(`!!document.querySelector('.app-header')`);
  const seed = await b.evaluate<{ a: string; b: string; repos: string[] }>(`(async()=>{
    const op=async(name,input)=>{const r=await fetch('/api/operations/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,operation_key:crypto.randomUUID()})});const d=await r.json();if(!r.ok)throw new Error(JSON.stringify(d));return d.result;};
    const a=await op('projects_create',{name:'Project A',slug:'PA'}), b=await op('projects_create',{name:'Project B',slug:'PB'});
    const repos=[];for(let n=1;n<=3;n++) repos.push((await op('repositories_create',{project_id:a.id,name:'Repo '+n,upstream_url:'https://example.invalid/repo-'+n+'.git',sync_enabled:false})).id);
    return {a:a.id,b:b.id,repos};
  })()`);
  await b.command("Page.navigate", { url: running.settings.ownerUrl + "/?view=history&project=" });
  await b.until(`document.querySelectorAll('.repo-row').length===3`);
  const click = async (label: string, scope = "dialog") =>
    b.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`,
    );
  const open = async () => {
    await b.evaluate(
      `[...[...document.querySelectorAll('.repo-row')].find(r=>r.querySelector('strong')?.textContent==='Repo 1').querySelectorAll('button')].find(b=>b.textContent.trim()==='Manage projects').click()`,
    );
    await b.until(`!!document.querySelector('dialog select')`);
  };
  const field = async (selector: string, value: string) =>
    b.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`,
    );
  const save = async (label: string) => {
    await click(label);
    await b.until(`!document.querySelector('dialog')`);
  };
  const unlink = async () => {
    const clicked = click("Unlink project");
    await Bun.sleep(100);
    await b.command("Page.handleJavaScriptDialog", { accept: true });
    await clicked;
    await b.until(`!document.querySelector('dialog')`);
  };
  const repo = () => running.workspace.history.repository(seed.repos[0]);
  const original = repo();
  await open();
  await field("dialog select", seed.b);
  await field("dialog textarea", "packages/shared/");
  await save("Link project");
  await b.until(`document.querySelector('.repo-projects')?.textContent.includes('Project B')`);
  if (
    repo().project_links.length !== 2 ||
    repo()
      .project_links.find((p) => p.project_id === seed.b)
      ?.path_prefixes.join() !== "packages/shared"
  )
    throw new Error("Sharing existing repository failed");
  await open();
  await field("dialog select", seed.b);
  await b.until(`document.querySelector('dialog textarea')?.value==='packages/shared'`);
  await field("dialog textarea", "apps/shared/");
  await save("Save project paths");
  if (
    repo()
      .project_links.find((p) => p.project_id === seed.b)
      ?.path_prefixes.join() !== "apps/shared"
  )
    throw new Error("Path update failed");
  await open();
  await field("dialog select", seed.b);
  await unlink();
  await open();
  await field("dialog select", seed.a);
  await unlink();
  await b.until(
    `[...document.querySelectorAll('.repo-row')].find(r=>r.querySelector('strong')?.textContent==='Repo 1').textContent.includes('No projects linked')`,
  );
  await open();
  await field("dialog select", seed.b);
  await field("dialog textarea", "");
  await b.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  if (await b.evaluate(`document.documentElement.scrollWidth>innerWidth+1`))
    throw new Error("Mapping editor overflows mobile viewport");
  await save("Link project");
  await b.command("Page.reload");
  await b.until(`document.querySelectorAll('.repo-row').length===3`);
  await open();
  await field("dialog select", seed.b);
  await b.until(`document.querySelector('dialog')?.textContent.includes('This project is linked')`);
  const final = repo();
  if (
    final.project_ids.join() !== seed.b ||
    final.revision !== original.revision ||
    final.last_attempt_at ||
    running.workspace.history.repositories().length !== 3
  )
    throw new Error("Mapping edits changed repository identity or collection settings");
  if (
    !seed.repos
      .slice(1)
      .every((id) => running.workspace.history.repository(id).project_ids.join() === seed.a)
  )
    throw new Error("Mapping edits changed another repository");
  console.log(
    "Repository mapping browser passed: three existing repositories, many-to-many link, path edit, unlink, orphan relink, persistence, mobile layout; no repository duplication or Git fetch",
  );
} finally {
  await browser?.close();
  await running.stop();
  rmSync(directory, { recursive: true, force: true });
}
