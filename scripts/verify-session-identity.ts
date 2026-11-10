import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import { browserPasskeyLogin, browserSession } from "./browser.ts";
import { fixtureLoginLink } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER to Chromium");
const directory = mkdtempSync(join(tmpdir(), "allgather-identity-ui-"));
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
  await b.until("!!document.querySelector('.app-header')");
  await b.evaluate(`(async()=>{
    const op=async(name,input)=>{const r=await fetch('/api/operations/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,operation_key:crypto.randomUUID()})});const d=await r.json();if(!r.ok)throw new Error(JSON.stringify(d));return d.result;};
    for(const [id,label,text] of [['first','First label','First captured message'],['second','Second label','Second captured message']]) {
      await op('sessions_declare',{target_session_id:id,harness:'claude-code',label});
      await op('session_transcript_import',{target_session_id:id,source_key:'fixture',coverage:'partial',events:[{key:'one',kind:'agent_message',payload:{text}}]});
    }
    await op('sessions_declare',{target_session_id:'first',harness:'claude',source_namespace:'first-import',native_session_id:'same-native'});
    await op('sessions_declare',{target_session_id:'second',harness:'claude-code',source_namespace:'second-import',native_session_id:'same-native'});
  })()`);
  await b.command("Page.navigate", {
    url: `${running.settings.ownerUrl}/?view=sessions&project=&session=second`,
  });
  await b.until(`new URL(location.href).searchParams.get('session')==='first'`);
  await b.until(
    `document.querySelector('.session-identity-warnings')?.textContent.includes('Session identity needs review')`,
  );
  await b.evaluate(
    `document.querySelectorAll('.session-identity-warnings details').forEach(e=>e.open=true)`,
  );
  await b.until(
    `document.querySelector('.transcript')?.textContent.includes('First captured message') && document.querySelector('.transcript')?.textContent.includes('Second captured message')`,
  );
  if (
    !(await b.evaluate(`(()=>{
    const warning=document.querySelector('.session-identity-warnings').textContent;
    return warning.includes('First label') && warning.includes('Second label') && document.querySelectorAll('.session-list .task-row').length===1 && !document.querySelector('.session-composer') && document.querySelector('.session-native-identity').textContent.includes('same-native');
  })()`))
  )
    throw new Error("Merged session warning, metadata, or controls are incorrect");
  await b.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await b.until(`document.documentElement.scrollWidth<=innerWidth`);
  console.log(
    "Session identity browser: alias navigation, one record, conflict values, combined history, no unmanaged controls, mobile layout passed",
  );
} finally {
  await browser?.close();
  await running.stop();
  rmSync(directory, { recursive: true, force: true });
}
