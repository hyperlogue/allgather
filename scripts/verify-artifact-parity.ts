import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import { browserPasskeyLogin, browserSession } from "./browser.ts";
import { fixtureLoginLink } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER");
const root = mkdtempSync(join(tmpdir(), "allgather-parity-browser-"));
const running = await startServer({
  dataDir: join(root, "state"),
  port: 0,
  ownerUrl: "http://localhost:0",
  gitSyncSeconds: 0,
});
const owner = { id: "owner", kind: "owner", inlet: "browser", scopes: ["admin"] } as const;
const body = `<!doctype html><html><body><h1 id="title">Storage review</h1><section><p id="paragraph">Select this review evidence.</p></section><button id="export">Export</button><iframe sandbox="allow-scripts allow-downloads" srcdoc="&lt;script&gt;window.childInitial=localStorage.getItem('value');window.childReady=true&lt;/script&gt;"></iframe><script>window.initialValue=localStorage.getItem('value');window.privateValue=localStorage.getItem('application-secret');window.storageReady=true;document.querySelector('#export').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['exported review'],{type:'text/plain'}));a.download='review.txt';a.click()};</script></body></html>`;
const create = async () => {
  const artifact = (await running.workspace.dispatch(
    "artifacts_create",
    { kind: "html", title: "Storage review", operation_key: crypto.randomUUID() },
    owner,
  )) as { id: string };
  await running.workspace.dispatch(
    "artifacts_publish",
    {
      artifact_id: artifact.id,
      expected_seq: 0,
      content: {
        kind: "html",
        files: [
          {
            path: "index.html",
            mediaType: "text/html",
            base64: Buffer.from(body).toString("base64"),
          },
        ],
      },
      operation_key: crypto.randomUUID(),
    },
    owner,
  );
  return artifact.id;
};
let browser: Awaited<ReturnType<typeof browserSession>> | undefined;
try {
  const first = await create(),
    second = await create();
  browser = await browserSession(executable, ["--disable-site-isolation-trials"]);
  const b = browser;
  await b.command("Page.navigate", { url: running.settings.ownerUrl });
  await browserPasskeyLogin(b, await fixtureLoginLink(join(root, "state")));
  await b.evaluate("localStorage.setItem('application-secret','private')");
  const content = async (marker = "storageReady") => {
    for (let attempt = 0; attempt < 100; attempt++) {
      for (const context of b.contexts.values()) {
        if (!context.auxData?.isDefault) continue;
        try {
          if (await b.evaluate(`window.${marker}===true`, context.id)) return context.id;
        } catch {}
      }
      await Bun.sleep(100);
    }
    throw new Error("Published storage document did not initialize");
  };
  const open = async (id: string) => {
    await b.command("Page.navigate", {
      url: `${running.settings.ownerUrl}/artifact-workspace/${id}`,
    });
    await b.until(
      `!!document.querySelector('[aria-label="Capture area"]')||!![...document.querySelectorAll('button')].find(b=>b.textContent==='Accept risk and continue')`,
    );
    await b.evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='Accept risk and continue')?.click()`,
    );
    return content();
  };
  let context = await open(first);
  assert.equal(await b.evaluate("window.initialValue", context), null);
  assert.equal(await b.evaluate("window.privateValue", context), null);
  await b.evaluate("localStorage.setItem('value','retained')", context);
  await b.until(`localStorage.getItem('r3-artifact-storage:${first}:value')==='retained'`);
  context = await open(first);
  assert.equal(await b.evaluate("window.initialValue", context), "retained");
  const childContext = await content("childReady");
  assert.equal(await b.evaluate("window.childInitial", childContext), "retained");
  context = await open(second);
  assert.equal(await b.evaluate("window.initialValue", context), null);
  await b.evaluate("localStorage.setItem('value','sibling')", context);
  await b.until(`localStorage.getItem('r3-artifact-storage:${second}:value')==='sibling'`);
  context = await open(first);
  await b.browserCommand("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: root });
  await b.evaluate("document.querySelector('#export').click()", context);
  for (let attempt = 0; attempt < 100 && !existsSync(join(root, "review.txt")); attempt++)
    await Bun.sleep(50);
  assert.equal(readFileSync(join(root, "review.txt"), "utf8"), "exported review");
  await b.evaluate(`document.querySelector('[aria-label="Comment mode"]').click()`);
  await Bun.sleep(100);
  const frame = await b.evaluate<{ x: number; y: number }>(
    `(() => { const r=document.querySelector('iframe').getBoundingClientRect(); return {x:r.x,y:r.y}; })()`,
  );
  const point = await b.evaluate<{ x: number; y: number }>(
    `(() => { const r=document.querySelector('#paragraph').getBoundingClientRect(); return {x:r.x+20,y:r.y+8}; })()`,
    context,
  );
  await b.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    x: frame.x + point.x,
    y: frame.y + point.y,
  });
  await b.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    x: frame.x + point.x,
    y: frame.y + point.y,
  });
  await Bun.sleep(100);
  const tree = JSON.stringify(await b.command("DOM.getDocument", { depth: -1, pierce: true }));
  assert(
    tree.includes("Select parent") && tree.includes("Select child"),
    "Selection controls did not expose parent and child navigation",
  );
  for (const [key, code] of [
    ["ArrowUp", "ArrowUp"],
    ["ArrowDown", "ArrowDown"],
    [" ", "Space"],
  ]) {
    await b.command("Input.dispatchKeyEvent", { type: "keyDown", key, code });
    await b.command("Input.dispatchKeyEvent", { type: "keyUp", key, code });
  }
  await b.until(`!!document.querySelector('textarea[aria-label="Comment"]')`);
  const imagePath = join(root, "image.png");
  writeFileSync(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4YOT2HwAF5gJoREHQgAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const document = await b.command("DOM.getDocument");
  const upload = await b.command("DOM.querySelector", {
    nodeId: (document.root as { nodeId: number }).nodeId,
    selector: 'input[type="file"]',
  });
  await b.command("DOM.setFileInputFiles", { nodeId: upload.nodeId, files: [imagePath] });
  await b.until(`document.querySelector('[aria-label="Edit image"]')?.disabled===false`);
  await b.evaluate(`document.querySelector('[aria-label="Edit image"]').click()`);
  try {
    await b.until(
      `document.querySelector('[aria-label="Pen"]')?.getAttribute('aria-pressed')==='true'`,
    );
  } catch (error) {
    console.log(
      await b.evaluate(
        `({text:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(b=>({label:b.getAttribute('aria-label'),pressed:b.getAttribute('aria-pressed')}))})`,
      ),
    );
    throw error;
  }
  const imageTools = await b.evaluate<string[]>(
    `[...document.querySelector('[aria-label="Image tools"]').querySelectorAll('button')].map(button=>button.getAttribute('aria-label'))`,
  );
  assert.equal(imageTools.at(-1), "Crop");
  const screenshot = await b.command("Page.captureScreenshot", { format: "png" });
  mkdirSync("workspace/r3-integration/browser", { recursive: true });
  writeFileSync(
    "workspace/r3-integration/browser/parity.png",
    Buffer.from(String(screenshot.data), "base64"),
  );
  await running.workspace.dispatch(
    "artifacts_delete",
    { artifact_id: first, operation_key: crypto.randomUUID() },
    owner,
  );
  await b.until(`localStorage.getItem('r3-artifact-storage:${first}:value')===null`);
  assert.equal(
    await b.evaluate(`localStorage.getItem('r3-artifact-storage:${second}:value')`),
    "sibling",
  );
  await b.evaluate(
    `fetch('/api/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(()=>location.assign('/'))`,
  );
  await b.until(`localStorage.getItem('r3-artifact-storage:${second}:value')===null`);
  assert.equal(await b.evaluate("localStorage.getItem('application-secret')"), "private");
  console.log(
    "Artifact parity browser passed: storage before scripts, reload persistence, isolation, native download, parent/child selection, composer and pen-first image editing, deletion, logout and application-state preservation.",
  );
} finally {
  await browser?.close();
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}
