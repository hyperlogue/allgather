import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import { browserPasskeyLogin, browserSession } from "./browser.ts";
import { fixtureLoginLink } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to a Chromium executable");
const directory = mkdtempSync(join(tmpdir(), "allgather-design-"));
const running = await startServer({
  dataDir: directory,
  port: 0,
  ownerUrl: "http://localhost:0",
  gitSyncSeconds: 0,
  gateways: [],
});
let browser: Awaited<ReturnType<typeof browserSession>> | undefined;
try {
  browser = await browserSession(executable);
  const b = browser;
  const size = async (width: number) =>
    b.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: width < 760,
    });
  const shot = async (name: string) => {
    if (await b.evaluate("document.documentElement.scrollWidth>innerWidth+1"))
      throw new Error(`Horizontal overflow: ${name}`);
    const image = await b.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(
      join(tmpdir(), `allgather-design-${name}.png`),
      Buffer.from(image.data as string, "base64"),
    );
  };
  const fill = async (selector: string, text: string) => {
    await b.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`,
    );
    await b.command("Input.insertText", { text });
  };
  const key = async (key: string, code: string, modifiers = 0) => {
    await b.command("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode:
        key === "Escape"
          ? 27
          : key === "Enter"
            ? 13
            : key === "["
              ? 219
              : key === "ArrowDown"
                ? 40
                : key === "ArrowUp"
                  ? 38
                  : 75,
    });
    await b.command("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode:
        key === "Escape"
          ? 27
          : key === "Enter"
            ? 13
            : key === "["
              ? 219
              : key === "ArrowDown"
                ? 40
                : key === "ArrowUp"
                  ? 38
                  : 75,
    });
  };
  const nav = async (label: string) => {
    await b.evaluate(
      `document.querySelector('.app-header nav button[aria-label="${label}"]').click()`,
    );
    await b.until(
      `document.querySelector('.app-header nav button[aria-label="${label}"]').getAttribute('aria-current')==='page'`,
    );
  };
  await size(1440);
  await b.command("Page.navigate", { url: running.settings.ownerUrl });
  await b.until(`!!document.querySelector('.login-enter')`);
  if (!(await b.evaluate("document.documentElement.classList.contains('dark')")))
    throw new Error("Fresh browser did not use Midnight");
  await shot("login");
  await browserPasskeyLogin(b, await fixtureLoginLink(directory));
  await b.until("!!document.querySelector('.app-header')");
  const seed = await b.evaluate<{ project: string; task: string; session: string }>(`(async()=>{
    const op=async(name,input)=>{const r=await fetch('/api/operations/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,operation_key:crypto.randomUUID()})});const d=await r.json();if(!r.ok)throw new Error(JSON.stringify(d));return d.result;};
    const p=await op('projects_create',{name:'Example workspace'});
    const a=await op('tasks_create',{project_id:p.id,title:'Verify the workspace design',body:'Review the responsive shell and the exact request presentation.',labels:['web','design']});
    await op('tasks_create',{project_id:p.id,title:'Retain source evidence',body:'Keep the original artifact linked to the task.',labels:['review']});
    const done=await op('tasks_create',{project_id:p.id,title:'Verify copied login command'});
    await op('tasks_resolve',{task_id:done.id,expected_revision:done.revision});
    await op('sessions_declare',{target_session_id:'design-recorded-session',project_id:p.id,label:'Design verification',harness:'codex'});
    await op('session_transcript_import',{target_session_id:'design-recorded-session',source_key:'design-fixture',coverage:'partial',events:[{key:'message-1',kind:'agent_message',payload:{text:'The workspace shell is ready for review. This is synthetic verification content.'}}]});
    const artifact=await op('artifacts_create',{kind:'html',title:'Workspace review',project_id:p.id});
    await op('artifacts_publish',{artifact_id:artifact.id,expected_seq:0,content:{kind:'html',files:[{path:'index.html',mediaType:'text/html',base64:btoa('<h1>Workspace review</h1><p>Synthetic verification artifact.</p>')}]}});
    return {project:p.id,task:a.id,session:'design-recorded-session'};
  })()`);
  await b.command("Page.navigate", {
    url: `${running.settings.ownerUrl}/?view=tasks&project=${seed.project}&task=${seed.task}`,
  });
  await b.until(
    `document.querySelector('.task-detail h2')?.textContent==='Verify the workspace design'`,
  );
  await shot("tasks");
  await b.evaluate(`document.querySelector('[aria-label="Collapse sidebar"]').click()`);
  await b.until(`document.querySelector('.app-header').getBoundingClientRect().width===48`);
  await shot("rail");
  const beforeReload = await b.evaluate<number>("performance.timeOrigin");
  await b.command("Page.reload");
  await b.until(
    `performance.timeOrigin!==${beforeReload} && !!document.querySelector('[aria-label="Expand sidebar"]')`,
  );
  await b.evaluate("document.activeElement?.blur()");
  await key("[", "BracketLeft");
  await b.until(`!!document.querySelector('[aria-label="Collapse sidebar"]')`);
  await fill(".task-toolbar input", "");
  await key("[", "BracketLeft");
  if (!(await b.evaluate(`!!document.querySelector('[aria-label="Collapse sidebar"]')`)))
    throw new Error("Typing folded the sidebar");
  await fill(".task-toolbar input", "");
  await key("k", "KeyK", 2);
  await b.until(`!!document.querySelector('.command-palette[open]')`);
  await fill(".command-palette input", "Retain");
  await b.until(
    `document.querySelector('#palette-results')?.textContent.includes('Retain source evidence')`,
  );
  await shot("palette");
  await key("Enter", "Enter");
  await b.until(
    `document.querySelector('.task-detail h2')?.textContent==='Retain source evidence'`,
  );
  await key("k", "KeyK", 2);
  await b.until(`!!document.querySelector('.command-palette[open]')`);
  await key("ArrowDown", "ArrowDown");
  await b.until(
    `document.querySelector('.command-palette input')?.getAttribute('aria-activedescendant')==='palette-result-1'`,
  );
  await fill(".command-palette input", "Edit or assign");
  await key("Enter", "Enter");
  await b.until(`document.querySelector('dialog[open] h2')?.textContent==='Edit task'`);
  await fill("dialog input", "Retain source evidence safely");
  await b.evaluate(`document.querySelector('dialog form').requestSubmit()`);
  await b.until(
    `!document.querySelector('dialog') && document.querySelector('.task-detail h2')?.textContent==='Retain source evidence safely'`,
  );
  await key("k", "KeyK", 2);
  await b.until(`!!document.querySelector('.command-palette[open]')`);
  await fill(".command-palette input", "New task");
  await key("Enter", "Enter");
  await b.until(`document.querySelector('dialog[open] h2')?.textContent==='New task'`);
  await key("Escape", "Escape");
  await b.until("!document.querySelector('dialog[open]')");
  await nav("Sessions");
  await b.until(
    `document.querySelector('.session-list')?.textContent.includes('Design verification')`,
  );
  await b.evaluate(
    `[...document.querySelectorAll('.session-list .task-row')].find(e=>e.textContent.includes('Design verification')).click()`,
  );
  await b.until(
    `document.querySelector('.transcript')?.textContent.includes('synthetic verification content')`,
  );
  await b.until(
    `document.querySelector('.session-insights')?.textContent.includes('Not available yet')`,
  );
  await shot("sessions");
  for (const label of [
    "Artifacts",
    "Git history",
    "Activity",
    "Approvals",
    "Connections",
    "Settings",
  ]) {
    await nav(label);
    await b.until(`!!document.querySelector('h1')`);
    await shot(label.toLowerCase().replaceAll(" ", "-"));
  }
  await b.evaluate(`document.querySelector('input[name=theme][value=light]').click()`);
  await b.until(`!document.documentElement.classList.contains('dark')`);
  await shot("settings-light");
  await nav("Tasks");
  await shot("tasks-light");
  await nav("Settings");
  await b.until(`!!document.querySelector('input[name=theme][value=dark]')`);
  await b.evaluate(`document.querySelector('input[name=theme][value=dark]').click()`);
  await size(375);
  for (const label of [
    "Tasks",
    "Sessions",
    "Artifacts",
    "Git history",
    "Activity",
    "Approvals",
    "Connections",
    "Settings",
  ]) {
    await nav(label);
    await shot(`mobile-${label.toLowerCase().replaceAll(" ", "-")}`);
  }
  await b.evaluate(`document.querySelector('[aria-label="Expand sidebar"]').click()`);
  await shot("mobile-navigation");
  await b.evaluate(`document.querySelector('[aria-label="Close sidebar"]').click()`);
  await key("k", "KeyK", 2);
  await b.until(`!!document.querySelector('.command-palette[open]')`);
  await shot("mobile-palette");
  await key("Escape", "Escape");
  console.log(
    "Design browser passed: Midnight/light, sidebar rail and persistence, scoped search, keyboard selection, task creation, recorded session placeholders, eight views and mobile layouts.",
  );
} catch (error) {
  if (browser)
    console.error(
      await browser
        .evaluate(
          "({url:location.href,title:document.querySelector('h1')?.textContent,dialogs:[...document.querySelectorAll('dialog h2')].map(e=>e.textContent)})",
        )
        .catch(() => null),
    );
  throw error;
} finally {
  await browser?.close();
  await running.stop();
  rmSync(directory, { recursive: true, force: true });
}
