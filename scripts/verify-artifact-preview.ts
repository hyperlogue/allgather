import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";
import { browserPasskeyLogin, browserSession } from "./browser.ts";
import { fixtureLoginLink } from "./fixture-auth.ts";

const executable = process.env.ALLGATHER_TEST_BROWSER;
if (!executable) throw new Error("Set ALLGATHER_TEST_BROWSER");
const root = mkdtempSync(join(tmpdir(), "allgather-preview-browser-"));
const running = await startServer({
  dataDir: join(root, "state"),
  port: 0,
  ownerUrl: "http://localhost:0",
  gitSyncSeconds: 0,
});
const owner = { id: "owner", kind: "owner", inlet: "browser", scopes: ["admin"] } as const;
const dispatch = <T>(name: string, input: Record<string, unknown>) =>
  running.workspace.dispatch(
    name as never,
    { operation_key: crypto.randomUUID(), ...input },
    owner,
  ) as Promise<T>;
const publish = async (kind: "html" | "files", title: string, path: string, body: string) => {
  const artifact = await dispatch<{ id: string }>("artifacts_create", { kind, title });
  await dispatch("artifacts_publish", {
    artifact_id: artifact.id,
    expected_seq: 0,
    content: {
      kind,
      files: [
        {
          path,
          mediaType: path.endsWith(".md") ? "text/markdown" : "text/html",
          base64: Buffer.from(body).toString("base64"),
        },
      ],
    },
  });
  return artifact.id;
};
let browser: Awaited<ReturnType<typeof browserSession>> | undefined;
try {
  const target = await publish("html", "Linked target", "index.html", "<h1>Linked target</h1>");
  const page = `<!doctype html><html><body>
<h1 id="open-heading">Open heading</h1><p id="resolved-paragraph">Resolved paragraph</p>
<a id="external" href="https://example.invalid/leak?d=secret">External</a>
<a id="internal" href="/artifact-workspace/${target}">Internal</a>
<script type="module">import r3 from "/r3/utility.js";window.modes=[];r3.onCommentModeChange((mode)=>window.modes.push(mode));window.r3=r3;window.previewReady=true;</script>
</body></html>`;
  const source = await publish("html", "Preview links", "index.html", page);
  const rendered = (selector: string) => ({
    kind: "rendered",
    versionSeq: 1,
    path: "index.html",
    locator: { selector },
  });
  await dispatch("artifact_threads_add", {
    artifact_id: source,
    input: { body: "Open marker", target: rendered("#open-heading") },
  });
  const resolved = await dispatch<{ id: string }>("artifact_threads_add", {
    artifact_id: source,
    input: { body: "Resolved marker", target: rendered("#resolved-paragraph") },
  });
  await dispatch("artifact_threads_edit", {
    thread_id: resolved.id,
    input: { status: "resolved" },
  });
  const markdown = await publish(
    "files",
    "Markdown drag",
    "index.md",
    `# Published Markdown\n\nA selectable Markdown paragraph.\n\nAnother paragraph for quoting.${"\n\nAdditional text in a long Markdown document with **inline formatting**.".repeat(200)}`,
  );
  browser = await browserSession(executable, ["--disable-site-isolation-trials"]);
  const b = browser;
  await b.command("Page.navigate", { url: running.settings.ownerUrl });
  await browserPasskeyLogin(b, await fixtureLoginLink(join(root, "state")));
  const frameContext = async (expression: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      for (const context of b.contexts.values()) {
        if (!context.auxData?.isDefault) continue;
        try {
          if (await b.evaluate(expression, context.id)) return context.id;
        } catch {}
      }
      await Bun.sleep(100);
    }
    throw new Error(`Preview document did not satisfy ${expression}`);
  };
  const open = async (id: string, ready: string) => {
    await b.command("Page.navigate", {
      url: `${running.settings.ownerUrl}/artifact-workspace/${id}`,
    });
    await b.until(
      `!!document.querySelector('[data-artifact-title]')&&(!!document.querySelector('iframe')||!![...document.querySelectorAll('button')].find(b=>b.textContent==='Accept risk and continue'))`,
    );
    await b.evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='Accept risk and continue')?.click()`,
    );
    return frameContext(ready);
  };
  const markers = async () => {
    const tree = JSON.stringify(await b.command("DOM.getDocument", { depth: -1, pierce: true }));
    const found = [...tree.matchAll(/"attributes":\[([^\]]*"class","marker"[^\]]*)\]/g)];
    return found.map((match) => match[1].includes('"data-resolved"'));
  };
  const until = async (check: () => Promise<boolean>, label: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check()) return;
      await Bun.sleep(100);
    }
    throw new Error(label);
  };
  const frameOrigin = () =>
    b.evaluate<{ x: number; y: number }>(
      `(() => { const r=document.querySelector('iframe').getBoundingClientRect(); return {x:r.x,y:r.y}; })()`,
    );
  const click = async (context: number, selector: string) => {
    const frame = await frameOrigin();
    const point = await b.evaluate<{ x: number; y: number }>(
      `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
      context,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await b.command("Input.dispatchMouseEvent", {
        type,
        button: "left",
        clickCount: 1,
        x: frame.x + point.x,
        y: frame.y + point.y,
      });
  };

  let context = await open(source, "window.previewReady===true");
  await until(
    async () => JSON.stringify(await markers()) === "[false]",
    "Active tab shows only the open marker",
  );
  await b.evaluate(
    `[...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent.startsWith('Resolved')).click()`,
  );
  await until(
    async () => JSON.stringify(await markers()) === "[true]",
    "Resolved tab shows only the resolved marker",
  );
  await b.evaluate(
    `[...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent.startsWith('Active')).click()`,
  );

  const title = await b.evaluate<{ x: number; y: number }>(
    `(() => { const r=document.querySelector('[data-artifact-title]').getBoundingClientRect(); return {x:r.x+4,y:r.y+r.height/2}; })()`,
  );
  await b.command("Input.dispatchMouseEvent", { type: "mouseMoved", x: title.x, y: title.y });
  await b.until(
    `document.querySelector('[data-artifact-title-card]')?.textContent.includes(${JSON.stringify(source)})`,
  );
  await b.command("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 600 });
  await b.until(`!document.querySelector('[data-artifact-title-card]')`);

  assert.deepEqual(
    await b.evaluate(
      "[r3.isCommentMode(),document.documentElement.classList.contains('r3-comment-mode'),window.modes]",
      context,
    ),
    [false, false, []],
  );
  await b.evaluate(`document.querySelector('[aria-label="Comment mode"]').click()`);
  await until(
    async () =>
      JSON.stringify(
        await b.evaluate(
          "[r3.isCommentMode(),document.documentElement.classList.contains('r3-comment-mode'),window.modes]",
          context,
        ),
      ) === JSON.stringify([true, true, [true]]),
    "Comment mode reaches the page utility",
  );
  await b.evaluate(`document.querySelector('[aria-label="Exit comment mode"]').click()`);
  await until(
    async () =>
      JSON.stringify(await b.evaluate("[r3.isCommentMode(),window.modes]", context)) ===
      JSON.stringify([false, [true, false]]),
    "Leaving comment mode reaches the page utility",
  );

  await b.evaluate(
    "window.opened=[];window.open=(...args)=>{window.opened.push(args);return null}",
  );
  await b.evaluate(
    "document.querySelector('#external').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))",
    context,
  );
  await Bun.sleep(300);
  assert.equal(
    await b.evaluate("!!document.querySelector('[data-preview-link-confirm]')"),
    false,
    "script-dispatched clicks cannot open links",
  );
  await click(context, "#external");
  await b.until(
    `document.querySelector('[data-preview-link-href]')?.textContent==='https://example.invalid/leak?d=secret'`,
  );
  const screenshot = await b.command("Page.captureScreenshot", { format: "png" });
  mkdirSync("workspace/r3-integration/browser", { recursive: true });
  writeFileSync(
    "workspace/r3-integration/browser/link-confirm.png",
    Buffer.from(String(screenshot.data), "base64"),
  );
  assert.deepEqual(await b.evaluate("window.opened"), []);
  await b.evaluate(
    `[...document.querySelectorAll('[data-preview-link-confirm] button')].find(b=>b.textContent==='Stay here').click()`,
  );
  await b.until(`!document.querySelector('[data-preview-link-confirm]')`);
  assert.deepEqual(await b.evaluate("window.opened"), []);
  await click(context, "#external");
  await b.until(`!!document.querySelector('[data-preview-link-open]')`);
  await b.evaluate(`document.querySelector('[data-preview-link-open]').click()`);
  assert.deepEqual(await b.evaluate("window.opened"), [
    ["https://example.invalid/leak?d=secret", "_blank", "noopener,noreferrer"],
  ]);
  await click(context, "#internal");
  await b.until(`location.pathname===${JSON.stringify(`/artifact-workspace/${target}`)}`);

  await b.command("Page.navigate", {
    url: `${running.settings.ownerUrl}/?view=artifacts&artifact=${source}`,
  });
  await b.until(`!!document.querySelector('iframe.artifact-frame')`);
  context = await frameContext("window.previewReady===true&&!!document.querySelector('#internal')");
  const outer = await b.evaluate<{ x: number; y: number }>(
    `(() => { const r=document.querySelector('iframe.artifact-frame').getBoundingClientRect(); return {x:r.x,y:r.y}; })()`,
  );
  const inner = await b.evaluate<{ x: number; y: number }>(
    `(() => { const r=document.querySelector('iframe').getBoundingClientRect(); return {x:r.x,y:r.y}; })()`,
    await frameContext("!!document.querySelector('[data-artifact-title]')"),
  );
  const link = await b.evaluate<{ x: number; y: number }>(
    `(() => { const r=document.querySelector('#internal').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    context,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await b.command("Input.dispatchMouseEvent", {
      type,
      button: "left",
      clickCount: 1,
      x: outer.x + inner.x + link.x,
      y: outer.y + inner.y + link.y,
    });
  await b.until(
    `new URLSearchParams(location.search).get('artifact')===${JSON.stringify(target)}&&document.querySelector('iframe.artifact-frame').getAttribute('src').endsWith(${JSON.stringify(target)})`,
  );

  context = await open(
    markdown,
    "document.querySelector('h1')?.textContent==='Published Markdown'",
  );
  for (const acrossParagraphs of [false, true]) {
    await b.evaluate("getSelection().removeAllRanges()", context);
    const frame = await frameOrigin();
    const points = await b.evaluate<{ start: number; end: number; y: number; endY: number }>(
      `(() => {
        const text = document.querySelector('p').firstChild;
        const range = document.createRange();
        range.setStart(text, 0); range.setEnd(text, 1);
        const first = range.getBoundingClientRect();
        const end = ${acrossParagraphs} ? document.querySelectorAll('p')[1].firstChild : text;
        const offset = ${acrossParagraphs} ? 7 : 12;
        range.setStart(end, offset); range.setEnd(end, offset + 1);
        const last = range.getBoundingClientRect();
        return { start: first.left, end: last.left, y: (first.top + first.bottom) / 2, endY: (last.top + last.bottom) / 2 };
      })()`,
      context,
    );
    await b.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      x: frame.x + points.start,
      y: frame.y + points.y,
    });
    for (let step = 1; step <= 12; step++)
      await b.command("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        button: "left",
        buttons: 1,
        x: frame.x + points.start + ((points.end - points.start) * step) / 12,
        y: frame.y + points.y + ((points.endY - points.y) * step) / 12,
      });
    const expected = acrossParagraphs
      ? "A selectable Markdown paragraph.\n\nAnother"
      : "A selectable";
    const composer =
      "document.querySelector('[data-artifact-composer]:not([data-comment-to]) textarea')";
    assert.equal(await b.evaluate(`!!${composer}`), false, "dragging must not open a composer");
    assert.equal(await b.evaluate("getSelection().toString()", context), expected);
    await b.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      x: frame.x + points.end,
      y: frame.y + points.endY,
    });
    await b.until(`!!${composer}`);
    assert.equal(await b.evaluate("getSelection().toString()", context), expected);
    await b.evaluate(
      `document.querySelector('[data-artifact-composer] button[aria-label="Cancel"],[data-artifact-composer] button[aria-label="Discard"]').click()`,
    );
    await b.until(`!${composer}`);
  }

  await open(source, "window.previewReady===true");
  await b.evaluate(`document.querySelector('[aria-label="Comment mode"]').click()`);
  context = await frameContext("window.previewReady===true");
  await click(context, "#open-heading");
  await Bun.sleep(150);
  for (const [key, code] of [[" ", "Space"]]) {
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
  await b.until(
    `!![...document.querySelectorAll('button')].find(b=>b.textContent==='Optimize size')`,
  );
  assert.equal(
    await b.evaluate(
      `!![...document.querySelectorAll('button')].find(b=>b.textContent==='Use image'||b.textContent==='Optimize image')`,
    ),
    false,
  );
  assert.equal(
    await b.evaluate(
      `document.querySelector('[aria-keyshortcuts="Enter"]')?.getAttribute('aria-label')`,
    ),
    "Save",
  );
  await b.evaluate(
    `document.querySelector('[aria-label="Image tools"]').closest('dialog, [role="dialog"]')?.focus()`,
  );
  await b.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
  await b.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  await b.until(`!document.querySelector('[aria-label="Image tools"]')`);
  console.log(
    "Artifact preview browser passed: queue-matched resolved markers, title card, comment mode utility, confirmed external links, in-place artifact links in workspace and library, native Markdown drags, and image editor Save/Optimize toolbar.",
  );
} finally {
  await browser?.close();
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}
